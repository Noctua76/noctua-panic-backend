Warning: truncated output (original token count: 87484)
Total output lines: 14078

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require("crypto");
const morgan = require('morgan');
const { Vonage } = require('@vonage/server-sdk');
const pool = require("./db");
const bcrypt = require("bcrypt");
const puppeteer = require("puppeteer");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");
const webpush = require("web-push");
const nodemailer = require("nodemailer");
const createRuntimeRouter = require("./runtime/routes");
const createAnonymousInstallRouter =
  require("./runtime/anonymous-install.routes");
const { createSystemStatusService } = require("./system-status");
const { runMigrations } = require("./database/run-migrations");
const { createCorsOptions } = require("./security/cors-policy");
const { createAuthProtection } = require("./security/auth-protection");
const { createAlertDispatcher } = require("./notifications/alert-dispatch");
const { createTestAlertResultReader } = require("./notifications/alert-result-reader");
const {
  attachCorrectionsToRows,
  createPatrolCorrectionsRouter,
} = require("./patrol/corrections");

// ================================
// TIMEZONE HELPERS
// ================================

async function getCompanyTimezone(companyId) {
  const result = await pool.query(
    `
    SELECT timezone
    FROM companies
    WHERE id = $1
    LIMIT 1
    `,
    [companyId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Company ${companyId} not found`);
  }

  return result.rows[0].timezone || "Europe/Athens";
}

async function ensurePatrolOccurrenceIntegrity() {
  const result = await pool.query(`
    WITH duplicate_occurrences AS (
      SELECT COUNT(*)::int AS duplicate_groups
      FROM (
        SELECT 1
        FROM patrol_logs
        WHERE schedule_id IS NOT NULL
          AND scheduled_at IS NOT NULL
        GROUP BY
          schedule_id,
          COALESCE(schedule_type, 'recurring'),
          scheduled_at
        HAVING COUNT(*) > 1
      ) duplicates
    ),
    legacy_outcomes AS (
      SELECT COUNT(*)::int AS legacy_outcome_rows
      FROM patrol_logs
      WHERE was_missed IS TRUE
        OR completion_status = 'missed_completed_late'
    )
    SELECT duplicate_groups, legacy_outcome_rows
    FROM duplicate_occurrences, legacy_outcomes
  `);

  const integrity = result.rows[0] || {
    duplicate_groups: 0,
    legacy_outcome_rows: 0,
  };

  if (integrity.duplicate_groups > 0 || integrity.legacy_outcome_rows > 0) {
    console.warn(
      "[PATROL INTEGRITY] Historical anomalies detected; records were not changed:",
      integrity
    );
  }

  return {
    readOnly: true,
    duplicateGroups: integrity.duplicate_groups,
    legacyOutcomeRows: integrity.legacy_outcome_rows,
  };
}


// ================================
// SHIFT DELAY EMAILS
// ================================

async function getShiftDelayEmailRecipients(companyId) {
  const result = await pool.query(
    `
    SELECT
      id,
      full_name,
      email,
      secondary_email
    FROM users
    WHERE
(
  (company_id = $1 AND role = 'supervisor')
  OR role = 'system_owner'
)
AND status = 'active'
AND access_mode = 'standard'
      AND (
  NULLIF(BTRIM(email), '') IS NOT NULL
  OR NULLIF(BTRIM(secondary_email), '') IS NOT NULL
)
    ORDER BY id ASC
    `,
    [companyId]
  );

  return result.rows;
}

async function sendShiftDelayEmail(event) {
  const recipients = await getShiftDelayEmailRecipients(event.company_id);
  const companyTimezone = await getCompanyTimezone(event.company_id);

  if (recipients.length === 0) {
    throw new Error(
      `No active supervisor email found for company ${event.company_id}`
    );
  }

  const recipientEmails = [
    ...new Set(
      recipients
        .flatMap((recipient) => [
          recipient.email,
          recipient.secondary_email,
        ])
        .map((email) => email?.trim())
        .filter(Boolean)
    ),
  ];

  
  const scheduledStart = event.scheduled_start;
  const alertThreshold = event.alert_threshold;

  const subject = `[Aegis Link] Shift Delay – ${event.site_name}`;

  const text = [
    "AEGIS LINK – SHIFT DELAY ALERT",
    "",
    `Site: ${event.site_name}`,
    `Location: ${event.site_location || "-"}`,
    `Shift: ${event.shift_label}`,
    `Scheduled Start: ${scheduledStart}`,
    `Alert Threshold: ${alertThreshold}`,
    "",
    "No guard login was detected within the permitted delay threshold.",
    "",
    `Operational Event ID: ${event.id}`,
  ].join("\n");

  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;

  if (!postmarkToken) {
    throw new Error("POSTMARK_SERVER_TOKEN is not configured");
  }

  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": postmarkToken,
    },
    body: JSON.stringify({
      From: process.env.SMTP_FROM || "info@eliaskalyvas.gr",
      To: recipientEmails.join(","),
      Subject: subject,
      TextBody: text,
      MessageStream: "outbound",
    }),
  });

  const result = await response.json();

  if (!response.ok || result.ErrorCode !== 0) {
    throw new Error(
      `Postmark API error ${result.ErrorCode ?? response.status}: ${
        result.Message || "Unknown Postmark error"
      }`
    );
  }

  return {
    recipients: recipientEmails,
    messageId: result.MessageID || null,
  };
}

async function processPendingShiftDelayEmails() {
  const pendingResult = await pool.query(`
    SELECT
      oe.id,
      oe.site_id,
      oe.scheduled_shift_id,
      oe.email_status,

      ss.shift_label,
to_char(ss.scheduled_start, 'DD/MM/YY, HH24:MI') AS scheduled_start,
to_char(
    ss.scheduled_start + INTERVAL '15 minutes',
    'DD/MM/YY, HH24:MI'
) AS alert_threshold,

      s.company_id,
      s.name AS site_name,
      s.location AS site_location

    FROM operational_events oe

    JOIN scheduled_shifts ss
      ON ss.id = oe.scheduled_shift_id

    JOIN sites s
      ON s.id = oe.site_id

    WHERE oe.event_type = 'SHIFT_DELAY'
      AND oe.event_status = 'open'
      AND oe.email_status = 'pending'

    ORDER BY oe.detected_at ASC
  `);

  for (const event of pendingResult.rows) {
    const claimResult = await pool.query(
      `
      UPDATE operational_events
      SET
        email_status = 'processing',
        updated_at = (NOW() AT TIME ZONE 'Europe/Athens')
      WHERE id = $1
        AND email_status = 'pending'
      RETURNING id
      `,
      [event.id]
    );

    if (claimResult.rows.length === 0) {
      continue;
    }

    try {
      console.log("SHIFT DELAY EVENT:");
console.dir(event, { depth: null });

const emailResult = await sendShiftDelayEmail(event);

      await pool.query(
        `
        UPDATE operational_events
        SET
          email_status = 'sent',
          email_recipient = $1,
          email_sent_at = (NOW() AT TIME ZONE 'Europe/Athens'),
          email_error = NULL,
          updated_at = NOW()
        WHERE id = $2
        `,
        [emailResult.recipients.join(", "), event.id]
      );

      console.log(
        `[SHIFT DELAY EMAIL] Event ${event.id} sent to`,
        emailResult.recipients
      );
    } catch (err) {
      await pool.query(
        `
        UPDATE operational_events
        SET
          email_status = 'failed',
          email_error = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [err.message, event.id]
      );

      console.error(
        `[SHIFT DELAY EMAIL ERROR] Event ${event.id}:`,
        err.message
      );
    }
  }
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const VONAGE_PRIVATE_KEY = (process.env.VONAGE_PRIVATE_KEY || '').includes('\\n')
  ? process.env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : process.env.VONAGE_PRIVATE_KEY;

const vonageVoice = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: VONAGE_PRIVATE_KEY
});

const alertDispatcher = createAlertDispatcher({
  pool,
  env: process.env,
  fetchImpl: fetch,
  voiceClient: vonageVoice,
});


const app = express();
app.set("trust proxy", 1);
const authProtection = createAuthProtection({ pool });
const systemStatusService = createSystemStatusService({
  pool,
  env: process.env,
  fetchImpl: fetch,
  crypto,
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: WebSocket,
    },
  }
);
app.use(cors(createCorsOptions(process.env)));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan('dev'));
app.use(
  "/runtime/install",
  createAnonymousInstallRouter()
);

app.use(
  "/runtime",
  createRuntimeRouter({ requireGuardAuth })
);

// --- OpenAI Assistant connection ---
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Λειτουργία: Στέλνει το alert log στον Assistant για καταγραφή
async function processIncidentLog(message) {
  try {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: message
    });

    console.log("Assistant log:", response.output[0].content[0].text);
    return response.output[0].content[0].text;

  } catch (err) {
    console.error("Assistant error:", err);
    return "Assistant failed to process log";
  }
}

// ----------------------------------------------------------
// Endpoint: δέχεται incident logs από το webapp
// ----------------------------------------------------------
app.post('/incident-log', requireGuardAuth, async (req, res) => {
  try {
    const {
  timestamp,
  message,
  incidentAnswers
} = req.body;

const {
  guard_id: guardId,
  session_id: sessionId,
  site_id: siteId
} = req.guard;

    if (!message) {
      return res
        .status(400)
        .json({ error: 'Field "message" is required.' });
    }

    // 1) Ωμό log για το backend / διαχειριστικό
    console.log("RAW INCIDENT LOG:", {
      guardId,
      siteId,
      timestamp,
      message
    });

    if (incidentAnswers && typeof incidentAnswers === "object") {
  await ensureIncidentGuardResponsesTable();

  const incidentResult = await pool.query(
    `
    SELECT id
    FROM incidents
    WHERE guard_ref = $1
      AND site_id = $2
      AND status IN ('active', 'in_progress')
    ORDER BY trigger_time DESC
    LIMIT 1
    `,
    [guardId, siteId]
  );

  const incidentId =
    incidentResult.rows[0]?.id || null;

  const questionLabels = {
    incident_type: "Τι είδους περιστατικό ήταν;",
    location: "Πού ακριβώς εντοπίστηκε;",
    actions_taken: "Ολοκλήρωσες τις απαιτούμενες ενέργειες; Τι έκανες;"
  };

  for (const [questionKey, answer] of Object.entries(incidentAnswers)) {
    await pool.query(
      `
      INSERT INTO incident_guard_responses (
        incident_id,
        guard_id,
        site_id,
        session_id,
        question_key,
        question_text,
        answer,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      `,
      [
  incidentId,
  guardId,
  siteId,
  sessionId,
  questionKey,
  questionLabels[questionKey] || questionKey,
  answer || ""
]
    );
  }
}

    // 2) Περνάμε το log στον Assistant για περίληψη / δομημένη καταγραφή
    const assistantLog = await processIncidentLog(
      `
Guard ID: ${guardId}
Site ID: ${siteId}
Time: ${timestamp || new Date().toISOString()}

Incident description:
${message}
      `.trim()
    );

    // 3) Εδώ αργότερα θα το γράψουμε σε DB ή θα το στείλουμε στο διαχειριστικό
    console.log("ASSISTANT INCIDENT SUMMARY:", assistantLog);

    return res.json({
      status: 'ok',
      assistantLog
    });
  } catch (err) {
    console.error("Incident endpoint error:", err);
    return res
      .status(500)
      .json({ error: 'Server error while processing incident.' });
  }
});

// --------------------------------------------------
// ACTIVE ADMINS
// --------------------------------------------------

app.get("/admin/active", requireAuth, async (req, res) => {
  try {
    const isSystemOwner =
      req.auth.role === "system_owner";

          await closeExpiredTemporaryAdminSessions({
      isSystemOwner,
      companyId: req.auth.company_id,
    });

    const result = await pool.query(
      `
      SELECT DISTINCT ON (ads.username)
        ads.username,
        ads.role,
        ads.login_time,
        ads.last_seen,
        COALESCE(
          u.access_mode,
          'standard'
        ) AS access_mode,
        u.temporary_access_label,
        u.temporary_access_started_at,
        u.access_expires_at,
        (
          COALESCE(
            u.access_mode,
            'standard'
          ) = $3
        ) AS is_temporary
      FROM admin_sessions ads
      INNER JOIN users u
        ON u.id = ads.user_id
      WHERE ads.is_active = true
        AND ads.last_seen >
          NOW() - INTERVAL '90 seconds'
        AND (
          COALESCE(
            u.access_mode,
            'standard'
          ) <> $3
          OR (
            u.status = 'active'
            AND u.temporary_access_revoked_at IS NULL
            AND (
              u.access_expires_at IS NULL
              OR u.access_expires_at > NOW()
            )
          )
        )
        AND (
          $1::boolean = true
          OR ads.company_id = $2
        )
      ORDER BY
        ads.username,
        ads.last_seen DESC
      `,
      [
        isSystemOwner,
        req.auth.company_id,
        ACCESS_MODE_READ_ONLY,
      ]
    );

        const temporaryGuardPreviewResult =
      await pool.query(
        `
        SELECT DISTINCT ON (g.username)
          g.id AS guard_id,
          g.username,
          g.full_name,
          g.role,
          gs.login_time,
          gs.last_heartbeat AS last_seen,
          g.access_mode,
          g.temporary_access_label,
          g.temporary_access_started_at,
          g.access_expires_at,
          s.id AS site_id,
          s.name AS site_name,
          true AS is_temporary,
          'guard_web_app' AS preview_surface
        FROM guard_sessions gs
        INNER JOIN guards g
          ON g.id = gs.guard_id
        INNER JOIN sites s
          ON s.id = gs.site_id
        WHERE gs.logout_time IS NULL
          AND gs.last_heartbeat >
            NOW() - INTERVAL '90 seconds'
          AND g.active = true
          AND g.access_mode = $3
          AND g.temporary_access_revoked_at IS NULL
          AND (
            g.access_expires_at IS NULL
            OR g.access_expires_at > NOW()
          )
          AND (
            $1::boolean = true
            OR s.company_id = $2
          )
        ORDER BY
          g.username,
          gs.last_heartbeat DESC
        `,
        [
          isSystemOwner,
          req.auth.company_id,
          ACCESS_MODE_READ_ONLY,
        ]
      );

    return res.json({
      status: "ok",
      admins: result.rows,
      temporary_guard_previews:
        temporaryGuardPreviewResult.rows,
    });
  } catch (err) {
    console.error("Active admins error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// --------------------------------------------------
// ADMIN HEARTBEAT
// --------------------------------------------------

app.post("/admin/heartbeat", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE admin_sessions
      SET last_seen = NOW()
      WHERE id = $1
        AND user_id = $2
        AND is_active = true
      RETURNING id, last_seen
      `,
      [
        req.auth.session_id,
        req.auth.user_id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Active session not found",
      });
    }

    return res.json({
      status: "ok",
      last_seen: result.rows[0].last_seen,
    });
  } catch (err) {
    console.error("Admin heartbeat error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// --------------------------------------------------
// ADMIN LOGOUT
// --------------------------------------------------

app.post("/admin/logout", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE admin_sessions
SET
  is_active = false,
  logout_time = NOW(),
  session_duration_seconds =
    EXTRACT(EPOCH FROM (NOW() - login_time))::int,
  session_end_reason = 'logout'
      WHERE id = $1
        AND user_id = $2
        AND is_active = true
      RETURNING
        id,
        logout_time,
        session_duration_seconds
      `,
      [req.auth.session_id, req.auth.user_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Active session not found",
      });
    }

    return res.json({
      status: "ok",
      logout_time: result.rows[0].logout_time,
      session_duration_seconds:
        result.rows[0].session_duration_seconds,
    });
  } catch (err) {
    console.error("Admin logout error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// --------------------------------------------------
// ADMIN LOGIN HISTORY
// --------------------------------------------------

app.get(
  "/admin/sessions/history",
  requireAuth,
  async (req, res) => {
    try {
      const { user, from, to, active } = req.query;

      const isSystemOwner =
        req.auth.role === "system_owner";

        await closeExpiredTemporaryAdminSessions({
  isSystemOwner,
  companyId: req.auth.company_id,
});

      let query = `
        SELECT
          ads.id,
          ads.username,
          ads.role,
          ads.login_time,
          ads.last_seen,
          ads.logout_time,
          ads.is_active,
          ads.session_duration_seconds,
          ads.session_end_reason,
          COALESCE(
            u.access_mode,
            'standard'
          ) AS access_mode,
          u.temporary_access_label,
          u.temporary_access_started_at,
          u.access_expires_at,
          u.temporary_access_revoked_at,
          (
            COALESCE(
              u.access_mode,
              'standard'
            ) = $3
          ) AS is_temporary,
          (
            ads.is_active = true
            AND ads.last_seen >
              NOW() - INTERVAL '90 seconds'
            AND (
              COALESCE(
                u.access_mode,
                'standard'
              ) <> $3
              OR (
                u.status = 'active'
                AND u.temporary_access_revoked_at
                  IS NULL
                AND (
                  u.access_expires_at IS NULL
                  OR u.access_expires_at > NOW()
                )
              )
            )
          ) AS is_currently_online
        FROM admin_sessions ads
        LEFT JOIN users u
          ON u.id = ads.user_id
        WHERE (
          $1::boolean = true
          OR ads.company_id = $2
        )
      `;

      const values = [
        isSystemOwner,
        req.auth.company_id,
        ACCESS_MODE_READ_ONLY,
      ];

      if (user) {
        values.push(user);

        query += `
          AND ads.username = $${values.length}
        `;
      }

      if (from) {
        values.push(from);

        query += `
          AND COALESCE(
            ads.logout_time,
            ads.last_seen,
            ads.login_time
          ) >= $${values.length}::date
        `;
      }

      if (to) {
        values.push(to);

        query += `
          AND COALESCE(
            ads.logout_time,
            ads.last_seen,
            ads.login_time
          ) < (
            $${values.length}::date
            + INTERVAL '1 day'
          )
        `;
      }

      if (
        active === "true" ||
        active === "false"
      ) {
        values.push(active === "true");

        query += `
          AND ads.is_active =
            $${values.length}
        `;
      }

      query += `
        ORDER BY ads.login_time DESC
      `;

      const result = await pool.query(
        query,
        values
      );

      return res.json({
        status: "ok",
        sessions: result.rows,
      });
    } catch (err) {
      console.error(
        "Admin session history error:",
        err
      );

      return res.status(500).json({
        status: "error",
        message: err.message,
      });
    }
  }
);


// --------------------------------------------------
// ADMIN LOGIN EXPORT CSV
// --------------------------------------------------

app.get(
  "/admin/sessions/export",
  requireAuth,
  async (req, res) => {
    try {
      const { from, to } = req.query;

      const isSystemOwner =
        req.auth.role === "system_owner";

        await closeExpiredTemporaryAdminSessions({
  isSystemOwner,
  companyId: req.auth.company_id,
});

      const companyTimezone =
        await getCompanyTimezone(
          req.auth.company_id
        );

      let query = `
        SELECT
          ads.username,
          ads.role,
          ads.login_time,
          ads.last_seen,
          ads.logout_time,
          ads.is_active,
          ads.session_duration_seconds,
          ads.session_end_reason,
          COALESCE(
            u.access_mode,
            'standard'
          ) AS access_mode,
          u.temporary_access_label,
          u.temporary_access_started_at,
          u.access_expires_at,
          u.temporary_access_revoked_at,
          (
            COALESCE(
              u.access_mode,
              'standard'
            ) = $3
          ) AS is_temporary,
          (
            ads.is_active = true
            AND ads.last_seen >
              NOW() - INTERVAL '90 seconds'
            AND (
              COALESCE(
                u.access_mode,
                'standard'
              ) <> $3
              OR (
                u.status = 'active'
                AND u.temporary_access_revoked_at
                  IS NULL
                AND (
                  u.access_expires_at IS NULL
                  OR u.access_expires_at > NOW()
                )
              )
            )
          ) AS is_currently_online
        FROM admin_sessions ads
        LEFT JOIN users u
          ON u.id = ads.user_id
        WHERE (
          $1::boolean = true
          OR ads.company_id = $2
        )
      `;

      const values = [
        isSystemOwner,
        req.auth.company_id,
        ACCESS_MODE_READ_ONLY,
      ];

      if (from) {
        values.push(from);

        query += `
          AND COALESCE(
            ads.logout_time,
            ads.last_seen,
            ads.login_time
          ) >= $${values.length}::date
        `;
      }

      if (to) {
        values.push(to);

        query += `
          AND COALESCE(
            ads.logout_time,
            ads.last_seen,
            ads.login_time
          ) < (
            $${values.length}::date
            + INTERVAL '1 day'
          )
        `;
      }

      query += `
        ORDER BY ads.login_time DESC
      `;

      const result = await pool.query(
        query,
        values
      );

      const dateFields = [
        "login_time",
        "last_seen",
        "logout_time",
        "temporary_access_started_at",
        "access_expires_at",
        "temporary_access_revoked_at",
      ];

      result.rows.forEach((row) => {
        dateFields.forEach((field) => {
          row[field] = row[field]
            ? new Date(row[field]).toLocaleString(
                "el-GR",
                {
                  timeZone: companyTimezone,
                }
              )
            : "";
        });
      });

      const escapeCsvValue = (value) => {
        if (
          value === null ||
          value === undefined
        ) {
          return "";
        }

        const text = String(value);

        if (/[;"\r\n]/.test(text)) {
          return `"${text.replace(
            /"/g,
            '""'
          )}"`;
        }

        return text;
      };

      const headers = [
        "username",
        "role",
        "access_mode",
        "is_temporary",
        "temporary_access_label",
        "login_time",
        "last_seen",
        "logout_time",
        "is_active",
        "is_currently_online",
        "session_duration_seconds",
        "session_end_reason",
        "temporary_access_started_at",
        "access_expires_at",
        "temporary_access_revoked_at",
      ];

      const csvRows = result.rows.map(
        (row) =>
          headers
            .map((header) =>
              escapeCsvValue(row[header])
            )
            .join(";")
      );

      const csv =
        `${headers.join(";")}\n` +
        `${csvRows.join("\n")}\n`;

      res.setHeader(
        "Content-Type",
        "text/csv; charset=utf-8"
      );

      res.setHeader(
        "Content-Disposition",
        "attachment; filename=admin_sessions.csv"
      );

      return res.send(csv);
    } catch (err) {
      console.error(
        "Admin session export error:",
        err
      );

      return res.status(500).json({
        status: "error",
        message: err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------
// GreekSMS API route
// ---------------------------------------------------------------------
app.post('/send-sms', requireAuth, async (req, res) => {
  try {
    if (!isSystemOwner(req.auth)) {
      return res.status(403).json({
        status: "error",
        message: "Forbidden",
      });
    }
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message are required' });
    }

    const response = await fetch('https://www.greecesms.gr/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GREEK_SMS_API_KEY}`
      },
      body: JSON.stringify({
        to: phone,
        message: message,
        sender: process.env.GREEK_SMS_SENDER_ID
      })
    });

    const data = await response.json();
    return res.json({ status: 'ok', data });

    console.log("PDF RAW FIRST ROW:");
console.dir(history[0], { depth: null });

console.log("PDF FIRST 10 scheduled_at:");
console.dir(
  history.slice(0, 10).map((r) => r.scheduled_at),
  { depth: null }
);

  } catch (error) {
    console.error('SMS Error:', error);
    return res.status(500).json({ error: 'SMS sending failed' });
  }
});

// --- Health check για το webapp (NO CACHE) ---
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.status(200).json({ status: 'ok' });
});

// ----------------------------------------------------------
// ADMIN USERS MANAGEMENT
// ----------------------------------------------------------

app.get("/admin/users", requireAuth, async (req, res) => {
  try {
    const {
      companyId,
      error,
    } = resolveAdminUsersCompanyScope(req);

    if (error) {
      return res.status(400).json({
        status: "error",
        message: error,
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        full_name,
        username,
        email,
        secondary_email,
        phone,
        mobile_phone,
        backup_phone,
        role,
        status,
        must_change_password,
        company_id,
        created_at
      FROM users
WHERE company_id = $1
  AND access_mode = 'standard'
ORDER BY id ASC
      `,
      [companyId]
    );

    return res.json({
      status: "ok",
      company_id: companyId,
      users: result.rows,
    });
  } catch (err) {
    console.error("Fetch admin users error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.get("/admin/users/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const userId = Number(id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid user id",
      });
    }

    const {
      companyId,
      error,
    } = resolveAdminUsersCompanyScope(req);

    if (error) {
      return res.status(400).json({
        status: "error",
        message: error,
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        full_name,
        username,
        email,
        secondary_email,
        phone,
        mobile_phone,
        backup_phone,
        role,
        status,
        must_change_password,
        company_id,
        created_at
      FROM users
WHERE id = $1
  AND company_id = $2
  AND access_mode = 'standard'
      `,
      [userId, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found",
      });
    }

    return res.json({
      status: "ok",
      company_id: companyId,
      user: result.rows[0],
    });
  } catch (err) {
    console.error("Fetch admin user error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.post("/admin/users", requireAuth, async (req, res) => {
  try {
    const {
      full_name,
      username,
      email,
      secondary_email,
      phone,
      mobile_phone,
      backup_phone,
      role = "supervisor",
      status = "active",
      company_id
    } = req.body;

    const normalizedFullName =
      typeof full_name === "string" ? full_name.trim() : "";

    const normalizedUsername =
      typeof username === "string" ? username.trim() : "";

    if (!normalizedFullName || !normalizedUsername) {
      return res.status(400).json({
        status: "error",
        message: "full_name and username are required"
      });
    }

    const allowedRoles = ["guard", "supervisor", "system_owner"];
    const allowedStatuses = ["active", "inactive"];

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid user role"
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid user status"
      });
    }

    if (
      req.auth.role !== "system_owner" &&
      role === "system_owner"
    ) {
      return res.status(403).json({
        status: "error",
        message: "Only the system owner can create a system owner user"
      });
    }

    let targetCompanyId = req.auth.company_id;

    if (req.auth.role === "system_owner") {
      const requestedCompanyId =
        company_id ?? req.auth.company_id;

      const parsedCompanyId = Number(requestedCompanyId);

      if (
        !Number.isInteger(parsedCompanyId) ||
        parsedCompanyId <= 0
      ) {
        return res.status(400).json({
          status: "error",
          message: "Invalid company_id"
        });
      }

      targetCompanyId = parsedCompanyId;
    }

    const companyResult = await pool.query(
      `
      SELECT
        id,
        name,
        status
      FROM companies
      WHERE id = $1
      `,
      [targetCompanyId]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Company not found"
      });
    }

    const temporaryPassword = crypto
      .randomBytes(9)
      .toString("base64")
      .replace(/[+/=]/g, "")
      .slice(0, 12);

    const passwordHash = await bcrypt.hash(
      temporaryPassword,
      10
    );

    const result = await pool.query(
      `
      INSERT INTO users (
        full_name,
        username,
        email,
        secondary_email,
        phone,
        mobile_phone,
        backup_phone,
        role,
        status,
        company_id,
        password_hash,
        must_change_password,
        created_at
      )
      VALUES (
        $1,
        $2,
        NULLIF($3, ''),
        NULLIF($4, ''),
        NULLIF($5, ''),
        NULLIF($6, ''),
        NULLIF($7, ''),
        $8,
        $9,
        $10,
        $11,
        true,
        NOW()
      )
      RETURNING
        id,
        full_name,
        username,
        email,
        secondary_email,
        phone,
        mobile_phone,
        backup_phone,
        role,
        status,
        must_change_password,
        company_id,
        created_at
      `,
      [
        normalizedFullName,
        normalizedUsername,
        email,
        secondary_email,
        phone,
        mobile_phone,
        backup_phone,
        role,
        status,
        targetCompanyId,
        passwordHash
      ]
    );

    return res.status(201).json({
      status: "ok",
      message: "User created successfully",
      temporary_password: temporaryPassword,
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Create admin user error:", err);

    if (err.code === "23505") {
      return res.status(409).json({
        status: "error",
        message: "Username already exists"
      });
    }

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/admin/users/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const userId = Number(id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid user id"
      });
    }

    const {
      full_name,
      username,
      email,
      secondary_email,
      phone,
      mobile_phone,
      backup_phone,
      role,
      status
    } = req.body;

    const allowedRoles = ["guard", "supervisor", "system_owner"];
    const allowedStatuses = ["active", "inactive"];

    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid user role"
      });
    }

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid user status"
      });
    }

    if (
      req.auth.role !== "system_owner" &&
      role === "system_owner"
    ) {
      return res.status(403).json({
        status: "error",
        message: "Only the system owner can assign the system owner role"
      });
    }

    const {
      companyId,
      error
    } = resolveAdminUsersCompanyScope(req);

    if (error) {
      return res.status(400).json({
        status: "error",
        message: error
      });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET
        full_name = COALESCE(NULLIF($1, ''), full_name),
        username = COALESCE(NULLIF($2, ''), username),
        email = NULLIF($3, ''),
        secondary_email = NULLIF($4, ''),
        phone = NULLIF($5, ''),
        mobile_phone = NULLIF($6, ''),
        backup_phone = NULLIF($7, ''),
        role = COALESCE(NULLIF($8, ''), role),
        status = COALESCE(NULLIF($9, ''), status),
        updated_at = NOW()
      WHERE id = $10
        AND company_id = $11
      RETURNING
        id,
        full_name,
        username,
        email,
        secondary_email,
        phone,
        mobile_phone,
        backup_phone,
        role,
        status,
        must_change_password,
        company_id,
        created_at,
        updated_at
      `,
      [
        full_name,
        username,
        email,
        secondary_email,
        phone,
        mobile_phone,
        backup_phone,
        role,
        status,
        userId,
        companyId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    return res.json({
      status: "ok",
      message: "User updated successfully",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Update admin user error:", err);

    if (err.code === "23505") {
      return res.status(409).json({
        status: "error",
        message: "Username already exists"
      });
    }

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

const ACCESS_MODE_READ_ONLY = "read_only";

const READ_ONLY_SAFE_METHODS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

const READ_ONLY_ADMIN_MUTATION_ALLOWLIST = new Set([
  "/admin/heartbeat",
  "/admin/logout",
]);

const READ_ONLY_GUARD_MUTATION_ALLOWLIST = new Set([
  "/guard/heartbeat",
  "/guard/logout",
  "/runtime",
]);

function getRequestPath(req) {
  return (req.originalUrl || req.url || "").split("?")[0];
}

function isTemporaryAccessExpired(accessExpiresAt) {
  if (!accessExpiresAt) {
    return false;
  }

  return new Date(accessExpiresAt).getTime() <= Date.now();
}

function getTemporaryAccountStatus({
  enabled,
  revokedAt,
  startedAt,
  expiresAt,
  activationDeadline,
  expiryReason,
}) {
  if (expiryReason === "activation_deadline_missed") {
    return "auto_expired";
  }

  if (expiryReason === "manual_revoked" || !enabled || revokedAt) {
    return "revoked";
  }

  if (
    expiryReason === "access_period_completed" ||
    isTemporaryAccessExpired(expiresAt)
  ) {
    return "expired";
  }

  if (
    !startedAt &&
    activationDeadline &&
    isTemporaryAccessExpired(activationDeadline)
  ) {
    return "auto_expired";
  }

  if (startedAt) {
    return "active";
  }

  return "pending";
}

function getTemporaryExpiryMessage(expiryReason) {
  if (expiryReason === "activation_deadline_missed") {
    return "Preview access expired. These credentials were not activated within 14 days.";
  }

  if (expiryReason === "manual_revoked") {
    return "Preview access was revoked by the system owner.";
  }

  return "Preview access expired. The access period has been completed.";
}

function getTemporaryStatusReason(status) {
  switch (status) {
    case "auto_expired":
      return "Never activated within 14 days";
    case "expired":
      return "48-hour access period completed";
    case "revoked":
      return "Manually revoked by system owner";
    case "active":
      return "48-hour access period active";
    default:
      return "Available for first activation within 14 days";
  }
}

async function refreshTemporaryAccessExpirations() {
  for (const tableName of ["users", "guards"]) {
    await pool.query(`
      UPDATE ${tableName}
      SET
        temporary_access_expiry_reason = CASE
          WHEN temporary_access_started_at IS NULL
            AND temporary_access_activation_deadline <= NOW()
          THEN 'activation_deadline_missed'
          ELSE 'access_period_completed'
        END,
        temporary_access_auto_expired_at = COALESCE(
          temporary_access_auto_expired_at,
          CASE
            WHEN temporary_access_started_at IS NULL
            THEN temporary_access_activation_deadline
            ELSE access_expires_at
          END
        )
      WHERE access_mode = 'read_only'
        AND temporary_access_expiry_reason IS NULL
        AND temporary_access_revoked_at IS NULL
        AND (
          (
            temporary_access_started_at IS NULL
            AND temporary_access_activation_deadline IS NOT NULL
            AND temporary_access_activation_deadline <= NOW()
          )
          OR (
            access_expires_at IS NOT NULL
            AND access_expires_at <= NOW()
          )
        )
    `);
  }
}

async function closeExpiredTemporaryAdminSessions({
  isSystemOwner,
  companyId,
}) {
  await pool.query(
    `
    UPDATE admin_sessions AS ads
    SET
      is_active = false,
      logout_time = COALESCE(
        ads.logout_time,
        u.access_expires_at
      ),
      session_duration_seconds = COALESCE(
        ads.session_duration_seconds,
        GREATEST(
          0,
          EXTRACT(
            EPOCH FROM (
              u.access_expires_at
              - ads.login_time
            )
          )::int
        )
      ),
      session_end_reason = COALESCE(
        ads.session_end_reason,
        'temporary_access_expired'
      )
    FROM users u
    WHERE u.id = ads.user_id
      AND ads.is_active = true
      AND u.access_mode = $1
      AND u.access_expires_at IS NOT NULL
      AND u.access_expires_at <= NOW()
      AND (
        $2::boolean = true
        OR ads.company_id = $3
      )
    `,
    [
      ACCESS_MODE_READ_ONLY,
      isSystemOwner,
      companyId,
    ]
  );
}

function blockReadOnlyMutation(
  req,
  res,
  accessMode,
  allowlist
) {
  if (accessMode !== ACCESS_MODE_READ_ONLY) {
    return false;
  }

  if (READ_ONLY_SAFE_METHODS.has(req.method)) {
    return false;
  }

  if (allowlist.has(getRequestPath(req))) {
    return false;
  }

  res.status(403).json({
    status: "error",
    code: "READ_ONLY_ACCESS",
    message: "This temporary account has read-only access",
  });

  return true;
}

function createTemporaryAccessPassword() {
  return `A${crypto.randomBytes(12).toString("base64url")}7!`;
}

function normalizeTemporaryAccessUsername(
  value,
  fallback
) {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : fallback;

  if (!/^[a-z0-9._-]{3,50}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

async function resolveAvailableTemporaryUsername(
  client,
  tableName,
  preferredUsername,
  suffix
) {
  if (!["users", "guards"].includes(tableName)) {
    throw new Error(
      "Unsupported temporary access account type"
    );
  }

  const existing = await client.query(
    `SELECT 1
     FROM ${tableName}
     WHERE username = $1
     LIMIT 1`,
    [preferredUsername]
  );

  if (existing.rows.length === 0) {
    return preferredUsername;
  }

  return `${preferredUsername}.${suffix}`;
}

async function activateTemporaryUserAccess(user) {
  if (
    user.access_mode !== ACCESS_MODE_READ_ONLY ||
    !user.temporary_access_duration_hours
  ) {
    return user;
  }

  await refreshTemporaryAccessExpirations();

  const result = await pool.query(
    `
    UPDATE users
    SET
      temporary_access_started_at = COALESCE(
        temporary_access_started_at,
        NOW()
      ),
      access_expires_at = COALESCE(
        access_expires_at,
        COALESCE(temporary_access_started_at, NOW())
          + temporary_access_duration_hours * INTERVAL '1 hour'
      )
    WHERE id = $1
      AND temporary_access_expiry_reason IS NULL
    RETURNING
      access_mode,
      temporary_access_duration_hours,
      temporary_access_started_at,
      access_expires_at,
      temporary_access_activation_deadline,
      temporary_access_expiry_reason,
      temporary_access_auto_expired_at
    `,
    [user.id]
  );

  if (result.rows.length > 0) {
    return { ...user, ...result.rows[0] };
  }

  const current = await pool.query(
    `SELECT * FROM users WHERE id = $1 LIMIT 1`,
    [user.id]
  );

  return { ...user, ...current.rows[0] };
}

async function activateTemporaryGuardAccess(guard) {
  if (
    guard.access_mode !== ACCESS_MODE_READ_ONLY ||
    !guard.temporary_access_duration_hours
  ) {
    return guard;
  }

  await refreshTemporaryAccessExpirations();

  const result = await pool.query(
    `
    UPDATE guards
    SET
      temporary_access_started_at = COALESCE(
        temporary_access_started_at,
        NOW()
      ),
      access_expires_at = COALESCE(
        access_expires_at,
        COALESCE(temporary_access_started_at, NOW())
          + temporary_access_duration_hours * INTERVAL '1 hour'
      )
    WHERE id = $1
      AND temporary_access_expiry_reason IS NULL
    RETURNING
      access_mode,
      temporary_access_duration_hours,
      temporary_access_started_at,
      access_expires_at,
      temporary_access_activation_deadline,
      temporary_access_expiry_reason,
      temporary_access_auto_expired_at
    `,
    [guard.id]
  );

  if (result.rows.length > 0) {
    return { ...guard, ...result.rows[0] };
  }

  const current = await pool.query(
    `SELECT * FROM guards WHERE id = $1 LIMIT 1`,
    [guard.id]
  );

  return { ...guard, ...current.rows[0] };
}

const INVALID_ACCOUNT_PASSWORD_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function sendAuthenticationThrottle(res, throttle) {
  res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
  return res.status(429).json({
    status: "error",
    code: "AUTH_THROTTLED",
    message: "Too many login attempts. Try again later.",
    retry_after_seconds: throttle.retryAfterSeconds,
  });
}

async function rejectInvalidCredentials(req, res, surface, username, accountId) {
  const throttle = await authProtection.recordFailure(
    req,
    surface,
    username,
    accountId
  );

  if (throttle.throttled) {
    return sendAuthenticationThrottle(res, throttle);
  }

  return res.status(401).json({
    status: "error",
    message: "Invalid username or password.",
  });
}

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        status: "error",
        message: "Username and password are required",
      });
    }

    const existingThrottle = await authProtection.getThrottle(
      req,
      "dashboard",
      username
    );

    if (existingThrottle) {
      return sendAuthenticationThrottle(res, {
        retryAfterSeconds: existingThrottle.retry_after_seconds,
      });
    }

    const userResult = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.email,
        u.role,
        u.status,
        u.company_id,
        u.password_hash,
        u.must_change_password,
u.access_mode,
u.temporary_access_duration_hours,
u.temporary_access_started_at,
u.access_expires_at,
u.temporary_access_activation_deadline,
u.temporary_access_expiry_reason,
u.temporary_access_auto_expired_at,
c.name AS company_name,
        c.status AS company_status,
        c.tenant_type
      FROM users u
      LEFT JOIN companies c
        ON c.id = u.company_id
      WHERE u.username = $1
      `,
      [username]
    );

    if (userResult.rows.length === 0) {
      await bcrypt.compare(password, INVALID_ACCOUNT_PASSWORD_HASH);
      return rejectInvalidCredentials(
        req,
        res,
        "dashboard",
        username,
        null
      );
    }

    let user = userResult.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return rejectInvalidCredentials(
        req,
        res,
        "dashboard",
        username,
        user.id
      );
    }

    await authProtection.recordSuccess(
      req,
      "dashboard",
      username,
      user.id
    );

    if (user.status !== "active") {
      return res.status(403).json({
        status: "error",
        message: "User account is inactive",
      });
    }

    if (!user.company_id) {
      return res.status(403).json({
        status: "error",
        message: "User is not assigned to a company",
      });
    }

    if (!user.company_name) {
      return res.status(403).json({
        status: "error",
        message: "User company was not found",
      });
    }

    if (
      user.role !== "system_owner" &&
      !["pilot", "active"].includes(user.company_status)
    ) {
      return res.status(403).json({
        status: "error",
        message: "Company account is not active",
      });
    }

    user = await activateTemporaryUserAccess(user);

if (
  user.temporary_access_expiry_reason ||
  isTemporaryAccessExpired(user.access_expires_at)
) {
  await pool.query(
    `
    UPDATE admin_sessions AS ads
    SET
      is_active = false,
      logout_time = COALESCE(
        ads.logout_time,
        u.access_expires_at
      ),
      session_duration_seconds = COALESCE(
        ads.session_duration_seconds,
        GREATEST(
          0,
          EXTRACT(
            EPOCH FROM (
              u.access_expires_at
              - ads.login_time
            )
          )::int
        )
      ),
      session_end_reason = COALESCE(
        ads.session_end_reason,
        'temporary_access_expired'
      )
    FROM users u
    WHERE ads.user_id = $1
      AND u.id = ads.user_id
      AND ads.is_active = true
    `,
    [user.id]
  );

  return res.status(403).json({
    status: "error",
    code: "TEMPORARY_ACCESS_EXPIRED",
    expiry_reason:
      user.temporary_access_expiry_reason ||
      "access_period_completed",
    message: getTemporaryExpiryMessage(
      user.temporary_access_expiry_reason
    ),
  });
}

    const sessionToken = crypto.randomBytes(32).toString("hex");

    const sessionResult = await pool.query(
      `
      INSERT INTO admin_sessions (
        user_id,
        username,
        role,
        company_id,
        session_token,
        login_time,
        last_seen,
        is_active
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        NOW(),
        NOW(),
        true
      )
      RETURNING
        id,
        user_id,
        username,
        role,
        company_id,
        session_token,
        login_time,
        last_seen,
        is_active
      `,
      [
        user.id,
        user.username,
        user.role,
        user.company_id,
        sessionToken,
      ]
    );

    const session = sessionResult.rows[0];

    return res.json({
      status: "ok",
      message: "Login successful",

      session: {
        id: session.id,
        token: session.session_token,
        login_time: session.login_time,
      },

      user: {
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        email: user.email,
        role: user.role,
        company_id: user.company_id,
        company_name: user.company_name,
        company_status: user.company_status,
        tenant_type: user.tenant_type,
        access_scope:
          user.role === "system_owner"
            ? "platform"
            : "company",
        must_change_password: user.must_change_password,
        access_mode: user.access_mode,
temporary_access_started_at:
  user.temporary_access_started_at,
access_expires_at: user.access_expires_at,
temporary_access_activation_deadline:
  user.temporary_access_activation_deadline,
temporary_access_expiry_reason:
  user.temporary_access_expiry_reason,
      },
    });
  } catch (err) {
    console.error("Admin login error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

function resolveAdminUsersCompanyScope(req) {
  // Customer users are always restricted to their authenticated company.
  if (req.auth.role !== "system_owner") {
    return {
      companyId: req.auth.company_id,
      error: null,
    };
  }

  // Until the System Owner Control Panel provides a selected company,
  // default to the company stored in the authenticated session.
  const requestedCompanyId = req.query.company_id;

  if (
    requestedCompanyId === undefined ||
    requestedCompanyId === null ||
    requestedCompanyId === ""
  ) {
    return {
      companyId: req.auth.company_id,
      error: null,
    };
  }

  const parsedCompanyId = Number(requestedCompanyId);

  if (
    !Number.isInteger(parsedCompanyId) ||
    parsedCompanyId <= 0
  ) {
    return {
      companyId: null,
      error: "Invalid company_id",
    };
  }

  return {
    companyId: parsedCompanyId,
    error: null,
  };
}

// ----------------------------------------------------------
// AUTHENTICATED SESSION CONTEXT
// ----------------------------------------------------------

async function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    const sessionToken = authorization.slice(7).trim();

    if (!sessionToken) {
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    const result = await pool.query(
      `
      SELECT
        ads.id AS session_id,
        ads.user_id,
        ads.session_token,
        ads.login_time,
        ads.last_seen,
        ads.is_active,

        u.full_name,
        u.username,
        u.email,
        u.role,
        u.status AS user_status,
u.company_id,
u.access_mode,
u.temporary_access_started_at,
u.access_expires_at,
u.temporary_access_expiry_reason,

c.name AS company_name,
        c.status AS company_status,
        c.tenant_type

      FROM admin_sessions ads

      INNER JOIN users u
        ON u.id = ads.user_id

      LEFT JOIN companies c
        ON c.id = u.company_id

      WHERE ads.session_token = $1
        AND ads.is_active = true
      `,
      [sessionToken]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Invalid or inactive session",
      });
    }

    const auth = result.rows[0];

    if (auth.user_status !== "active") {
      return res.status(403).json({
        status: "error",
        message: "User account is inactive",
      });
    }

    if (
      auth.temporary_access_expiry_reason ||
      isTemporaryAccessExpired(auth.access_expires_at)
    ) {
  if (
    !auth.temporary_access_expiry_reason &&
    isTemporaryAccessExpired(auth.access_expires_at)
  ) {
    await pool.query(
      `
      UPDATE users
      SET
        temporary_access_expiry_reason = 'access_period_completed',
        temporary_access_auto_expired_at = COALESCE(
          temporary_access_auto_expired_at,
          access_expires_at
        )
      WHERE id = $1
        AND access_mode = $2
        AND temporary_access_expiry_reason IS NULL
      `,
      [auth.user_id, ACCESS_MODE_READ_ONLY]
    );
  }

  await pool.query(
    `
    UPDATE admin_sessions AS ads
    SET
      is_active = false,
      logout_time = COALESCE(
        ads.logout_time,
        u.access_expires_at
      ),
      session_duration_seconds = COALESCE(
        ads.session_duration_seconds,
        GREATEST(
          0,
          EXTRACT(
            EPOCH FROM (
              u.access_expires_at
              - ads.login_time
            )
          )::int
        )
      ),
      session_end_reason = COALESCE(
        ads.session_end_reason,
        'temporary_access_expired'
      )
    FROM users u
    WHERE ads.id = $1
      AND u.id = ads.user_id
      AND ads.is_active = true
    `,
    [auth.session_id]
  );

  return res.status(403).json({
    status: "error",
    code: "TEMPORARY_ACCESS_EXPIRED",
    expiry_reason:
      auth.temporary_access_expiry_reason ||
      "access_period_completed",
    message: getTemporaryExpiryMessage(
      auth.temporary_access_expiry_reason
    ),
  });
}

    if (!auth.company_id) {
      return res.status(403).json({
        status: "error",
        message: "User is not assigned to a company",
      });
    }

    if (!auth.company_name) {
      return res.status(403).json({
        status: "error",
        message: "User company was not found",
      });
    }

    if (
      auth.role !== "system_owner" &&
      !["pilot", "active"].includes(auth.company_status)
    ) {
      return res.status(403).json({
        status: "error",
        message: "Company account is not active",
      });
    }

    req.auth = {
      session_id: auth.session_id,
      user_id: auth.user_id,
      full_name: auth.full_name,
      username: auth.username,
      email: auth.email,
      role: auth.role,
access_mode: auth.access_mode,
temporary_access_started_at:
  auth.temporary_access_started_at,
access_expires_at: auth.access_expires_at,
temporary_access_expiry_reason:
  auth.temporary_access_expiry_reason,
company_id: auth.company_id,
      company_name: auth.company_name,
      company_status: auth.company_status,
      tenant_type: auth.tenant_type,
      access_scope:
        auth.role === "system_owner"
          ? "platform"
          : "company",
    };

    if (
  blockReadOnlyMutation(
    req,
    res,
    req.auth.access_mode,
    READ_ONLY_ADMIN_MUTATION_ALLOWLIST
  )
) {
  return;
}

    next();
  } catch (err) {
    console.error("Authentication middleware error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
}

async function requireGuardAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized",
      });
    }

    const sessionToken = authHeader.substring(7);

    const result = await pool.query(
  `
  SELECT
    gs.id AS session_id,
    gs.guard_id,
    s.company_id,
    gs.site_id,
    g.full_name,
g.role,
g.access_mode,
g.temporary_access_started_at,
g.access_expires_at,
g.temporary_access_e…57484 tokens truncated…         schedule_type,
            interval_hours,
            start_time,
            reminder_minutes_before,
            active,
            created_at,
            created_by_admin_id,
            created_by_username,
            created_by_role
          )
          VALUES (
            $1,
            $2,
            'recurring',
            $3,
            $4,
            $5,
            true,
            NOW(),
            $6,
            $7,
            $8
          )
          RETURNING *
          `,
          [
            siteId,
            point.id,
            normalizedIntervalHours,
            start_time,
            normalizedReminder,
            req.auth.user_id,
            req.auth.username,
            req.auth.role,
          ]
        );

        inserted.push(result.rows[0]);
      }

      await client.query("COMMIT");

      return res.status(201).json({
        status: "ok",
        message: "Recurring patrol schedule saved for site",
        interval_minutes: intervalMinutes,
        schedule_scope,
        updated_points_count: updatePointsResult.rowCount,
        updated_points: updatePointsResult.rows,
        schedules: inserted,
      });
    } catch (err) {
      await client.query("ROLLBACK");

      console.error("Recurring patrol schedule error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to save recurring patrol schedule",
      });
    } finally {
      client.release();
    }
  }
);

app.get(
  "/settings/sites/:siteId/patrol-schedules",
  requireAuth,
  async (req, res) => {
    try {
      const { siteId } = req.params;

      const isSystemOwner = req.auth.role === "system_owner";

      const siteResult = await pool.query(
        `
        SELECT id
        FROM sites
        WHERE id = $1
          AND ($2::boolean = true OR company_id = $3)
        `,
        [siteId, isSystemOwner, req.auth.company_id]
      );

      if (siteResult.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Site not found",
        });
      }

      const result = await pool.query(
        `
        SELECT
          ps.id,
          ps.site_id,
          ps.patrol_point_id,
          pp.point_name,
          ps.schedule_type,
          ps.interval_hours,
          ps.start_time,
          ps.end_time,
          ps.scheduled_date,
          ps.scheduled_time,
          ps.reminder_minutes_before,
          ps.active,
          ps.created_at,
          ps.created_by_admin_id,
          ps.created_by_username,
          ps.created_by_role,
          ps.manual_status,
          ps.cancelled_at,
          ps.cancelled_by_username,
          ps.cancel_reason
        FROM patrol_schedules ps
        LEFT JOIN patrol_points pp
  ON pp.id = ps.patrol_point_id
 AND pp.site_id = ps.site_id
        WHERE ps.site_id = $1
        ORDER BY
          ps.active DESC,
          ps.created_at DESC,
          ps.id DESC
        `,
        [siteId]
      );

      return res.json({
        status: "ok",
        schedules: result.rows,
      });
    } catch (err) {
      console.error("Get patrol schedules error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to load patrol schedules",
        detail: err.message,
      });
    }
  }
);

app.get("/patrols/sites", requireAuth, async (req, res) => {
  try {
    const isSystemOwner = req.auth.role === "system_owner";

    const result = await pool.query(`
      WITH site_summary AS (
        SELECT
          s.id AS site_id,
          s.name AS site_name,
          s.location AS site_location,
          s.status AS site_status,

          COUNT(DISTINCT pp.id) FILTER (WHERE pp.active = true)::int AS active_points,

          COUNT(DISTINCT pp.id) FILTER (
            WHERE pp.qr_token IS NOT NULL
              AND pp.active = true
          )::int AS generated_qrs,

          MAX(pl.patrol_time) AS last_patrol

        FROM sites s

        LEFT JOIN patrol_points pp
          ON pp.site_id = s.id

                LEFT JOIN patrol_logs pl
          ON pl.site_id = s.id

        GROUP BY
          s.id,
          s.name,
          s.location,
          s.status
      ),

            last_patrol_details AS (
        SELECT DISTINCT ON (pl.site_id)
          pl.site_id,
          pp.point_name AS last_patrol_point,
          g.full_name AS last_patrol_guard,
          pl.accuracy AS last_patrol_accuracy,
pl.latitude AS last_patrol_latitude,
pl.longitude AS last_patrol_longitude
        FROM patrol_logs pl

        LEFT JOIN patrol_points pp
          ON pp.id = pl.point_id

        LEFT JOIN guards g
          ON g.id = pl.guard_id

        ORDER BY pl.site_id, pl.patrol_time DESC
      ),

      recurring_next AS (
  SELECT
    ps.site_id,
    ps.patrol_point_id AS point_id,
    pp.point_name,
    'recurring' AS schedule_type,
    gs.expected_slot AS scheduled_at
  FROM patrol_schedules ps

  LEFT JOIN patrol_points pp
    ON pp.id = ps.patrol_point_id

  CROSS JOIN LATERAL (
  SELECT
    (
      (ps.created_at AT TIME ZONE 'Europe/Athens')::date
      + ps.start_time
    ) AS anchor_time,

    (NOW() AT TIME ZONE 'Europe/Athens')::date AS day_start,

    (
      (NOW() AT TIME ZONE 'Europe/Athens')::date
      + INTERVAL '1 day'
    ) AS day_end
) w

CROSS JOIN LATERAL generate_series(
  w.anchor_time,
  w.anchor_time + INTERVAL '365 days',
  (ps.interval_hours || ' hours')::interval
) AS gs(expected_slot)

  WHERE ps.schedule_type = 'recurring'
    AND ps.active = true
    AND pp.active = true
    AND ps.start_time IS NOT NULL
    AND ps.interval_hours IS NOT NULL
    AND gs.expected_slot >= w.day_start
AND gs.expected_slot < w.day_end
),

      manual_next AS (
        SELECT
          ps.site_id,
          ps.patrol_point_id AS point_id,
          pp.point_name,
          'manual' AS schedule_type,
          (ps.scheduled_date::timestamp + ps.scheduled_time) AS scheduled_at
        FROM patrol_schedules ps

        LEFT JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id

        WHERE ps.schedule_type = 'manual'
  AND ps.active = true
  AND ps.scheduled_date =
      (NOW() AT TIME ZONE 'Europe/Athens')::date
      ),

      upcoming AS (
        SELECT * FROM recurring_next
        WHERE scheduled_at IS NOT NULL

        UNION ALL

        SELECT * FROM manual_next
        WHERE scheduled_at IS NOT NULL
      ),

      site_next AS (
  SELECT DISTINCT ON (site_id)
    site_id,
    point_id AS next_patrol_point_id,
    point_name AS next_patrol_point,
    schedule_type AS next_patrol_type,
    scheduled_at AS next_patrol
  FROM upcoming
  WHERE
  (
    schedule_type = 'manual'
    AND scheduled_at >= (NOW() AT TIME ZONE 'Europe/Athens')
  )
  OR
  (
    schedule_type = 'recurring'
AND scheduled_at >= (NOW() AT TIME ZONE 'Europe/Athens')
  )
  ORDER BY site_id, scheduled_at ASC
),

      upcoming_json AS (
  SELECT
    u.site_id,
    json_agg(
      json_build_object(
        'point_id', u.point_id,
        'point_name', u.point_name,
        'schedule_type', u.schedule_type,
        'scheduled_at',
          CASE
            WHEN u.schedule_type = 'manual'
            THEN to_char(
              u.scheduled_at,
              'YYYY-MM-DD"T"HH24:MI:SS.MS'
            )
            ELSE to_char(
  u.scheduled_at,
  'YYYY-MM-DD"T"HH24:MI:SS.MS'
)
          END,
        'status',
  CASE
  WHEN u.schedule_type = 'manual'
    AND u.scheduled_at + INTERVAL '16 minutes' <= (NOW() AT TIME ZONE 'Europe/Athens')
    THEN 'missed'

  WHEN u.schedule_type = 'manual'
    AND u.scheduled_at < (NOW() AT TIME ZONE 'Europe/Athens')
    THEN 'overdue'

  WHEN u.schedule_type = 'manual'
    AND u.scheduled_at <= (NOW() AT TIME ZONE 'Europe/Athens') + INTERVAL '5 minutes'
    THEN 'due_soon'

  WHEN u.schedule_type = 'recurring'
  AND u.scheduled_at + INTERVAL '16 minutes' <= (NOW() AT TIME ZONE 'Europe/Athens')
  THEN 'missed'

WHEN u.schedule_type = 'recurring'
  AND u.scheduled_at < (NOW() AT TIME ZONE 'Europe/Athens')
  THEN 'overdue'

WHEN u.schedule_type = 'recurring'
  AND u.scheduled_at <= (NOW() AT TIME ZONE 'Europe/Athens') + INTERVAL '5 minutes'
  THEN 'due_soon'

  ELSE 'scheduled'
END,
        'assigned_guard', gs_guard.full_name,
        'guard_session_login', gs.login_time,
        'shift_label', '24/7 Coverage'
      )
      ORDER BY u.scheduled_at ASC
    ) AS upcoming_patrols
  FROM (
    SELECT *
    FROM upcoming
    ORDER BY scheduled_at ASC
  ) u

  LEFT JOIN LATERAL (
    SELECT
      gs.guard_id,
      gs.login_time
    FROM guard_sessions gs
    WHERE gs.site_id = u.site_id
      AND gs.login_time <= u.scheduled_at
      AND (
        gs.logout_time IS NULL
        OR gs.logout_time >= u.scheduled_at
      )
        AND EXISTS (
  SELECT 1
  FROM guards operational_guard
  WHERE operational_guard.id = gs.guard_id
    AND operational_guard.access_mode = 'standard'
)
    ORDER BY gs.login_time DESC
    LIMIT 1
  ) gs ON true

  LEFT JOIN guards gs_guard
    ON gs_guard.id = gs.guard_id

  GROUP BY u.site_id
)

            SELECT
        ss.*,
        lpd.last_patrol_point,
        lpd.last_patrol_guard,
        lpd.last_patrol_accuracy,
        lpd.last_patrol_latitude,
        lpd.last_patrol_longitude,
        CASE
  WHEN sn.next_patrol IS NULL THEN NULL
  ELSE to_char(
    sn.next_patrol,
    'YYYY-MM-DD"T"HH24:MI:SS.MS'
  )
END AS next_patrol,
sn.next_patrol_point_id,
sn.next_patrol_point,
sn.next_patrol_type,

        CASE
  WHEN sn.next_patrol IS NULL THEN 'not_scheduled'
  WHEN sn.next_patrol + INTERVAL '16 minutes' <= (NOW() AT TIME ZONE 'Europe/Athens') THEN 'missed'
WHEN sn.next_patrol < (NOW() AT TIME ZONE 'Europe/Athens') THEN 'overdue'
WHEN sn.next_patrol <= (NOW() AT TIME ZONE 'Europe/Athens') + INTERVAL '5 minutes' THEN 'due_soon'
  ELSE 'scheduled'
END AS patrol_status,

        COALESCE(uj.upcoming_patrols, '[]'::json) AS upcoming_patrols

            FROM site_summary ss

      LEFT JOIN last_patrol_details lpd
        ON lpd.site_id = ss.site_id

      LEFT JOIN site_next sn
        ON sn.site_id = ss.site_id

      LEFT JOIN upcoming_json uj
        ON uj.site_id = ss.site_id

      WHERE
  ss.active_points > 0
  AND ($1::boolean = true OR EXISTS (
    SELECT 1
    FROM sites s
    WHERE s.id = ss.site_id
      AND s.company_id = $2
  ))

            ORDER BY ss.site_id ASC
    `, [isSystemOwner, req.auth.company_id]);

    res.json({
      status: "ok",
      sites: result.rows,
    });
  } catch (err) {
    console.error("Patrol sites load error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load patrol sites",
      detail: err.message,
    });
  }
});

app.get(
  "/patrols/sites/:siteId/details",
  requireAuth,
  async (req, res) => {
  const { siteId } = req.params;
  const isSystemOwner = req.auth.role === "system_owner";

const siteResult = await pool.query(
  `
  SELECT id
  FROM sites
  WHERE id = $1
    AND ($2::boolean = true OR company_id = $3)
  `,
  [siteId, isSystemOwner, req.auth.company_id]
);

if (siteResult.rows.length === 0) {
  return res.status(404).json({
    status: "error",
    message: "Site not found",
  });
}

  try {
    const siteResult = await pool.query(
      `
      SELECT
        id AS site_id,
        name AS site_name,
        location AS site_location,
        status AS site_status
      FROM sites
      WHERE id = $1
      `,
      [siteId]
    );

    const pointsResult = await pool.query(
      `
      SELECT
  id,
  point_name,
  qr_token,
  active,
  created_at
FROM patrol_points
      WHERE site_id = $1
      ORDER BY id ASC
      `,
      [siteId]
    );

    res.json({
      status: "ok",
      site: siteResult.rows[0],
      points: pointsResult.rows,
    });
  } catch (err) {
    console.error("Patrol site details error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load patrol site details",
      detail: err.message,
    });
  }
});

app.get("/patrol-points/:id/qr", requireAuth, async (req, res) => {
  const pointId = Number(req.params.id);
  const isSystemOwner = req.auth.role === "system_owner";

  if (!Number.isInteger(pointId) || pointId <= 0) {
    return res.status(400).json({
      status: "error",
      message: "Invalid patrol point ID",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        pp.id,
        pp.point_name,
        pp.qr_token,
        pp.active
      FROM patrol_points pp
      JOIN sites s
        ON s.id = pp.site_id
      WHERE pp.id = $1
        AND (
          $2::boolean = true
          OR s.company_id = $3
        )
      `,
      [pointId, isSystemOwner, req.auth.company_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Patrol point not found",
      });
    }

    res.json({
      status: "ok",
      point: result.rows[0],
    });
  } catch (err) {
    console.error("Patrol QR load error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load patrol QR",
      detail: err.message,
    });
  }
});

async function reverseGeocode(latitude, longitude) {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
      `&lat=${latitude}` +
      `&lon=${longitude}` +
      `&zoom=19` +
      `&addressdetails=1` +
      `&accept-language=el`;

    const response = await fetch(url, {
  headers: {
    "User-Agent": "AegisLinkSecurityOperations/1.0",
    "Accept": "application/json",
    "Accept-Language": "el-GR,el;q=0.9,en;q=0.8"
  }
});

    if (!response.ok) {
      console.error("Reverse geocoding HTTP error:", response.status);
      return null;
    }

    const data = await response.json();
    console.log("NOMINATIM RAW RESPONSE:", JSON.stringify(data, null, 2));

    const road =
      data.address?.road ||
      data.address?.pedestrian ||
      data.address?.footway ||
      data.address?.path ||
      "";

    const houseNumber = data.address?.house_number || "";

    const area =
      data.address?.suburb ||
      data.address?.neighbourhood ||
      data.address?.quarter ||
      data.address?.village ||
      data.address?.town ||
      data.address?.city ||
      data.address?.municipality ||
      "";

    const streetWithNumber = [road, houseNumber].filter(Boolean).join(" ");
    const shortAddress = [streetWithNumber, area].filter(Boolean).join(", ");

    console.log("NOMINATIM ADDRESS:", data.address);
console.log("SHORT ADDRESS:", shortAddress);    
    if (shortAddress) {
      return shortAddress;
    }

    if (data.display_name) {
      return data.display_name;
    }

    return null;
  } catch (err) {
    console.error("Reverse geocoding failed:", err);
    return null;
  }
}

app.post("/guard/location", requireGuardAuth, async (req, res) => {
  console.log("GPS REQUEST BODY:", req.body);
  try {
    const {
  latitude,
  longitude,
  accuracy,
  speed,
  battery
} = req.body;

const { guard_id, session_id } = req.guard;

    if (!guard_id || !session_id || !latitude || !longitude) {
  return res.status(400).json({
    status: "error",
    message: "guard_id, session_id, latitude and longitude are required"
  });
}

let locationAddress = null;

try {
  locationAddress = await reverseGeocode(latitude, longitude);
} catch (geoErr) {
  console.error("Reverse geocoding skipped:", geoErr);
  locationAddress = null;
}

    await pool.query(
  `
  UPDATE guard_sessions
  SET
    last_latitude = $1,
    last_longitude = $2,
    last_location_accuracy = $3,
    last_speed = $4,
    last_battery_level = $5,
    last_location_address = $6,
    last_location_at = NOW()
  WHERE guard_id = $7
    AND id = $8
    AND logout_time IS NULL
  `,
  [
    latitude,
    longitude,
    accuracy !== null && accuracy !== undefined ? Math.round(Number(accuracy)) : null,
    speed || null,
    battery || null,
    locationAddress || null,
    guard_id,
    session_id
  ]
);

    res.json({
      status: "ok",
      message: "Location updated"
    });
  } catch (err) {
    console.error("Guard location update failed:", err);

    res.status(500).json({
  status: "error",
  message: "Location update failed",
  detail: err.message
});
  }
});

app.get(
  "/guards/live-locations",
  requireAuth,
  async (req, res) => {
  try {
    const isSystemOwner =
  req.auth.role === "system_owner";
    const result = await pool.query(`
      SELECT
    gs.id AS session_id,
    g.id,
    g.full_name,
    g.site_id,
    s.name AS site_name,
    gs.last_latitude,
    gs.last_longitude,
    gs.last_location_accuracy,
    gs.last_location_at,
    gs.last_battery_level,
    gs.last_location_address
  FROM guard_sessions gs
  JOIN guards g
    ON g.id = gs.guard_id
  LEFT JOIN sites s
    ON s.id = g.site_id
  WHERE
  gs.logout_time IS NULL
  AND g.access_mode = 'standard'
  AND (
    $1::boolean = true
    OR s.company_id = $2
  )
  ORDER BY g.full_name ASC
  `,
  [
    isSystemOwner,
    req.auth.company_id,
  ]
);

    res.json({
      status: "ok",
      locations: result.rows
    });
  } catch (err) {
    console.error("Live locations failed:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load live locations"
    });
  }
});

// ----------------------------------------------------------
// START SERVER
// ----------------------------------------------------------
const PORT = process.env.PORT || 5000;

function resolveShiftLabel(site, scheduledAtValue) {
  try {
    const shiftRules = site?.shift_rules;

    if (!shiftRules || !Array.isArray(shiftRules.shifts)) {
      return "Shift rules not configured";
    }

    let currentHour;
let currentMinute;

if (
  typeof scheduledAtValue === "string" &&
  !scheduledAtValue.endsWith("Z")
) {
  const timePart = scheduledAtValue.split("T")[1];
  [currentHour, currentMinute] = timePart
    .split(":")
    .slice(0, 2)
    .map(Number);
} else {
  const scheduledAt = new Date(scheduledAtValue);

  const athensTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(scheduledAt);

  [currentHour, currentMinute] = athensTime.split(":").map(Number);
}
    const currentMinutes = currentHour * 60 + currentMinute;

    const matchedShift = shiftRules.shifts.find((shift) => {
      if (!shift.start || !shift.end) return false;

      const [startHour, startMinute] = shift.start.split(":").map(Number);
      const [endHour, endMinute] = shift.end.split(":").map(Number);

      const startMinutes = startHour * 60 + startMinute;
      const endMinutes = endHour * 60 + endMinute;

      if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
      }

      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    });

    if (!matchedShift) {
      return "Shift not matched";
    }

    return `${matchedShift.start} - ${matchedShift.end}`;
  } catch (err) {
    console.error("Shift resolution error:", err);
    return "Shift resolution failed";
  }
}

app.get("/patrols/missed-history", requireAuth, async (req, res) => {
  try {
    const { site_id, point_id, from, to, type = "all" } = req.query;

    const isSystemOwner = req.auth.role === "system_owner";

    const result = await pool.query(
      `
      WITH recurring_missed AS (
  SELECT
    CONCAT(
      'recurring-missed-',
      ps.id,
      '-',
      EXTRACT(EPOCH FROM gs.expected_slot)
    ) AS id,

    ps.site_id,
    s.name AS site_name,
    s.location AS site_location,

    ps.patrol_point_id AS point_id,
    pp.point_name,

    gs.expected_slot AS scheduled_at,

    'recurring' AS schedule_type,
    'missed' AS status,
    NULL::text AS guard_name

  FROM patrol_schedules ps

  INNER JOIN patrol_points pp
    ON pp.id = ps.patrol_point_id
    AND pp.active = true

  INNER JOIN sites s
    ON s.id = ps.site_id

  INNER JOIN companies c
    ON c.id = s.company_id

  CROSS JOIN LATERAL (
    SELECT
      (
        (
          ps.created_at AT TIME ZONE
            COALESCE(c.timezone, 'Europe/Athens')
        )::date
        + ps.start_time
      ) AS anchor_time
  ) anchor

  CROSS JOIN LATERAL generate_series(
    anchor.anchor_time,
    NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'),
    (ps.interval_hours || ' hours')::interval
  ) AS gs(expected_slot)

  WHERE ps.schedule_type = 'recurring'
    AND ps.active = true
    AND ps.start_time IS NOT NULL
    AND ps.interval_hours IS NOT NULL

    AND gs.expected_slot + INTERVAL '16 minutes' <=
      (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))

    AND NOT EXISTS (
      SELECT 1
      FROM patrol_logs pl
      WHERE pl.schedule_id = ps.id
        AND COALESCE(pl.schedule_type, 'recurring') = 'recurring'
        AND pl.scheduled_at = gs.expected_slot
    )
),
      manual_missed AS (
        SELECT
          CONCAT('manual-missed-', ps.id) AS id,
          ps.site_id,
          s.name AS site_name,
          s.location AS site_location,
          ps.patrol_point_id AS point_id,
          pp.point_name,
          (ps.scheduled_date + ps.scheduled_time) AS scheduled_at,
          'manual' AS schedule_type,
          'missed' AS status,
          g.full_name AS guard_name
        FROM patrol_schedules ps
        LEFT JOIN sites s
          ON s.id = ps.site_id

        LEFT JOIN companies c
          ON c.id = s.company_id
        LEFT JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
        LEFT JOIN guard_sessions gs
          ON gs.site_id = ps.site_id
          AND gs.login_time <= (ps.scheduled_date + ps.scheduled_time)
          AND (
            gs.logout_time IS NULL
            OR gs.logout_time >= (ps.scheduled_date + ps.scheduled_time)
          )
            AND EXISTS (
  SELECT 1
  FROM guards operational_guard
  WHERE operational_guard.id = gs.guard_id
    AND operational_guard.access_mode = 'standard'
)
        LEFT JOIN guards g
          ON g.id = gs.guard_id
        WHERE ps.schedule_type = 'manual'
          AND (
            ps.scheduled_date + ps.scheduled_time + INTERVAL '16 minutes'
          ) <= (
            NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM patrol_logs pl
            WHERE pl.schedule_id = ps.id
              AND COALESCE(pl.schedule_type, 'manual') = 'manual'
          )
      ),
      combined AS (
        SELECT * FROM recurring_missed
        UNION ALL
        SELECT * FROM manual_missed
      )
      SELECT
  combined.*,
  to_char(
    combined.scheduled_at,
    'YYYY-MM-DD"T"HH24:MI:SS.MS'
  ) AS scheduled_at_display
FROM combined
            WHERE ($1::int IS NULL OR site_id = $1::int)
        AND ($2::int IS NULL OR point_id = $2::int)
        AND (
          $6::boolean = true
          OR EXISTS (
            SELECT 1
            FROM sites tenant_site
            WHERE tenant_site.id = combined.site_id
              AND tenant_site.company_id = $7
          )
        )
        AND (
  $3::date IS NULL
  OR (scheduled_at AT TIME ZONE 'Europe/Athens')::date >= $3::date
)
AND (
  $4::date IS NULL
  OR (scheduled_at AT TIME ZONE 'Europe/Athens')::date <= $4::date
)
        AND (
          $5::text = 'all'
          OR schedule_type = $5::text
        )
      ORDER BY combined.scheduled_at DESC
      LIMIT 300
      `,
      [
  site_id ? Number(site_id) : null,
  point_id ? Number(point_id) : null,
  from || null,
  to || null,
  type || "all",
  isSystemOwner,
  req.auth.company_id,
]
    );

    const siteIds = [
  ...new Set(result.rows.map((row) => row.site_id).filter(Boolean)),
];

let sitesById = {};

if (siteIds.length > 0) {
  const sitesResult = await pool.query(
    `
    SELECT
  id,
  coverage_type,
  shift_rules
FROM sites
WHERE id = ANY($1::int[])
  AND (
    $2::boolean = true
    OR company_id = $3
  )
    `,
    [
  siteIds,
  isSystemOwner,
  req.auth.company_id,
]
  );

  sitesById = sitesResult.rows.reduce((acc, site) => {
    acc[site.id] = site;
    return acc;
  }, {});
}

const historyWithCorrections = await attachCorrectionsToRows(
  pool,
  result.rows,
  (row) => row.id,
  () => "MISSED"
);

const historyWithShift = historyWithCorrections.map((row) => {
  const site = sitesById[row.site_id];

  return {
    ...row,
    shift_label: resolveShiftLabel(site, row.scheduled_at_display),
  };
});

console.log("FIRST 10 HISTORY ROWS:");
console.dir(
  historyWithShift.slice(0, 10).map((r) => ({
    scheduled_at: r.scheduled_at,
    scheduled_at_display: r.scheduled_at_display,
    shift_label: r.shift_label,
  })),
  { depth: null }
);

res.json({
  status: "ok",
  history: historyWithShift,
});
  } catch (err) {
    console.error("Missed patrol history load error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load missed patrol history",
      detail: err.message,
    });
  }
});

app.get(
  "/patrols/missed-history/report/pdf",
  requireAuth,
  async (req, res) => {
  let browser;

  try {
    const { site_id, from, to, point_id, type = "all" } = req.query;
    const companyTimezone = await getCompanyTimezone(
  req.auth.company_id
);

    const params = new URLSearchParams();

    if (site_id) params.append("site_id", site_id);
    if (from) params.append("from", from);
    if (to) params.append("to", to);
    if (point_id) params.append("point_id", point_id);
    if (type) params.append("type", type);

    const forwardedProtocol =
  req.get("x-forwarded-proto") || req.protocol;

const historyResponse = await fetch(
  `${forwardedProtocol}://${req.get("host")}/patrols/missed-history?${params.toString()}`,
  {
    headers: {
      Authorization: req.get("authorization"),
    },
  }
);

if (!historyResponse.ok) {
  return res.status(historyResponse.status).json({
    status: "error",
    message: "Failed to load missed patrol history",
  });
}

    const data = await historyResponse.json();

    if (data.status !== "ok") {
      return res.status(404).json({
        status: "error",
        message: "Missed patrol history not found",
      });
    }

    const history = data.history || [];
    console.log(
  "PDF FIRST 10:",
  history.slice(0, 10).map((r) => r.scheduled_at)
);

    const totalMissed = history.length;
    const routineMissed = history.filter(
      (item) => item.schedule_type === "recurring"
    ).length;
    const manualMissed = history.filter(
      (item) => item.schedule_type === "manual"
    ).length;

    const siteName = history[0]?.site_name || "Selected Site";
    const siteLocation = history[0]?.site_location || "-";

    const reportId = `MISSED-PATROL-${site_id || "ALL"}-${Date.now()}`;

    const rowsHtml = history
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(
              formatReportTime(item.scheduled_at_display)
            )}</td>
            <td>${escapeHtml(item.site_name)}</td>
            <td>${escapeHtml(item.point_name)}</td>
            <td>${escapeHtml(
              item.schedule_type === "manual"
                ? "Manual Patrol"
                : "Routine Patrol"
            )}</td>
            <td>
  <strong>Guard:</strong> ${escapeHtml(item.guard_name || "-")}<br/>
  <strong>Shift:</strong> ${escapeHtml(item.shift_label || "-")}
</td>
<td>${escapeHtml(item.status === "missed" ? "Missed" : item.status)}</td>
          </tr>
        `
      )
      .join("");

    const html = `
      <html>
        <head>
          <title>Missed Patrol History Report</title>
          <style>
            @page { margin: 16mm; }

            body {
              font-family: Arial, sans-serif;
              color: #111;
              margin: 0;
              padding: 28px 34px;
              box-sizing: border-box;
            }

            .report-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              border-bottom: 3px solid #111827;
              padding-bottom: 18px;
              margin-bottom: 28px;
            }

            .brand-title h1 {
              margin: 0;
              font-size: 28px;
              letter-spacing: 1px;
            }

            .brand-title p {
              margin: 4px 0 0;
              color: #555;
              font-size: 14px;
            }

            .report-meta {
              text-align: right;
              font-size: 13px;
              color: #444;
            }

            .summary-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 10px 28px;
              margin-bottom: 28px;
            }

            .summary-item {
              border-bottom: 1px solid #eee;
              padding-bottom: 8px;
            }

            .label {
              display: block;
              font-size: 11px;
              text-transform: uppercase;
              color: #666;
              letter-spacing: .6px;
              margin-bottom: 3px;
            }

            .value {
              font-size: 15px;
              font-weight: 600;
            }

            h2 {
              margin-top: 30px;
              border-bottom: 1px solid #ddd;
              padding-bottom: 8px;
              font-size: 18px;
            }

            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 10px;
            }

            th {
              text-align: left;
              background: #111827;
              color: #fff;
              padding: 9px 8px;
              font-size: 12px;
            }

            td {
              border-bottom: 1px solid #eee;
              padding: 9px 8px;
              font-size: 13px;
              vertical-align: top;
            }

            .footer {
              margin-top: 36px;
              padding-top: 14px;
              border-top: 1px solid #ddd;
              font-size: 12px;
              color: #555;
              display: flex;
              justify-content: space-between;
            }
          </style>
        </head>

        <body>
          <div class="report-header">
            <div class="brand-title">
              <h1>AEGIS LINK</h1>
              <p>Security Operations Platform</p>
            </div>

            <div class="report-meta">
              <strong>Missed Patrol History Report</strong><br/>
              Report ID: ${escapeHtml(reportId)}<br/>
              Generated: ${escapeHtml(
                formatReportTime(
  new Date(),
  companyTimezone
)
              )}<br/>
              Generated By: System
            </div>
          </div>

          <div class="summary-grid">
            <div class="summary-item">
              <span class="label">Site</span>
              <span class="value">${escapeHtml(siteName)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Location</span>
              <span class="value">${escapeHtml(siteLocation)}</span>
            </div>

            <div class="summary-item">
              <span class="label">From Date</span>
              <span class="value">${escapeHtml(from || "-")}</span>
            </div>

            <div class="summary-item">
              <span class="label">To Date</span>
              <span class="value">${escapeHtml(to || "-")}</span>
            </div>

            <div class="summary-item">
              <span class="label">Patrol Type</span>
              <span class="value">${escapeHtml(
  type === "manual"
    ? "Manual Patrols"
    : type === "recurring"
    ? "Routine Patrols"
    : "All Patrols"
)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Total Missed</span>
              <span class="value">${escapeHtml(totalMissed)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Routine Missed</span>
              <span class="value">${escapeHtml(routineMissed)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Manual Missed</span>
              <span class="value">${escapeHtml(manualMissed)}</span>
            </div>
          </div>

          <h2>Missed Patrol Log</h2>

          <table>
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Site</th>
                <th>Patrol Point</th>
                <th>Type</th>
                <th>Guard / Shift</th>
<th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>

          <div class="footer">
            <span>Aegis Link Security Operations Platform</span>
            <span>Generated Automatically</span>
          </div>
        </body>
      </html>
    `;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0",
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    const disposition = req.query.preview === "true" ? "inline" : "attachment";

res.setHeader(
  "Content-Disposition",
  `${disposition}; filename="${reportId}.pdf"`
);

    res.send(pdfBuffer);
  } catch (err) {
    if (browser) {
      await browser.close();
    }

    console.error("Missed patrol history PDF error:", err);

        res.status(500).json({
      status: "error",
      message: "Failed to generate missed patrol PDF report",
      error: err.message,
    });
  }
});

app.put(
  "/patrols/manual/:scheduleId/cancel",
  requireAuth,
  async (req, res) => {
    try {
      const scheduleId = Number(req.params.scheduleId);
      const isSystemOwner = req.auth.role === "system_owner";

      const cancelReason =
        typeof req.body.cancel_reason === "string" &&
        req.body.cancel_reason.trim()
          ? req.body.cancel_reason.trim()
          : "Cancelled by admin";

      if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid schedule ID",
        });
      }

      const result = await pool.query(
        `
        UPDATE patrol_schedules ps
        SET
          active = false,
          manual_status = 'cancelled',
          cancelled_at = NOW(),
          cancelled_by_username = $1,
          cancel_reason = $2
        FROM sites s
        WHERE ps.id = $3
          AND ps.schedule_type = 'manual'
          AND ps.cancelled_at IS NULL
          AND s.id = ps.site_id
          AND (
            $4::boolean = true
            OR s.company_id = $5
          )
        RETURNING ps.*
        `,
        [
          req.auth.username,
          cancelReason,
          scheduleId,
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Manual patrol not found or already cancelled",
        });
      }

      return res.json({
        status: "ok",
        message: "Manual patrol cancelled",
        manual_patrol: result.rows[0],
      });
    } catch (err) {
      console.error("Manual patrol cancel error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to cancel manual patrol",
      });
    }
  }
);

app.get(
  "/patrols/manual-history",
  requireAuth,
  async (req, res) => {
    try {
      const isSystemOwner = req.auth.role === "system_owner";

      const values = [
        isSystemOwner,
        req.auth.company_id,
      ];

      let whereClause = `
        WHERE ps.schedule_type = 'manual'
          AND (
            $1::boolean = true
            OR s.company_id = $2
          )
      `;

      if (
        req.query.site_id !== undefined &&
        req.query.site_id !== null &&
        req.query.site_id !== ""
      ) {
        const siteId = Number(req.query.site_id);

        if (!Number.isInteger(siteId) || siteId <= 0) {
          return res.status(400).json({
            status: "error",
            message: "Invalid site ID",
          });
        }

        values.push(siteId);
        whereClause += ` AND ps.site_id = $${values.length}`;
      }

    const result = await pool.query(
      `
      WITH manual_items AS (
        SELECT
          ps.id,
          ps.site_id,
          s.name AS site_name,
          s.location AS site_location,
          COALESCE(c.timezone, 'Europe/Athens') AS company_timezone,

          ps.patrol_point_id,
          pp.point_name,

          ps.scheduled_date,
          ps.scheduled_time,
          (ps.scheduled_date::timestamp + ps.scheduled_time) AS scheduled_at,

          ps.reminder_minutes_before,
          ps.active,
          ps.created_at,

          ps.created_by_admin_id,
          ps.created_by_username,
          ps.created_by_role,

          ps.manual_status,
          ps.cancelled_at,
          ps.cancelled_by_username,
          ps.cancel_reason,

          matched_log.id AS patrol_log_id,
          matched_log.patrol_time,
          matched_log.guard_name,
          matched_log.delay_minutes

        FROM patrol_schedules ps

        LEFT JOIN sites s
          ON s.id = ps.site_id

        LEFT JOIN companies c
          ON c.id = s.company_id

        LEFT JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id

        LEFT JOIN LATERAL (
          SELECT
            pl.id,
            pl.patrol_time,
            g.full_name AS guard_name,
            FLOOR(
              EXTRACT(
                EPOCH FROM (
                  pl.patrol_time -
                  (ps.scheduled_date::timestamp + ps.scheduled_time)
                )
              ) / 60
            )::int AS delay_minutes
          FROM patrol_logs pl
          LEFT JOIN guards g
            ON g.id = pl.guard_id
          WHERE pl.schedule_id = ps.id
            AND COALESCE(pl.schedule_type, 'manual') = 'manual'
          ORDER BY ABS(
            EXTRACT(
              EPOCH FROM (
                pl.patrol_time -
                (ps.scheduled_date::timestamp + ps.scheduled_time)
              )
            )
          ) ASC
          LIMIT 1
        ) matched_log ON true

        ${whereClause}
      )

      SELECT
        *,
        CASE
          WHEN cancelled_at IS NOT NULL
            THEN 'cancelled'

          WHEN patrol_log_id IS NOT NULL
            AND patrol_time <= scheduled_at
            THEN 'completed'

          WHEN patrol_log_id IS NOT NULL
            AND patrol_time > scheduled_at
            THEN 'completed_late'

          WHEN patrol_log_id IS NULL
            AND (NOW() AT TIME ZONE company_timezone)
              < scheduled_at + INTERVAL '16 minutes'
            THEN 'pending'

          WHEN patrol_log_id IS NULL
            AND (NOW() AT TIME ZONE company_timezone)
              >= scheduled_at + INTERVAL '16 minutes'
            THEN 'missed'

          ELSE 'pending'
        END AS computed_status

      FROM manual_items

      ORDER BY created_at DESC, id DESC
      LIMIT 100
      `,
      values
    );

    res.json({
      status: "ok",
      manual_history: result.rows,
    });
  } catch (err) {
    console.error("Manual patrol history load error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load manual patrol history",
      detail: err.message,
    });
  }
});

app.get(
  "/patrols/history",
  requireAuth,
  async (req, res) => {
    try {
      const isSystemOwner = req.auth.role === "system_owner";

      const countResult = await pool.query(
        `
        SELECT
          pl.site_id,
          COUNT(*)::int AS total
        FROM patrol_logs pl
        INNER JOIN sites s
          ON s.id = pl.site_id
        WHERE pl.patrol_time >= NOW() - INTERVAL '24 hours'
          AND (
            $1::boolean = true
            OR s.company_id = $2
          )
        GROUP BY pl.site_id
        `,
        [
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      const result = await pool.query(
        `
        SELECT
          pl.id,
          pl.site_id,
          pl.patrol_time,
          pl.scheduled_at,
          pl.delay_minutes,
          pl.completion_status,
          pl.was_missed,

          s.name AS site_name,

          pp.point_name,

          g.full_name AS guard_name,

          pl.latitude,
          pl.longitude,
          pl.accuracy

        FROM patrol_logs pl

        INNER JOIN sites s
          ON s.id = pl.site_id

        LEFT JOIN patrol_points pp
          ON pp.id = pl.point_id
          AND pp.site_id = pl.site_id

        LEFT JOIN guards g
          ON g.id = pl.guard_id
          AND g.site_id = pl.site_id

        WHERE (
          $1::boolean = true
          OR s.company_id = $2
        )

        ORDER BY pl.patrol_time DESC
        LIMIT 50
        `,
        [
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      return res.json({
        status: "ok",
        history: result.rows,
        completed_by_site: countResult.rows,
      });
    } catch (err) {
      console.error("Patrol history load error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to load patrol history",
        detail: err.message,
      });
    }
  }
);

app.get(
  "/patrols/completed-history",
  requireAuth,
  async (req, res) => {
    try {
      const {
        site_id,
        point_id,
        from,
        to,
        type = "all",
        status = "all",
      } = req.query;

      const isSystemOwner = req.auth.role === "system_owner";

      const parsedSiteId = site_id ? Number(site_id) : null;
      const parsedPointId = point_id ? Number(point_id) : null;

      if (
        parsedSiteId !== null &&
        (!Number.isInteger(parsedSiteId) || parsedSiteId <= 0)
      ) {
        return res.status(400).json({
          status: "error",
          message: "Invalid site_id",
        });
      }

      if (
        parsedPointId !== null &&
        (!Number.isInteger(parsedPointId) || parsedPointId <= 0)
      ) {
        return res.status(400).json({
          status: "error",
          message: "Invalid point_id",
        });
      }

      const result = await pool.query(
        `
        SELECT
          pl.id,
          pl.site_id,
          s.name AS site_name,
          s.location AS site_location,

          pl.point_id,
          pp.point_name,

          pl.guard_id,
          g.full_name AS guard_name,

          pl.patrol_time,
          pl.scheduled_at,
          pl.delay_minutes,
          pl.completion_status,
          pl.was_missed,
          COALESCE(pl.schedule_type, 'recurring') AS schedule_type,

          pl.latitude,
          pl.longitude,
          pl.accuracy

        FROM patrol_logs pl

        INNER JOIN sites s
          ON s.id = pl.site_id

        LEFT JOIN patrol_points pp
          ON pp.id = pl.point_id
          AND pp.site_id = pl.site_id

        LEFT JOIN guards g
          ON g.id = pl.guard_id
          AND g.site_id = pl.site_id

        WHERE (
          $1::boolean = true
          OR s.company_id = $2
        )

          AND ($3::int IS NULL OR pl.site_id = $3::int)
          AND ($4::int IS NULL OR pl.point_id = $4::int)

          AND (
            $5::date IS NULL
            OR (pl.patrol_time AT TIME ZONE 'Europe/Athens')::date >= $5::date
          )

          AND (
            $6::date IS NULL
            OR (pl.patrol_time AT TIME ZONE 'Europe/Athens')::date <= $6::date
          )

          AND (
            $7::text = 'all'
            OR COALESCE(pl.schedule_type, 'recurring') = $7::text
          )

        ORDER BY pl.patrol_time DESC
        LIMIT 300
        `,
        [
          isSystemOwner,
          req.auth.company_id,
          parsedSiteId,
          parsedPointId,
          from || null,
          to || null,
          type || "all",
        ]
      );

      const siteIds = [
        ...new Set(
          result.rows
            .map((row) => row.site_id)
            .filter(Boolean)
        ),
      ];

      let sitesById = {};

      if (siteIds.length > 0) {
        const sitesResult = await pool.query(
          `
          SELECT
            id,
            coverage_type,
            shift_rules
          FROM sites
          WHERE id = ANY($1::int[])
            AND (
              $2::boolean = true
              OR company_id = $3
            )
          `,
          [
            siteIds,
            isSystemOwner,
            req.auth.company_id,
          ]
        );

        sitesById = sitesResult.rows.reduce((acc, site) => {
          acc[site.id] = site;
          return acc;
        }, {});
      }

      const historyWithCorrections = await attachCorrectionsToRows(
        pool,
        result.rows,
        (row) => `patrol-log-${row.id}`,
        (row) =>
          row.completion_status === "completed_late" ||
          Number(row.delay_minutes || 0) > 0
            ? "COMPLETED_LATE"
            : "COMPLETED"
      );

      const historyWithShift = historyWithCorrections.map((row) => {
        const site = sitesById[row.site_id];

        let displayStatus = "completed";

        if (
          row.completion_status === "completed_late" ||
          Number(row.delay_minutes || 0) > 0
        ) {
          displayStatus = "completed_late";
        }

        return {
          ...row,
          display_status: displayStatus,
          shift_label: resolveShiftLabel(
            site,
            row.patrol_time
          ),
        };
      });

      let filteredHistory = historyWithShift;

      if (status && status !== "all") {
        filteredHistory = historyWithShift.filter(
          (row) => row.display_status === status
        );
      }

      return res.json({
        status: "ok",
        history: filteredHistory,
      });
    } catch (err) {
      console.error(
        "Completed patrol history load error:",
        err
      );

      return res.status(500).json({
        status: "error",
        message:
          "Failed to load completed patrol history",
        detail: err.message,
      });
    }
  }
);

app.get(
  "/patrols/completed-history/report/pdf",
  requireAuth,
  async (req, res) => {
  let browser;

  try {
    const {
      site_id,
      from,
      to,
      point_id,
      type = "all",
      status = "all",
    } = req.query;

    const companyTimezone = await getCompanyTimezone(
  req.auth.company_id
);

    const params = new URLSearchParams();

    if (site_id) params.append("site_id", site_id);
    if (from) params.append("from", from);
    if (to) params.append("to", to);
    if (point_id) params.append("point_id", point_id);
    if (type) params.append("type", type);
    if (status) params.append("status", status);

    const forwardedProtocol =
  req.get("x-forwarded-proto") || req.protocol;

const historyResponse = await fetch(
  `${forwardedProtocol}://${req.get("host")}/patrols/completed-history?${params.toString()}`,
  {
    headers: {
      Authorization: req.get("authorization"),
    },
  }
);

if (!historyResponse.ok) {
  return res.status(historyResponse.status).json({
    status: "error",
    message: "Failed to load completed patrol history",
  });
}

    const data = await historyResponse.json();

    if (data.status !== "ok") {
      return res.status(404).json({
        status: "error",
        message: "Completed patrol history not found",
      });
    }

    const history = data.history || [];

    const totalCompleted = history.length;
    const completedLate = history.filter(
      (item) => item.display_status === "completed_late"
    ).length;
    const completedOnTime = history.filter(
      (item) => item.display_status === "completed"
    ).length;

    const siteName = history[0]?.site_name || "Selected Site";
    const siteLocation = history[0]?.site_location || "-";

    const reportId = `COMPLETED-PATROL-${site_id || "ALL"}-${Date.now()}`;

    const formatStatus = (value) => {
      if (value === "completed_late") return "Completed Late";
      return "Completed";
    };

    const rowsHtml = history
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(
              formatReportTime(
  item.patrol_time,
  companyTimezone
)
            )}</td>
            <td>${escapeHtml(item.site_name)}</td>
            <td>${escapeHtml(item.point_name)}</td>
            <td>${escapeHtml(item.guard_name || "-")}</td>
            <td>${escapeHtml(
              item.schedule_type === "manual"
                ? "Manual Patrol"
                : "Routine Patrol"
            )}</td>
            <td>${escapeHtml(formatStatus(item.display_status))}</td>
            <td>${escapeHtml(
              item.delay_minutes !== null && item.delay_minutes !== undefined
                ? `${item.delay_minutes} minutes`
                : "-"
            )}</td>
            <td>${escapeHtml(item.shift_label || "-")}</td>
            <td>${escapeHtml(
              item.accuracy ? `${Number(item.accuracy).toFixed(2)} m` : "-"
            )}</td>
            <td>${escapeHtml(
              item.latitude && item.longitude
                ? `${item.latitude}, ${item.longitude}`
                : "-"
            )}</td>
          </tr>
        `
      )
      .join("");

    const html = `
      <html>
        <head>
          <title>Completed Patrol History Report</title>
          <style>
            @page { margin: 16mm; }

            body {
              font-family: Arial, sans-serif;
              color: #111;
              margin: 0;
              padding: 28px 34px;
              box-sizing: border-box;
            }

            .report-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              border-bottom: 3px solid #111827;
              padding-bottom: 18px;
              margin-bottom: 28px;
            }

            .brand-title h1 {
              margin: 0;
              font-size: 28px;
              letter-spacing: 1px;
            }

            .brand-title p {
              margin: 4px 0 0;
              color: #555;
              font-size: 14px;
            }

            .report-meta {
              text-align: right;
              font-size: 13px;
              color: #444;
            }

            .summary-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 10px 28px;
              margin-bottom: 28px;
            }

            .summary-item {
              border-bottom: 1px solid #eee;
              padding-bottom: 8px;
            }

            .label {
              display: block;
              font-size: 11px;
              text-transform: uppercase;
              color: #666;
              letter-spacing: .6px;
              margin-bottom: 3px;
            }

            .value {
              font-size: 15px;
              font-weight: 600;
            }

            h2 {
              margin-top: 30px;
              border-bottom: 1px solid #ddd;
              padding-bottom: 8px;
              font-size: 18px;
            }

            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 10px;
            }

            th {
              text-align: left;
              background: #111827;
              color: #fff;
              padding: 9px 8px;
              font-size: 12px;
            }

            td {
              border-bottom: 1px solid #eee;
              padding: 9px 8px;
              font-size: 12px;
              vertical-align: top;
            }

            .footer {
              margin-top: 36px;
              padding-top: 14px;
              border-top: 1px solid #ddd;
              font-size: 12px;
              color: #555;
              display: flex;
              justify-content: space-between;
            }
          </style>
        </head>

        <body>
          <div class="report-header">
            <div class="brand-title">
              <h1>AEGIS LINK</h1>
              <p>Security Operations Platform</p>
            </div>

            <div class="report-meta">
              <strong>Completed Patrol History Report</strong><br/>
              Report ID: ${escapeHtml(reportId)}<br/>
              Generated: ${escapeHtml(
                formatReportTime(
  new Date(),
  companyTimezone
)
              )}<br/>
              Generated By: System
            </div>
          </div>

          <div class="summary-grid">
            <div class="summary-item">
              <span class="label">Site</span>
              <span class="value">${escapeHtml(siteName)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Location</span>
              <span class="value">${escapeHtml(siteLocation)}</span>
            </div>

            <div class="summary-item">
              <span class="label">From Date</span>
              <span class="value">${escapeHtml(from || "-")}</span>
            </div>

            <div class="summary-item">
              <span class="label">To Date</span>
              <span class="value">${escapeHtml(to || "-")}</span>
            </div>

            <div class="summary-item">
              <span class="label">Patrol Type</span>
              <span class="value">${escapeHtml(
                type === "manual"
                  ? "Manual Patrols"
                  : type === "recurring"
                  ? "Routine Patrols"
                  : "All Patrols"
              )}</span>
            </div>

            <div class="summary-item">
              <span class="label">Completion Status</span>
              <span class="value">${escapeHtml(
                status === "completed"
                  ? "Completed"
                  : status === "completed_late"
                  ? "Completed Late"
                  : "All Completed"
              )}</span>
            </div>

            <div class="summary-item">
              <span class="label">Total Completed</span>
              <span class="value">${escapeHtml(totalCompleted)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Completed On Time</span>
              <span class="value">${escapeHtml(completedOnTime)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Completed Late</span>
              <span class="value">${escapeHtml(completedLate)}</span>
            </div>

          </div>

          <h2>Completed Patrol Log</h2>

          <table>
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Site</th>
                <th>Patrol Point</th>
                <th>Guard</th>
                <th>Type</th>
                <th>Status</th>
                <th>Delay</th>
                <th>Shift</th>
                <th>Accuracy</th>
                <th>Coordinates</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>

          <div class="footer">
            <span>Aegis Link Security Operations Platform</span>
            <span>Generated Automatically</span>
          </div>
        </body>
      </html>
    `;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0",
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      landscape: true,
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");

    const disposition = req.query.preview === "true" ? "inline" : "attachment";

    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${reportId}.pdf"`
    );

    res.send(pdfBuffer);
  } catch (err) {
    if (browser) {
      await browser.close();
    }

    console.error("Completed patrol history PDF error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to generate completed patrol PDF report",
      error: err.message,
    });
  }
});

async function startBackend() {
  await runMigrations(pool);
  await refreshTemporaryAccessExpirations();
  await systemStatusService.initialize();

  const patrolIntegrity =
    await ensurePatrolOccurrenceIntegrity();

  console.log("Patrol occurrence integrity ready:", patrolIntegrity);

  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
  });

  startScheduledShiftGenerator();
  startShiftDelayMonitor();
  systemStatusService.startMonitor();

  setInterval(() => {
    refreshTemporaryAccessExpirations().catch((error) => {
      console.error("Temporary access expiration refresh failed:", error);
    });
  }, 5 * 60 * 1000);

  setTimeout(runPatrolPushScheduler, 10000);
  setInterval(runPatrolPushScheduler, 60000);
}

startBackend().catch((err) => {
  console.error("Backend startup failed:", err);
  process.exit(1);
});






