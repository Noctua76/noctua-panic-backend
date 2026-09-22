Warning: truncated output (original token count: 97596)
Total output lines: 14735

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
const {
  createRandomPatrolRouter,
  generateRandomPatrolsForCurrentLocalDay,
} = require("./patrol/random-patrols");
const { PATROL_TIMING } = require("./patrol/lifecycle");
const { createShiftReportsRouter } = require("./reports/shift-reports");
const { createSupabaseGuardReportsStorage } = require("./storage/supabase-storage");
const {
  PASSWORD_SETUP_TOKEN_TTL_MINUTES,
  commitGuardPasswordReset,
  createPasswordSetupToken,
  evaluatePasswordChangeCredential,
  generateTemporaryPassword,
  getTempPasswordTtlHours,
  parsePasswordSetupToken,
  validateGuardPassword,
} = require("./auth/guard-password-lifecycle");
const { createDashboardRbac } = require("./auth/dashboard-rbac");
const { resetDashboardUserPassword } = require("./auth/dashboard-user-password-reset");
const { enforceDashboardPasswordChange } = require("./auth/dashboard-password-gate");
const { changeDashboardPassword } = require("./auth/dashboard-password-change");
const { createCompaniesRouter } = require("./admin/companies");

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
        updated_at = NOW()
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
          email_sent_at = NOW(),
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
const dashboardRbac = createDashboardRbac({ pool });
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
        (SELECT ur.role_id FROM user_dashboard_roles ur WHERE ur.user_id = users.id) AS role_id,
        COALESCE((SELECT r.code FROM user_dashboard_roles ur JOIN dashboard_roles r ON r.id=ur.role_id WHERE ur.user_id=users.id), role) AS role_code,
        COALESCE((SELECT r.name FROM user_dashboard_roles ur JOIN dashboard_roles r ON r.id=ur.role_id WHERE ur.user_id=users.id),
          CASE WHEN role='guard' THEN 'Legacy Dashboard Role' ELSE role END) AS role_name,
        (role = 'guard' AND NOT EXISTS (SELECT 1 FROM user_dashboard_roles ur WHERE ur.user_id=users.id)) AS is_legacy_role,
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
      users: req.auth.is_system_owner
        ? result.rows
        : result.rows.filter((user) => !user.is_legacy_role),
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
        (SELECT ur.role_id FROM user_dashboard_roles ur WHERE ur.user_id = users.id) AS role_id,
        COALESCE((SELECT r.code FROM user_dashboard_roles ur JOIN dashboard_roles r ON r.id=ur.role_id WHERE ur.user_id=users.id), role) AS role_code,
        COALESCE((SELECT r.name FROM user_dashboard_roles ur JOIN dashboard_roles r ON r.id=ur.role_id WHERE ur.user_id=users.id),
          CASE WHEN role='guard' THEN 'Legacy Dashboard Role' ELSE role END) AS role_name,
        (role = 'guard' AND NOT EXISTS (SELECT 1 FROM user_dashboard_roles ur WHERE ur.user_id=users.id)) AS is_legacy_role,
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

    if (result.rows[0].is_legacy_role && !req.auth.is_system_owner) {
      return res.status(404).json({ status: "error", message: "User not found" });
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
  const client = await pool.connect();
  try {
    const { full_name, username, email, secondary_email, phone, mobile_phone,
      backup_phone, role = "viewer", role_id, status = "active", company_id } = req.body;
    const normalizedFullName = typeof full_name === "string" ? full_name.trim() : "";
    const normalizedUsername = typeof username === "string" ? username.trim() : "";
    if (!normalizedFullName || !normalizedUsername) {
      return res.status(400).json({ status: "error", message: "full_name and username are required" });
    }
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ status: "error", message: "Invalid user status" });
    }

    const targetRole = await resolveAssignableDashboardRole(client, role_id || role, "viewer");
    if (!targetRole || targetRole.code === "guard") {
      return res.status(400).json({ status: "error", message: "Invalid Dashboard role" });
    }
    if (!req.auth.is_system_owner && targetRole.code === "system_owner") {
      return res.status(403).json({ status: "error", message: "Only the System Owner can assign System Owner" });
    }

    let targetCompanyId = req.auth.company_id;
    if (req.auth.is_system_owner) {
      const parsedCompanyId = Number(company_id ?? req.auth.company_id);
      if (!Number.isInteger(parsedCompanyId) || parsedCompanyId <= 0) {
        return res.status(400).json({ status: "error", message: "Invalid company_id" });
      }
      targetCompanyId = parsedCompanyId;
    }
    const companyResult = await client.query(`SELECT id FROM companies WHERE id=$1`, [targetCompanyId]);
    if (!companyResult.rows.length) return res.status(404).json({ status: "error", message: "Company not found" });

    const temporaryPassword = crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO users (full_name,username,email,secondary_email,phone,mobile_phone,backup_phone,
         role,status,company_id,password_hash,must_change_password,created_at)
       VALUES($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8,$9,$10,$11,TRUE,NOW())
       RETURNING id,full_name,username,email,secondary_email,phone,mobile_phone,backup_phone,role,status,
         must_change_password,company_id,created_at`,
      [normalizedFullName, normalizedUsername, email, secondary_email, phone, mobile_phone, backup_phone,
        targetRole.code, status, targetCompanyId, passwordHash]
    );
    const user = result.rows[0];
    await client.query(`INSERT INTO user_dashboard_roles(user_id,role_id,assigned_by) VALUES($1,$2,$3)`,
      [user.id, targetRole.id, req.auth.user_id]);
    await recordRbacAudit(client, { type: "USER_ROLE_ASSIGNED", actorUserId: req.auth.user_id,
      targetUserId: user.id, roleId: targetRole.id, companyId: targetCompanyId,
      after: { role_code: targetRole.code } });
    await client.query("COMMIT");
    return res.status(201).json({ status: "ok", message: "User created successfully",
      temporary_password: temporaryPassword,
      user: { ...user, role_id: targetRole.id, role_code: targetRole.code, role_name: targetRole.name } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Create admin user error:", err);
    if (err.code === "23505") return res.status(409).json({ status: "error", message: "Username already exists" });
    return res.status(500).json({ status: "error", message: err.message });
  } finally { client.release(); }
});

app.put("/admin/users/:id", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ status: "error", message: "Invalid user id" });
    const { full_name, username, email, secondary_email, phone, mobile_phone, backup_phone,
      role, role_id, status } = req.body;
    if (status && !["active", "inactive"].includes(status)) return res.status(400).json({ status: "error", message: "Invalid user status" });
    const { companyId, error } = resolveAdminUsersCompanyScope(req);
    if (error) return res.status(400).json({ status: "error", message: error });

    await client.query("BEGIN");
    const currentResult = await client.query(
      `SELECT u.*, ur.role_id, r.code AS role_code, r.name AS role_name
       FROM users u LEFT JOIN user_dashboard_roles ur ON ur.user_id=u.id
       LEFT JOIN dashboard_roles r ON r.id=ur.role_id
       WHERE u.id=$1 AND u.company_id=$2 FOR UPDATE OF u`, [userId, companyId]
    );
    const current = currentResult.rows[0];
    if (!current) { await client.query("ROLLBACK"); return res.status(404).json({ status: "error", message: "User not found" }); }
    if (!req.auth.is_system_owner && (current.role_code === "system_owner" || current.role === "system_owner")) {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "Only the System Owner can manage a System Owner" });
    }

    const requestedRole = role_id || role;
    const targetRole = requestedRole ? await resolveAssignableDashboardRole(client, requestedRole) :
      (current.role_id ? await resolveAssignableDashboardRole(client, current.role_id) : null);
    if (requestedRole && (!targetRole || targetRole.code === "guard")) {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "error", message: "Invalid Dashboard role" });
    }
    if (!req.auth.is_system_owner && targetRole?.code === "system_owner") {
      await client.query("ROLLBACK");
      return res.status(403).json({ status: "error", message: "Only the System Owner can assign System Owner" });
    }

    const removesSystemOwner = (current.role_code === "system_owner" || current.role === "system_owner") &&
      (targetRole?.code !== "system_owner" || status === "inactive");
    if (removesSystemOwner) {
      const ownerCount = await client.query(
        `SELECT COUNT(*)::int AS count FROM users u JOIN user_dashboard_roles ur ON ur.user_id=u.id
         JOIN dashboard_roles r ON r.id=ur.role_id WHERE r.code='system_owner' AND u.status='active'`
      );
      if (ownerCount.rows[0].count <= 1) {
        await client.query("ROLLBACK");
        return res.status(409).json({ status: "error", message: "The last active System Owner cannot be removed or deactivated" });
      }
    }

    const canonicalRole = targetRole?.code || current.role;
    const result = await client.query(
      `UPDATE users SET full_name=COALESCE(NULLIF($1,''),full_name), username=COALESCE(NULLIF($2,''),username),
         email=NULLIF($3,''), secondary_email=NULLIF($4,''), phone=NULLIF($5,''), mobile_phone=NULLIF($6,''),
         backup_phone=NULLIF($7,''), role=$8, status=COALESCE(NULLIF($9,''),status), updated_at=NOW()
       WHERE id=$10 RETURNING id,full_name,username,email,secondary_email,phone,mobile_phone,backup_phone,
         role,status,must_change_password,company_id,created_at,updated_at`,
      [full_name, username, email, secondary_email, phone, mobile_phone, backup_phone,
        canonicalRole, status, userId]
    );
    if (targetRole && Number(current.role_id) !== Number(targetRole.id)) {
      await client.query(
        `INSERT INTO user_dashboard_roles(user_id,role_id,assigned_by,assigned_at) VALUES($1,$2,$3,NOW())
         ON CONFLICT(user_id) DO UPDATE SET role_id=EXCLUDED.role_id, assigned_by=EXCLUDED.assigned_by, assigned_at=NOW()`,
        [userId, targetRole.id, req.auth.user_id]
      );
      await recordRbacAudit(client, { type: current.role_id ? "USER_ROLE_CHANGED" : "USER_ROLE_ASSIGNED",
        actorUserId: req.auth.user_id, targetUserId: userId, roleId: targetRole.id, companyId,
        before: { role_id: current.role_id, role_code: current.role_code || current.role },
        after: { role_id: targetRole.id, role_code: targetRole.code } });
    }
    await dashboardRbac.revokeAuthorizationSessions(client, [userId]);
    await client.query("COMMIT");
    return res.json({ status: "ok", message: "User updated successfully",
      user: { ...result.rows[0], role_id: targetRole?.id || null, role_code: canonicalRole, role_name: targetRole?.name || "Legacy Dashboard Role" } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Update admin user error:", err);
    if (err.code === "23505") return res.status(409).json({ status: "error", message: "Username already exists" });
    return res.status(500).json({ status: "error", message: err.message });
  } finally { client.release(); }
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
        u.authorization_version,
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

    const authorization = await dashboardRbac.resolveAuthorization({
      user_id: user.id,
      role: user.role,
      authorization_version: user.authorization_version,
    });

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
        role_id: authorization.role_id,
        role_code: authorization.role_code,
        role_name: authorization.role_name,
        permissions: authorization.permissions,
        legacy_role: authorization.legacy_role,
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
  if (!req.auth.is_system_owner) {
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
        u.authorization_version,
        u.must_change_password,
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
        code: "AUTH_SESSION_INVALID",
        message: "The Dashboard session is no longer active.",
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
authorization_version: auth.authorization_version,
must_change_password: auth.must_change_password,
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

    if (enforceDashboardPasswordChange(req, res)) {
      return;
    }

    Object.assign(
      req.auth,
      await dashboardRbac.resolveAuthorization(req.auth)
    );

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

    dashboardRbac.enforceRequestPermission(req, res, next);
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
    gs.scheduled_shift_start,
    gs.scheduled_shift_end,
    gs.scheduled_shift_label,
    g.full_name,
g.role,
g.access_mode,
g.temporary_access_started_at,
g.access_expires_at,
g.temporary_access_expiry_reason
  FROM guard_sessions gs
  JOIN guards g
    ON g.id = gs.guard_id
  JOIN sites s
    ON s.id = gs.site_id
  WHERE
    gs.session_token = $1
    AND gs.logout_time IS NULL
    AND COALESCE(g.must_change_password, FALSE) = FALSE
    AND (
      g.access_mode <> 'standard'
      OR gs.scheduled_shift_end IS NULL
      OR gs.scheduled_shift_end + INTERVAL '15 minutes'
         > (NOW() AT TIME ZONE 'Europe/Athens')
    )
  LIMIT 1
  `,
  [sessionToken]
);

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized",
      });
    }

    const guardAuth = result.rows[0];

if (
  guardAuth.temporary_access_expiry_reason ||
  isTemporaryAccessExpired(guardAuth.access_expires_at)
) {
  if (
    !guardAuth.temporary_access_expiry_reason &&
    isTemporaryAccessExpired(guardAuth.access_expires_at)
  ) {
    await pool.query(
      `
      UPDATE guards
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
      [guardAuth.guard_id, ACCESS_MODE_READ_ONLY]
    );
  }

  await pool.query(
    `
    UPDATE guard_sessions
    SET
      logout_time = NOW(),
      status = 'temporary_access_expired',
      last_heartbeat = NOW()
    WHERE id = $1
      AND logout_time IS NULL
    `,
    [guardAuth.session_id]
  );

  return res.status(403).json({
    status: "error",
    code: "TEMPORARY_ACCESS_EXPIRED",
    expiry_reason:
      guardAuth.temporary_access_expiry_reason ||
      "access_period_completed",
    message: getTemporaryExpiryMessage(
      guardAuth.temporary_access_expiry_reason
    ),
  });
}

req.guard = guardAuth;

if (
  blockReadOnlyMutation(
    req,
    res,
    req.guard.access_mode,
    READ_ONLY_GUARD_MUTATION_ALLOWLIST
  )
) {
  return;
}

next();
  } catch (err) {
    console.error("Guard auth failed:", err);

    return res.status(500).json({
      status: "error",
      message: "Authentication failed",
    });
  }
}

// ----------------------------------------------------------
// AUTH CONTEXT TEST
// ----------------------------------------------------------

app.get("/auth/context", requireAuth, async (req, res) => {
  return res.json({
    status: "ok",
    auth: req.auth,
  });
});

// ----------------------------------------------------------
// TEMPORARY READ-ONLY PREVIEW ACCESS
// ----------------------------------------------------------

app.get(
  "/admin/temporary-access",
  requireAuth,
  async (req, res) => {
    try {
      if (!req.auth.is_system_owner) {
        return res.status(403).json({
          status: "error",
          message:
            "Only the system owner can manage temporary access",
        });
      }

      await refreshTemporaryAccessExpirations();

      const [usersResult, guardsResult] =
        await Promise.all([
          pool.query(
            `
            SELECT
              u.id,
              u.username,
              u.company_id,
              u.status,
              u.temporary_access_group_id,
              u.temporary_access_label,
              u.temporary_access_duration_hours,
              u.temporary_access_started_at,
              u.access_expires_at,
              u.temporary_access_activation_deadline,
              u.temporary_access_expiry_reason,
              u.temporary_access_auto_expired_at,
              u.temporary_access_revoked_at,
              c.name AS company_name
            FROM users u
            JOIN companies c
              ON c.id = u.company_id
            WHERE u.access_mode = $1
              AND u.temporary_access_group_id IS NOT NULL
            ORDER BY u.created_at DESC
            `,
            [ACCESS_MODE_READ_ONLY]
          ),

          pool.query(
            `
            SELECT
              g.id,
              g.username,
              g.site_id,
              g.active,
              g.temporary_access_group_id,
              g.temporary_access_started_at,
              g.access_expires_at,
              g.temporary_access_activation_deadline,
              g.temporary_access_expiry_reason,
              g.temporary_access_auto_expired_at,
              g.temporary_access_revoked_at,
              s.name AS site_name
            FROM guards g
            JOIN sites s
              ON s.id = g.site_id
            WHERE g.access_mode = $1
              AND g.temporary_access_group_id IS NOT NULL
            `,
            [ACCESS_MODE_READ_ONLY]
          ),
        ]);

      const guardsByGroup = new Map(
        guardsResult.rows.map((guard) => [
          guard.temporary_access_group_id,
          guard,
        ])
      );

      const temporaryAccess =
        usersResult.rows.map((user) => {
          const guard =
            guardsByGroup.get(
              user.temporary_access_group_id
            ) || null;

          const dashboardStatus =
            getTemporaryAccountStatus({
              enabled: user.status === "active",
              revokedAt:
                user.temporary_access_revoked_at,
              startedAt:
                user.temporary_access_started_at,
              expiresAt: user.access_expires_at,
              activationDeadline:
                user.temporary_access_activation_deadline,
              expiryReason:
                user.temporary_access_expiry_reason,
            });

          const webAppStatus = guard
            ? getTemporaryAccountStatus({
                enabled: guard.active === true,
                revokedAt:
                  guard.temporary_access_revoked_at,
                startedAt:
                  guard.temporary_access_started_at,
                expiresAt: guard.access_expires_at,
                activationDeadline:
                  guard.temporary_access_activation_deadline,
                expiryReason:
                  guard.temporary_access_expiry_reason,
              })
            : "revoked";

          const accountStatuses = [
            dashboardStatus,
            webAppStatus,
          ];

          const accessStatus =
            accountStatuses.includes("active")
              ? "active"
              : accountStatuses.includes("pending")
              ? "pending"
              : accountStatuses.every(
                  (status) => status === "revoked"
                )
              ? "revoked"
              : "expired";

          return {
            group_id:
              user.temporary_access_group_id,
            label: user.temporary_access_label,
            company_id: user.company_id,
            company_name: user.company_name,
            site_id: guard?.site_id || null,
            site_name: guard?.site_name || null,
            duration_hours:
              user.temporary_access_duration_hours,
            status: accessStatus,

            dashboard: {
              user_id: user.id,
              username: user.username,
              started_at:
                user.temporary_access_started_at,
              expires_at: user.access_expires_at,
              activation_deadline:
                user.temporary_access_activation_deadline,
              expiry_reason:
                user.temporary_access_expiry_reason,
              auto_expired_at:
                user.temporary_access_auto_expired_at,
              status_reason:
                getTemporaryStatusReason(dashboardStatus),
              status: dashboardStatus,
            },

            web_app: guard
              ? {
                  guard_id: guard.id,
                  username: guard.username,
                  started_at:
                    guard.temporary_access_started_at,
                  expires_at:
                    guard.access_expires_at,
                  activation_deadline:
                    guard.temporary_access_activation_deadline,
                  expiry_reason:
                    guard.temporary_access_expiry_reason,
                  auto_expired_at:
                    guard.temporary_access_auto_expired_at,
                  status_reason:
                    getTemporaryStatusReason(webAppStatus),
                  status: webAppStatus,
                }
              : null,
          };
        });

      return res.json({
        status: "ok",
        temporary_access: temporaryAccess,
      });
    } catch (err) {
      console.error(
        "Temporary access list error:",
        err
      );

      return res.status(500).json({
        status: "error",
        message:
          "Unable to load temporary access",
      });
    }
  }
);

app.post(
  "/admin/temporary-access",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      if (!req.auth.is_system_owner) {
        return res.status(403).json({
          status: "error",
          message:
            "Only the system owner can create temporary access",
        });
      }

      const siteId = Number(req.body.site_id);

      const durationHours = Number(
        req.body.duration_hours ?? 48
      );

      const label =
        typeof req.body.label === "string" &&
        req.body.label.trim()
          ? req.body.label.trim().slice(0, 120)
          : "External Preview";

      if (!Number.isInteger(siteId) || siteId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "A valid site_id is required",
        });
      }

      if (
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > 168
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "duration_hours must be between 1 and 168",
        });
      }

      const preferredDashboardUsername =
        normalizeTemporaryAccessUsername(
          req.body.dashboard_username,
          "preview.dashboard"
        );

      const preferredGuardUsername =
        normalizeTemporaryAccessUsername(
          req.body.guard_username,
          "preview.guard"
        );

      if (
        !preferredDashboardUsername ||
        !preferredGuardUsername
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "Temporary usernames contain invalid characters",
        });
      }

      await client.query("BEGIN");

      const siteResult = await client.query(
        `
        SELECT
          s.id,
          s.name,
          s.company_id,
          c.name AS company_name
        FROM sites s
        JOIN companies c
          ON c.id = s.company_id
        WHERE s.id = $1
        LIMIT 1
        `,
        [siteId]
      );

      if (siteResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          status: "error",
          message: "Site not found",
        });
      }

      const site = siteResult.rows[0];
      const supervisorRoleResult = await client.query(
        `SELECT id, code
         FROM dashboard_roles
         WHERE code = 'supervisor'
           AND is_active = TRUE
         LIMIT 1`
      );

      if (supervisorRoleResult.rows.length === 0) {
        const error = new Error("Active Supervisor role is unavailable");
        error.code = "SUPERVISOR_ROLE_UNAVAILABLE";
        throw error;
      }

      const supervisorRole = supervisorRoleResult.rows[0];
      const groupId = crypto.randomUUID();
      const usernameSuffix = groupId.slice(0, 8);

      const dashboardUsername =
        await resolveAvailableTemporaryUsername(
          client,
          "users",
          preferredDashboardUsername,
          usernameSuffix
        );

      const guardUsername =
        await resolveAvailableTemporaryUsername(
          client,
          "guards",
          preferredGuardUsername,
          usernameSuffix
        );

      const dashboardPassword =
        createTemporaryAccessPassword();

      const guardPassword =
        createTemporaryAccessPassword();

      const [
        dashboardPasswordHash,
        guardPasswordHash,
      ] = await Promise.all([
        bcrypt.hash(dashboardPassword, 10),
        bcrypt.hash(guardPassword, 10),
      ]);

      const userResult = await client.query(
        `
        INSERT INTO users (
          full_name,
          username,
          role,
          status,
          company_id,
          password_hash,
          must_change_password,
          access_mode,
          temporary_access_duration_hours,
          temporary_access_group_id,
          temporary_access_label,
          temporary_access_activation_deadline,
          created_at
        )
        VALUES (
          $1,
          $2,
          'supervisor',
          'active',
          $3,
          $4,
          false,
          $5,
          $6,
          $7,
          $8,
          NOW() + INTERVAL '14 days',
          NOW()
        )
        RETURNING
          id,
          username
        `,
        [
          `${label} - Dashboard`,
          dashboardUsername,
          site.company_id,
          dashboardPasswordHash,
          ACCESS_MODE_READ_ONLY,
          durationHours,
          groupId,
          label,
        ]
      );

      await client.query(
        `INSERT INTO user_dashboard_roles (user_id, role_id, assigned_by)
         VALUES ($1, $2, $3)`,
        [userResult.rows[0].id, supervisorRole.id, req.auth.user_id]
      );

      await client.query(
        `INSERT INTO dashboard_rbac_audit_events (
           event_type, actor_user_id, target_user_id, role_id,
           company_id, before_state, after_state
         )
         VALUES (
           'USER_ROLE_ASSIGNED', $1, $2, $3, $4, NULL,
           jsonb_build_object(
             'role_code', $5::text,
             'source', 'temporary_preview_creation',
             'access_mode', $6::text
           )
         )`,
        [
          req.auth.user_id,
          userResult.rows[0].id,
          supervisorRole.id,
          site.company_id,
          supervisorRole.code,
          ACCESS_MODE_READ_ONLY,
        ]
      );

      const guardResult = await client.query(
        `
        INSERT INTO guards (
          full_name,
          username,
          role,
          site_id,
          active,
          password_hash,
          access_mode,
          temporary_access_duration_hours,
          temporary_access_group_id,
          temporary_access_label,
          temporary_access_activation_deadline,
          created_at
        )
        VALUES (
          $1,
          $2,
          'guard',
          $3,
          true,
          $4,
          $5,
          $6,
          $7,
          $8,
          NOW() + INTERVAL '14 days',
          NOW()
        )
        RETURNING
          id,
          username
        `,
        [
          `${label} - Guard`,
          guardUsername,
          site.id,
          guardPasswordHash,
          ACCESS_MODE_READ_ONLY,
          durationHours,
          groupId,
          label,
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        status: "ok",
        message:
          "Temporary preview access created",
        starts_on_first_login: true,
        activation_deadline_days: 14,
        group_id: groupId,
        label,
        duration_hours: durationHours,

        company: {
          id: site.company_id,
          name: site.company_name,
        },

        site: {
          id: site.id,
          name: site.name,
        },

        credentials: {
          dashboard: {
            user_id: userResult.rows[0].id,
            username:
              userResult.rows[0].username,
            password: dashboardPassword,
          },

          web_app: {
            guard_id: guardResult.rows[0].id,
            username:
              guardResult.rows[0].username,
            password: guardPassword,
          },
        },
      });
    } catch (err) {
      await client
        .query("ROLLBACK")
        .catch(() => {});

      console.error(
        "Temporary access creation error:",
        err
      );

      if (err.code === "23505") {
        return res.status(409).json({
          status: "error",
          message:
            "A temporary username already exists",
        });
      }

      if (err.code === "SUPERVISOR_ROLE_UNAVAILABLE") {
        return res.status(503).json({
          status: "error",
          code: "SUPERVISOR_ROLE_UNAVAILABLE",
          message:
            "Temporary access cannot be created because the Supervisor role is unavailable",
        });
      }

      return res.status(500).json({
        status: "error",
        message:
          "Unable to create temporary access",
      });
    } finally {
      client.release();
    }
  }
);

app.post(
  "/admin/temporary-access/:groupId/revoke",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      if (!req.auth.is_system_owner) {
        return res.status(403).json({
          status: "error",
          message:
            "Only the system owner can revoke temporary access",
        });
      }

      const { groupId } = req.params;

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          groupId
        )
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "Invalid temporary access group id",
        });
      }

      await client.query("BEGIN");

      const usersResult = await client.query(
        `
        UPDATE users
        SET
          status = 'inactive',
          temporary_access_revoked_at = NOW(),
          temporary_access_expiry_reason = 'manual_revoked',
          updated_at = NOW()
        WHERE temporary_access_group_id = $1
          AND access_mode = $2
        RETURNING id
        `,
        [groupId, ACCESS_MODE_READ_ONLY]
      );

      const guardsResult = await client.query(
        `
        UPDATE guards
        SET
          active = false,
          temporary_access_revoked_at = NOW(),
          temporary_access_expiry_reason = 'manual_revoked'
        WHERE temporary_access_group_id = $1
          AND access_mode = $2
        RETURNING id
        `,
        [groupId, ACCESS_MODE_READ_ONLY]
      );

      if (
        usersResult.rows.length === 0 &&
        guardsResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          status: "error",
          message:
            "Temporary access was not found",
        });
      }

      if (usersResult.rows.length > 0) {
        await client.query(
          `
                    UPDATE admin_sessions AS ads
          SET
            is_active = false,
            logout_time = COALESCE(
              ads.logout_time,
              CASE
                WHEN
                  u.access_expires_at IS NOT NULL
                  AND u.access_expires_at <= NOW()
                THEN u.access_expires_at
                ELSE NOW()
              END
            ),
            session_duration_seconds = COALESCE(
              ads.session_duration_seconds,
              GREATEST(
                0,
                EXTRACT(
                  EPOCH FROM (
                    CASE
                      WHEN
                        u.access_expires_at IS NOT NULL
                        AND u.access_expires_at <= NOW()
                      THEN u.access_expires_at
                      ELSE NOW()
                    END
                    - ads.login_time
                  )
                )::int
              )
            ),
            session_end_reason =
              CASE
                WHEN
                  u.access_expires_at IS NOT NULL
                  AND u.access_expires_at <= NOW()
                THEN 'temporary_access_expired'
                ELSE 'temporary_access_revoked'
              END
          FROM users u
          WHERE ads.user_id = ANY($1::int[])
            AND u.id = ads.user_id
            AND ads.is_active = true
          `,
          [
            usersResult.rows.map(
              (row) => row.id
            ),
          ]
        );
      }

      if (guardsResult.rows.length > 0) {
        await client.query(
          `
          UPDATE guard_sessions
          SET
            logout_time = NOW(),
            last_heartbeat = NOW(),
            status =
              'temporary_access_revoked'
          WHERE guard_id = ANY($1::int[])
            AND logout_time IS NULL
          `,
          [
            guardsResult.rows.map(
              (row) => row.id
            ),
          ]
        );
      }

      await client.query("COMMIT");

      return res.json({
        status: "ok",
        message:
          "Temporary access revoked",
        group_id: groupId,
      });
    } catch (err) {
      await client
        .query("ROLLBACK")
        .catch(() => {});

      console.error(
        "Temporary access revoke error:",
        err
      );

      return res.status(500).json({
        status: "error",
        message:
          "Unable to revoke temporary access",
      });
    } finally {
      client.release();
    }
  }
);

// ----------------------------------------------------------
// USER PASSWORD MANAGEMENT
// ----------------------------------------------------------

app.put("/admin/users/:id/reset-password", requireAuth, async (req, res) => {
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
      companyId,
      error
    } = resolveAdminUsersCompanyScope(req);

    if (error) {
      return res.status(400).json({
        status: "error",
        message: error
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

    const result = await resetDashboardUserPassword({
      pool,
      userId,
      companyId,
      actorUserId: req.auth.user_id,
      actorIsSystemOwner: req.auth.is_system_owner,
      passwordHash,
      invalidateUser: dashboardRbac.invalidateUser,
    });

    return res.json({
      status: "ok",
      message: "Password reset successfully",
      temporary_password: temporaryPassword,
      revoked_session_count: result.revokedSessionCount,
      user: result.user
    });
  } catch (err) {
    console.error("User reset password error:", err);

    return res.status(err.statusCode || 500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/auth/change-password", requireAuth, async (req, res) => {
  try {
    const authenticatedUserId = Number(req.auth.user_id);
    const { current_password, new_password } = req.body;

    const user = await changeDashboardPassword({
      pool,
      bcrypt,
      userId: authenticatedUserId,
      currentPassword: current_password,
      newPassword: new_password,
      invalidateUser: dashboardRbac.invalidateUser,
    });

    return res.json({
      status: "ok",
      message: "Password changed successfully",
      user,
    });
  } catch (err) {
    console.error("Change password error:", err);

    return res.status(err.statusCode || 500).json({
      status: "error",
      message: err.statusCode ? err.message : "Unable to change password",
    });
  }
});

function pad2(value) {
  return String(value).padStart(2, "0");
}

const SHIFT_LOGIN_GRACE_MINUTES = 15;

function parseTimeToMinutes(value) {
  if (!value || !value.includes(":")) return null;

  const [hour, minute] = value.split(":").map(Number);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return hour * 60 + minute;
}

function shiftDatePlusDays(year, month, day, offsetDays) {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + offsetDays);

  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function toPgTimestamp(dateParts, timeValue) {
  const [hour, minute] = timeValue.split(":").map(Number);

  return `${dateParts.year}-${pad2(dateParts.month)}-${pad2(dateParts.day)} ${pad2(hour)}:${pad2(minute)}:00`;
}

function getAthensDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => Number(parts.find((p) => p.type === type).value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function getScheduledShiftFromRules(shiftRules, date = new Date()) {
  const rules =
    typeof shiftRules === "string" ? JSON.parse(shiftRules || "{}") : shiftRules;

  const shifts = Array.isArray(rules?.shifts) ? rules.shifts : [];

  if (shifts.length === 0) return null;

  const { year, month, day, hour, minute } = getAthensDateParts(date);
  const currentMinutes = hour * 60 + minute;

  const today = { year, month, day };
  const yesterday = shiftDatePlusDays(year, month, day, -1);
  const tomorrow = shiftDatePlusDays(year, month, day, 1);

  // A login made during the handover window belongs to the upcoming shift,
  // even while the previous shift is still in progress.
  const upcomingShift = shifts
    .map((shift) => {
      const startMinutes = parseTimeToMinutes(shift.start);
      const endMinutes = parseTimeToMinutes(shift.end);

      if (
        startMinutes === null ||
        endMinutes === null ||
        startMinutes === endMinutes
      ) {
        return null;
      }

      const minutesUntilStart =
        (startMinutes - currentMinutes + 1440) % 1440;

      if (minutesUntilStart > SHIFT_LOGIN_GRACE_MINUTES) {
        return null;
      }

      const startDate =
        startMinutes < currentMinutes && minutesUntilStart > 0
          ? tomorrow
          : today;
      const endDate =
        startMinutes > endMinutes
          ? shiftDatePlusDays(
              startDate.year,
              startDate.month,
              startDate.day,
              1
            )
          : startDate;

      return {
        minutesUntilStart,
        start: toPgTimestamp(startDate, shift.start),
        end: toPgTimestamp(endDate, shift.end),
        label: `${shift.start}–${shift.end}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.minutesUntilStart - b.minutesUntilStart)[0];

  if (upcomingShift) {
    return {
      start: upcomingShift.start,
      end: upcomingShift.end,
      label: upcomingShift.label,
    };
  }

  for (const shift of shifts) {
    const startMinutes = parseTimeToMinutes(shift.start);
    const endMinutes = parseTimeToMinutes(shift.end);

    if (startMinutes === null || endMinutes === null) continue;

    const label = `${shift.start}–${shift.end}`;

    // Same-day shift, e.g. 07:00–15:00
    if (startMinutes < endMinutes) {
      if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
        return {
          start: toPgTimestamp(today, shift.start),
          end: toPgTimestamp(today, shift.end),
          label,
        };
      }
    }

    // Overnight shift, e.g. 23:00–07:00
    if (startMinutes > endMinutes) {
      if (currentMinutes >= startMinutes) {
        return {
          start: toPgTimestamp(today, shift.start),
          end: toPgTimestamp(tomorrow, shift.end),
          label,
        };
      }

      if (currentMinutes < endMinutes) {
        return {
          start: toPgTimestamp(yesterday, shift.start),
          end: toPgTimestamp(today, shift.end),
          label,
        };
      }
    }
  }

  return null;
}

async function generateScheduledShiftsForSite(siteId, targetDate) {
  const siteResult = await pool.query(
    `
    SELECT id, shift_rules
    FROM sites
    WHERE id = $1
    `,
    [siteId]
  );

  if (siteResult.rows.length === 0) {
    throw new Error("Site not found");
  }

  const site = siteResult.rows[0];
  const rules =
    typeof site.shift_rules === "string"
      ? JSON.parse(site.shift_rules || "{}")
      : site.shift_rules;

  const shifts = Array.isArray(rules?.shifts) ? rules.shifts : [];

  if (shifts.length === 0) {
    return [];
  }

  const created = [];

  const [year, month, day] = targetDate.split("-").map(Number);
  const dateParts = { year, month, day };
  const nextDay = shiftDatePlusDays(year, month, day, 1);

  for (const shift of shifts) {
    if (!shift.start || !shift.end) continue;

    const startMinutes = parseTimeToMinutes(shift.start);
    const endMinutes = parseTimeToMinutes(shift.end);

    if (startMinutes === null || endMinutes === null) continue;

    const scheduledStart = toPgTimestamp(dateParts, shift.start);
    const scheduledEnd =
      startMinutes > endMinutes
        ? toPgTimestamp(nextDay, shift.end)
        : toPgTimestamp(dateParts, shift.end);

    const shiftLabel = `${shift.start}–${shift.end}`;

    const result = await pool.query(
      `
      INSERT INTO scheduled_shifts (
        site_id,
        scheduled_start,
        scheduled_end,
        shift_label,
        status,
        created_at,
        updated_at
      )
      SELECT $1, $2::timestamp, $3::timestamp, $4, 'scheduled', (NOW() AT TIME ZONE 'Europe/Athens'), (NOW() AT TIME ZONE 'Europe/Athens')
      WHERE NOT EXISTS (
        SELECT 1
        FROM scheduled_shifts
        WHERE site_id = $1
          AND scheduled_start = $2
          AND scheduled_end = $3
      )
      RETURNING *
      `,
      [siteId, scheduledStart, scheduledEnd, shiftLabel]
    );

    if (result.rows.length > 0) {
      created.push(result.rows[0]);
    }
  }

  return created;
}

async function generateScheduledShiftsForAllSites(targetDate) {
  const sites = await pool.query(`
    SELECT id
    FROM sites
  `);

  console.log("[SHIFT GENERATOR] Found", sites.rows.length, "sites");

  const created = [];

  for (const site of sites.rows) {
    console.log("[SHIFT GENERATOR] Processing site", site.id);

    const result = await generateScheduledShiftsForSite(site.id, targetDate);

    console.log(
      "[SHIFT GENERATOR] Site",
      site.id,
      "created",
      result.length,
      "shifts"
    );

    created.push(...result);
  }

  return created;
}

function startScheduledShiftGenerator() {
  const runGenerator = async () => {
    try {
      const athensToday = getAthensDateParts(new Date());
      const targetDates = [-1, 0, 1].map((offset) => {
        const dateParts = shiftDatePlusDays(
          athensToday.year,
          athensToday.month,
          athensToday.day,
          offset
        );

        return `${dateParts.year}-${pad2(dateParts.month)}-${pad2(dateParts.day)}`;
      });

      console.log("[SHIFT GENERATOR] Running for", targetDates.join(", "));

      const created = [];

      for (const targetDate of targetDates) {
        created.push(
          ...(await generateScheduledShiftsForAllSites(targetDate))
        );
      }

      console.log(
        "[SHIFT GENERATOR] Created",
        created.length,
        "scheduled shifts"
      );

    } catch (err) {
  console.error("[SHIFT GENERATOR ERROR]", err.message);

      if (err.stack) {
        console.error(err.stack);
      }
    }
  };

  setTimeout(runGenerator, 0);
  setInterval(runGenerator, 60000);
}

async function detectShiftDelayEvents() {
  const result = await pool.query(`
    INSERT INTO operational_events (
      site_id,
      scheduled_shift_id,
      guard_id,
      guard_session_id,
      event_type,
      event_status,
      severity,
      title,
      description,
      detected_at,
      created_at,
      updated_at,
      email_status
    )
    SELECT
      ss.site_id,
      ss.id,
      NULL,
      NULL,
      'SHIFT_DELAY',
      'open',
      'high',
      'Shift Delay - No Guard Login',
      'No guard login detected within 15 minutes of the scheduled shift start.',
      NOW(),
      NOW(),
      NOW(),
      'pending'
    FROM scheduled_shifts ss
    WHERE ss.scheduled_start + INTERVAL '15 minutes'
          <= (NOW() AT TIME ZONE 'Europe/Athens')

      AND ss.scheduled_end >
          (NOW() AT TIME ZONE 'Europe/Athens')

      AND NOT EXISTS (
  SELECT 1
  FROM guard_sessions gs
  JOIN guards operational_guard
    ON operational_guard.id = gs.guard_id
  WHERE gs.site_id = ss.site_id
    AND operational_guard.access_mode = 'standard'
    AND gs.login_time >= ss.scheduled_start - INTERVAL '15 minutes'
    AND gs.login_time <= ss.scheduled_start + INTERVAL '15 minutes'
    AND gs.scheduled_shift_start = ss.scheduled_start
    AND gs.scheduled_shift_end = ss.scheduled_end
    AND COALESCE(gs.logout_time, ss.scheduled_start + INTERVAL '15 minutes')
        >= ss.scheduled_start + INTERVAL '15 minutes'
)

      AND NOT EXISTS (
        SELECT 1
        FROM operational_events oe
        WHERE oe.scheduled_shift_id = ss.id
          AND oe.event_type = 'SHIFT_DELAY'
          AND oe.event_status = 'open'
      )

    RETURNING
      id,
      site_id,
      scheduled_shift_id,
      event_type,
      event_status,
      detected_at
  `);

  if (result.rows.length > 0) {
    console.log(
      "[SHIFT DELAY] Created",
      result.rows.length,
      "operational event(s)"
    );

    console.log("[SHIFT DELAY EVENTS]", result.rows);
  }

  return result.rows;
}

function startShiftDelayMonitor() {
  const runMonitor = async () => {
    try {
      await expireGuardSessionsPastShiftGrace();
      await detectShiftDelayEvents();
      await processPendingShiftDelayEmails();
    } catch (err) {
      console.error…47596 tokens truncated…active_sessions.scheduled_shift_start
            AND e.scheduled_at < active_sessions.scheduled_shift_end
          )
        )

      WHERE (NOW() AT TIME ZONE e.timezone) >= e.reminder_at
        AND (NOW() AT TIME ZONE e.timezone) < e.scheduled_at

        AND NOT EXISTS (
          SELECT 1
          FROM patrol_logs pl
          WHERE pl.site_id = e.site_id
            AND pl.point_id = e.point_id
            AND COALESCE(pl.schedule_type, e.schedule_type) = e.schedule_type
            AND (
              e.schedule_type = 'manual'
              AND pl.schedule_id = e.schedule_id
              OR
              e.schedule_type = 'recurring'
              AND pl.scheduled_at = e.scheduled_at
              OR
              e.schedule_type = 'random'
              AND pl.random_occurrence_id = e.schedule_id
            )
        )

      ORDER BY e.scheduled_at ASC, e.point_id ASC
      `
    );

    duePatrols = dueSoonResult.rows.length;

    for (const patrol of dueSoonResult.rows) {
      const deliveryResult = await sendPatrolReminderPushIfNeeded({
        guardId: Number(patrol.guard_id),
        sessionId: Number(patrol.session_id),
        siteId: Number(patrol.site_id),
        scheduleId: Number(patrol.schedule_id),
        scheduleType: patrol.schedule_type,
        scheduledAt: patrol.scheduled_at,
        checkpoint: patrol.checkpoint,
        siteName: patrol.site_name,
        reminderAt: patrol.reminder_at,
      });
      if (deliveryResult.status === "sent" || deliveryResult.status === "already_sent") {
        delivered += 1;
      } else {
        failed += 1;
      }
    }

    await systemStatusService.recordPatrolSchedulerRun({
      status: failed > 0 ? "degraded" : "operational",
      metadata: {
        due_patrols: duePatrols,
        delivered,
        failed,
        duration_ms: Date.now() - runStartedAt,
      },
    });
  } catch (err) {
    console.error("Patrol push scheduler error:", err);
    await systemStatusService
      .recordPatrolSchedulerRun({
        status: "offline",
        error: err,
        metadata: {
          due_patrols: duePatrols,
          delivered,
          failed,
          duration_ms: Date.now() - runStartedAt,
        },
      })
      .catch((telemetryError) =>
        console.error("Patrol scheduler telemetry error:", telemetryError)
      );
  } finally {
    patrolPushSchedulerRunning = false;
  }
}

app.post("/push/test", requireGuardAuth, async (req, res) => {
  try {
    const {
      guard_id: guardId,
      session_id: sessionId,
      site_id: siteId,
    } = req.guard;

    const payload = {
      title: "Aegis Link",
      body: "Test Push Notification",
      url: "patrol.html",
    };

    const result = await sendPushNotificationToGuard({
      guardId,
      sessionId,
      siteId,
      payload,
      ttlSeconds: 60,
    });

    res.json({
      status: "ok",
      result,
    });
  } catch (err) {
    console.error("Push test error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.post("/patrol/scan", requireGuardAuth, async (req, res) => {
  try {
    const {
      schedule_id,
      schedule_type,
      qr_token,
      latitude,
      longitude,
      accuracy,
    } = req.body;

    const normalizedScheduleId = Number(schedule_id);
    const normalizedScheduleType = String(schedule_type || "").toLowerCase();
    const normalizedQrToken =
      typeof qr_token === "string" ? qr_token.trim() : "";

    if (
      !Number.isInteger(normalizedScheduleId) ||
      normalizedScheduleId <= 0 ||
      !normalizedQrToken
    ) {
      return res.status(400).json({
        status: "error",
        message: "A valid schedule_id and qr_token are required",
      });
    }

    const guardId = req.guard.guard_id;
    const sessionId = req.guard.session_id;
    const siteId = req.guard.site_id;
    const companyId = req.guard.company_id;
    const scheduledShiftStart = req.guard.scheduled_shift_start;
    const scheduledShiftEnd = req.guard.scheduled_shift_end;
    const companyTimezone = await getCompanyTimezone(companyId);

    const patrolResult = normalizedScheduleType === "random"
      ? await pool.query(
        `
        SELECT
          rpo.id AS schedule_id,
          'random' AS schedule_type,
          rpo.site_id,
          rpo.patrol_point_id AS point_id,
          pp.point_name,
          pp.qr_token,
          pp.active AS point_active,
          ${PATROL_TIMING.revealMinutesBefore}::int AS reminder_minutes_before,
          rpo.scheduled_at
        FROM random_patrol_occurrences rpo
        INNER JOIN random_patrol_days rpd ON rpd.id = rpo.random_patrol_day_id
        INNER JOIN patrol_points pp ON pp.id = rpo.patrol_point_id
        INNER JOIN sites s ON s.id = rpo.site_id
        WHERE rpo.id = $1
          AND rpo.site_id = $2
          AND rpo.company_id = $3
          AND rpd.company_id = $3
          AND s.company_id = $3
          AND pp.active = TRUE
        LIMIT 1
        `,
        [normalizedScheduleId, siteId, companyId]
      )
      : await pool.query(
        `
      SELECT
        ps.id AS schedule_id,
        ps.schedule_type,
        ps.site_id,
        ps.patrol_point_id AS point_id,
        pp.point_name,
        pp.qr_token,
        pp.active AS point_active,
        ps.reminder_minutes_before

      FROM patrol_schedules ps

      JOIN patrol_points pp
        ON pp.id = ps.patrol_point_id

      JOIN sites s
        ON s.id = ps.site_id

      WHERE ps.id = $1
        AND ps.site_id = $2
        AND s.company_id = $3
        AND ps.active = true
        AND pp.active = true
      LIMIT 1
        `,
        [normalizedScheduleId, siteId, companyId]
      );

    if (patrolResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Scheduled patrol not found or inactive",
      });
    }

    const patrol = patrolResult.rows[0];

    if (String(patrol.qr_token) !== normalizedQrToken) {
      return res.status(403).json({
        status: "error",
        message: "QR token does not match this patrol checkpoint",
      });
    }

    const windowResult = patrol.schedule_type === "random"
      ? await pool.query(
        `
        WITH occurrence_window AS (
          SELECT
            $1::timestamp AS scheduled_at,
            (NOW() AT TIME ZONE $2::text) AS local_now,
            $3::timestamp AS scheduled_shift_start,
            $4::timestamp AS scheduled_shift_end,
            (
              $3::timestamp IS NOT NULL
              AND $4::timestamp IS NOT NULL
              AND $4::timestamp > $3::timestamp
            ) AS has_scheduled_shift
        )
        SELECT
          scheduled_at,
          scheduled_at - INTERVAL '${PATROL_TIMING.scanOpenMinutesBefore} minutes' AS scan_available_from,
          CASE
            WHEN has_scheduled_shift
              THEN LEAST(
                scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes',
                scheduled_shift_end
              )
            ELSE scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes'
          END AS scan_available_until,
          local_now,
          CASE
            WHEN local_now < scheduled_at - INTERVAL '${PATROL_TIMING.scanOpenMinutesBefore} minutes' THEN 'scheduled'
            WHEN local_now >= CASE
              WHEN has_scheduled_shift
                THEN LEAST(
                  scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes',
                  scheduled_shift_end
                )
              ELSE scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes'
            END THEN 'missed'
            WHEN local_now < scheduled_at THEN 'due_soon'
            ELSE 'overdue'
          END AS current_status,
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (local_now - scheduled_at)) / 60))::int AS delay_minutes
        FROM occurrence_window
        WHERE NOT has_scheduled_shift
          OR (
            scheduled_at >= scheduled_shift_start
            AND scheduled_at < scheduled_shift_end
          )
        `,
        [
          patrol.scheduled_at,
          companyTimezone,
          scheduledShiftStart,
          scheduledShiftEnd,
        ]
      )
      : await pool.query(
        `
      WITH schedule_context AS (
        SELECT
          ps.schedule_type,
          ps.scheduled_date,
          ps.scheduled_time,
          ps.interval_hours,
          ps.start_time,
          (NOW() AT TIME ZONE $2::text) AS local_now,
          $4::timestamp AS scheduled_shift_start,
          $5::timestamp AS scheduled_shift_end,
          (
            $4::timestamp IS NOT NULL
            AND $5::timestamp IS NOT NULL
            AND $5::timestamp > $4::timestamp
          ) AS has_scheduled_shift,
          (
            (ps.created_at AT TIME ZONE $2::text)::date
            + ps.start_time
          ) AS anchor_time
        FROM patrol_schedules ps
        WHERE ps.id = $1
          AND ps.site_id = $3
          AND ps.active = true
      ),

      recurring_index AS (
        SELECT
          sc.*,
          FLOOR(
            EXTRACT(EPOCH FROM (sc.local_now - sc.anchor_time))
            / (sc.interval_hours * 3600)
          )::bigint AS base_index
        FROM schedule_context sc
        WHERE sc.schedule_type = 'recurring'
          AND sc.start_time IS NOT NULL
          AND sc.interval_hours IS NOT NULL
          AND sc.interval_hours > 0
      ),

      candidate_occurrences AS (
        SELECT
          (sc.scheduled_date::timestamp + sc.scheduled_time) AS scheduled_at,
          sc.local_now,
          sc.scheduled_shift_start,
          sc.scheduled_shift_end,
          sc.has_scheduled_shift
        FROM schedule_context sc
        WHERE sc.schedule_type = 'manual'
          AND sc.scheduled_date IS NOT NULL
          AND sc.scheduled_time IS NOT NULL

        UNION ALL

        SELECT
          (
            ri.anchor_time
            + (candidate_index * ri.interval_hours) * INTERVAL '1 hour'
          ) AS scheduled_at,
          ri.local_now,
          ri.scheduled_shift_start,
          ri.scheduled_shift_end,
          ri.has_scheduled_shift
        FROM recurring_index ri
        CROSS JOIN LATERAL generate_series(
          GREATEST(ri.base_index, 0),
          GREATEST(ri.base_index + 1, 0)
        ) AS candidate(candidate_index)
      ),

      occurrence_windows AS (
        SELECT
          scheduled_at,
          (
            scheduled_at - INTERVAL '${PATROL_TIMING.scanOpenMinutesBefore} minutes'
          ) AS scan_available_from,
          CASE
            WHEN has_scheduled_shift
              THEN LEAST(
                scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes',
                scheduled_shift_end
              )
            ELSE scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes'
          END AS scan_available_until,
          CASE
            WHEN has_scheduled_shift
              THEN LEAST(
                scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes',
                scheduled_shift_end
              )
            ELSE scheduled_at + INTERVAL '${PATROL_TIMING.missedAfterMinutes} minutes'
          END AS missed_at,
          local_now,
          scheduled_shift_start,
          scheduled_shift_end,
          has_scheduled_shift
        FROM candidate_occurrences
      )

      SELECT
        scheduled_at,
        scan_available_from,
        scan_available_until,
        local_now,
        CASE
          WHEN local_now < scan_available_from THEN 'scheduled'
          WHEN local_now >= missed_at THEN 'missed'
          WHEN local_now < scheduled_at THEN 'due_soon'
          ELSE 'overdue'
        END AS current_status,
        GREATEST(
          0,
          FLOOR(
            EXTRACT(EPOCH FROM (local_now - scheduled_at)) / 60
          )
        )::int AS delay_minutes
      FROM occurrence_windows
      WHERE NOT has_scheduled_shift
        OR (
          scheduled_at >= scheduled_shift_start
          AND scheduled_at < scheduled_shift_end
        )
      ORDER BY
        CASE
          WHEN local_now >= scan_available_from
            AND local_now < missed_at
            THEN 0
          ELSE 1
        END,
        ABS(EXTRACT(EPOCH FROM (local_now - scheduled_at))) ASC
      LIMIT 1
        `,
        [
          normalizedScheduleId,
          companyTimezone,
          siteId,
          scheduledShiftStart,
          scheduledShiftEnd,
        ]
      );

    if (windowResult.rows.length === 0) {
      return res.status(409).json({
        status: "error",
        message: "No valid patrol occurrence could be resolved",
        scan_enabled: false,
      });
    }

    const scanWindow = windowResult.rows[0];

    if (scanWindow.current_status === "scheduled") {
      return res.status(403).json({
        status: "error",
        message: "Scan not allowed yet",
        current_status: "scheduled",
        scan_enabled: false,
        scan_available_from: scanWindow.scan_available_from,
        scan_available_until: scanWindow.scan_available_until,
      });
    }

    if (scanWindow.current_status === "missed") {
      return res.status(409).json({
        status: "error",
        message: "Patrol missed",
        current_status: "missed",
        scan_enabled: false,
        scan_available_from: scanWindow.scan_available_from,
        scan_available_until: scanWindow.scan_available_until,
      });
    }

    const duplicateResult = await pool.query(
      `
      SELECT id
      FROM patrol_logs
      WHERE site_id = $1
        AND point_id = $2
        AND (
          ($4 = 'random' AND random_occurrence_id = $3)
          OR
          ($4 <> 'random' AND schedule_id = $3 AND schedule_type = $4 AND scheduled_at = $5::timestamp)
        )
      LIMIT 1
      `,
      [
        patrol.site_id,
        patrol.point_id,
        normalizedScheduleId,
        patrol.schedule_type,
        scanWindow.scheduled_at,
      ]
    );

    if (duplicateResult.rows.length > 0) {
      return res.status(409).json({
        status: "error",
        message: "This patrol has already been completed",
        patrol_log_id: duplicateResult.rows[0].id,
      });
    }

    const insertResult = await pool.query(
      `
      INSERT INTO patrol_logs (
        site_id,
        point_id,
        guard_id,
        session_id,
        qr_token,
        latitude,
        longitude,
        accuracy,
        patrol_time,
        scheduled_at,
        delay_minutes,
        completion_status,
        was_missed,
        schedule_id,
        schedule_type,
        random_occurrence_id,
        scan_available_from,
        scan_available_until
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        NOW(),
        $9,$10,
        CASE
          WHEN (NOW() AT TIME ZONE $16::text) > $9::timestamp + INTERVAL '${PATROL_TIMING.completedGraceMinutes} minutes'
            THEN 'completed_late'
          ELSE 'completed'
        END,
        false,
        $11,$12,$13,$14,$15
      )
      RETURNING *
      `,
      [
        patrol.site_id,
        patrol.point_id,
        guardId,
        sessionId,
        normalizedQrToken,
        latitude || null,
        longitude || null,
        accuracy || null,
        scanWindow.scheduled_at,
        scanWindow.delay_minutes,
        patrol.schedule_type === "random" ? null : normalizedScheduleId,
        patrol.schedule_type,
        patrol.schedule_type === "random" ? normalizedScheduleId : null,
        scanWindow.scan_available_from,
        scanWindow.scan_available_until,
        companyTimezone,
      ]
    );

    if (patrol.schedule_type === "manual") {
      await pool.query(
        `
        UPDATE patrol_schedules
        SET
          active = false,
          manual_status = 'completed'
        WHERE id = $1
          AND schedule_type = 'manual'
        `,
        [normalizedScheduleId]
      );
    }

    res.json({
      status: "ok",
      message: "Patrol completed successfully",
      patrol: insertResult.rows[0],
      checkpoint: {
        id: patrol.point_id,
        name: patrol.point_name,
      },
      scan_window: {
        scheduled_at: scanWindow.scheduled_at,
        scan_available_from: scanWindow.scan_available_from,
        scan_available_until: scanWindow.scan_available_until,
      },
    });
  } catch (err) {
    console.error("Patrol scan error:", err);

    if (
      err.code === "23505" &&
      ["patrol_logs_occurrence_unique_idx", "patrol_logs_random_occurrence_unique_idx"].includes(err.constraint)
    ) {
      return res.status(409).json({
        status: "error",
        message: "This patrol has already been completed",
      });
    }

    res.status(500).json({
      status: "error",
      message: "Failed to complete patrol scan",
      detail: err.message,
    });
  }
});

app.post(
  "/settings/sites/:siteId/patrol-points",
  requireAuth,
  async (req, res) => {
    try {
      const siteId = Number(req.params.siteId);
      const isSystemOwner = req.auth.role === "system_owner";

      const {
        point_name,
        point_description,
        expected_interval_minutes,
      } = req.body;

      const normalizedPointName =
        typeof point_name === "string" ? point_name.trim() : "";

      const normalizedPointDescription =
        typeof point_description === "string"
          ? point_description.trim()
          : "";

      if (!Number.isInteger(siteId) || siteId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid site ID",
        });
      }

      if (!normalizedPointName) {
        return res.status(400).json({
          status: "error",
          message: "point_name is required",
        });
      }

      let normalizedInterval = null;

      if (
        expected_interval_minutes !== undefined &&
        expected_interval_minutes !== null &&
        expected_interval_minutes !== ""
      ) {
        normalizedInterval = Number(expected_interval_minutes);

        if (
          !Number.isInteger(normalizedInterval) ||
          normalizedInterval <= 0
        ) {
          return res.status(400).json({
            status: "error",
            message:
              "expected_interval_minutes must be a positive integer",
          });
        }
      }

      const siteResult = await pool.query(
        `
        SELECT id
        FROM sites
        WHERE id = $1
          AND (
            $2::boolean = true
            OR company_id = $3
          )
        `,
        [
          siteId,
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      if (siteResult.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Site not found",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO patrol_points (
          site_id,
          point_name,
          point_description,
          expected_interval_minutes,
          active,
          created_at
        )
        VALUES ($1,$2,$3,$4,true,NOW())
        RETURNING *
        `,
        [
          siteId,
          normalizedPointName,
          normalizedPointDescription || null,
          normalizedInterval,
        ]
      );

      return res.status(201).json({
        status: "ok",
        point: result.rows[0],
      });
    } catch (err) {
      console.error("Create patrol point error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to create patrol point",
      });
    }
  }
);

app.put(
  "/settings/patrol-points/:id/deactivate",
  requireAuth,
  async (req, res) => {
    try {
      const pointId = Number(req.params.id);
      const isSystemOwner = req.auth.role === "system_owner";

      if (!Number.isInteger(pointId) || pointId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid patrol point ID",
        });
      }

      const result = await pool.query(
        `
        UPDATE patrol_points pp
        SET active = false
        FROM sites s
        WHERE pp.id = $1
          AND s.id = pp.site_id
          AND (
            $2::boolean = true
            OR s.company_id = $3
          )
        RETURNING pp.*
        `,
        [
          pointId,
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Patrol point not found",
        });
      }

      return res.json({
        status: "ok",
        point: result.rows[0],
      });
    } catch (err) {
      console.error("Deactivate patrol point error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to deactivate patrol point",
      });
    }
  }
);

app.post(
  "/settings/patrol-points/:id/generate-qr",
  requireAuth,
  async (req, res) => {
    try {
      const pointId = Number(req.params.id);
      const isSystemOwner = req.auth.role === "system_owner";

      if (!Number.isInteger(pointId) || pointId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid patrol point ID",
        });
      }

      const qrToken = crypto.randomUUID();

      const result = await pool.query(
        `
        UPDATE patrol_points pp
        SET qr_token = $1
        FROM sites s
        WHERE pp.id = $2
          AND s.id = pp.site_id
          AND (
            $3::boolean = true
            OR s.company_id = $4
          )
        RETURNING pp.*
        `,
        [
          qrToken,
          pointId,
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Patrol point not found",
        });
      }

      return res.json({
        status: "ok",
        point: result.rows[0],
      });
    } catch (err) {
      console.error("Generate QR error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to generate QR token",
      });
    }
  }
);

app.put(
  "/settings/patrol-points/:id/schedule",
  requireAuth,
  async (req, res) => {
    try {
      const pointId = Number(req.params.id);
      const isSystemOwner = req.auth.role === "system_owner";

      const normalizedInterval = Number(
        req.body.expected_interval_minutes
      );

      if (!Number.isInteger(pointId) || pointId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid patrol point ID",
        });
      }

      if (
        !Number.isInteger(normalizedInterval) ||
        normalizedInterval <= 0
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "expected_interval_minutes must be a positive integer",
        });
      }

      const result = await pool.query(
        `
        UPDATE patrol_points pp
        SET expected_interval_minutes = $1
        FROM sites s
        WHERE pp.id = $2
          AND s.id = pp.site_id
          AND (
            $3::boolean = true
            OR s.company_id = $4
          )
        RETURNING pp.*
        `,
        [
          normalizedInterval,
          pointId,
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Patrol point not found",
        });
      }

      return res.json({
        status: "ok",
        point: result.rows[0],
      });
    } catch (err) {
      console.error("Update patrol schedule error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to update patrol schedule",
      });
    }
  }
);

app.post(
  "/settings/sites/:siteId/patrol-schedules/manual",
  requireAuth,
  async (req, res) => {
    try {
      const siteId = Number(req.params.siteId);
      const isSystemOwner = req.auth.role === "system_owner";

      const {
        scheduled_date,
        scheduled_time,
        reminder_minutes_before = 5,
      } = req.body;

      if (!Number.isInteger(siteId) || siteId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid site ID",
        });
      }

      if (!scheduled_date || !scheduled_time) {
        return res.status(400).json({
          status: "error",
          message: "scheduled_date and scheduled_time are required",
        });
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) {
        return res.status(400).json({
          status: "error",
          message: "scheduled_date must be in YYYY-MM-DD format",
        });
      }

      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduled_time)) {
        return res.status(400).json({
          status: "error",
          message: "scheduled_time must be in HH:mm format",
        });
      }

      const normalizedReminder = Number(reminder_minutes_before);

      if (
        !Number.isInteger(normalizedReminder) ||
        normalizedReminder < 0
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "reminder_minutes_before must be a non-negative integer",
        });
      }

      const siteResult = await pool.query(
        `
        SELECT id
        FROM sites
        WHERE id = $1
          AND (
            $2::boolean = true
            OR company_id = $3
          )
        `,
        [
          siteId,
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      if (siteResult.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Site not found",
        });
      }

      const pointsResult = await pool.query(
        `
        SELECT id
        FROM patrol_points
        WHERE site_id = $1
          AND active = true
        ORDER BY id ASC
        `,
        [siteId]
      );

      if (pointsResult.rows.length === 0) {
        return res.status(400).json({
          status: "error",
          message: "No active patrol points found for this site",
        });
      }

      const inserted = [];

      for (const point of pointsResult.rows) {
        const result = await pool.query(
          `
          INSERT INTO patrol_schedules (
            site_id,
            patrol_point_id,
            schedule_type,
            scheduled_date,
            scheduled_time,
            reminder_minutes_before,
            active,
            created_at,
            created_by_admin_id,
            created_by_username,
            created_by_role,
            manual_status
          )
          VALUES ($1,$2,'manual',$3,$4,$5,true,NOW(),$6,$7,$8,'pending')
          RETURNING *
          `,
          [
            siteId,
            point.id,
            scheduled_date,
            scheduled_time,
            normalizedReminder,
            req.auth.user_id,
            req.auth.username,
            req.auth.role,
          ]
        );

        inserted.push(result.rows[0]);
      }

      return res.status(201).json({
        status: "ok",
        message: "Manual patrol schedule added",
        schedules: inserted,
      });
    } catch (err) {
      console.error("Manual patrol schedule error:", err);

      return res.status(500).json({
        status: "error",
        message: "Failed to add manual patrol schedule",
      });
    }
  }
);

app.post(
  "/settings/sites/:siteId/patrol-schedules/recurring",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const siteId = Number(req.params.siteId);
      const isSystemOwner = req.auth.role === "system_owner";

      const {
        interval_hours,
        start_time,
        reminder_minutes_before = 5,
        schedule_scope = "24_7",
      } = req.body;

      if (!Number.isInteger(siteId) || siteId <= 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid site ID",
        });
      }

      const normalizedIntervalHours = Number(interval_hours);

      if (
        !Number.isInteger(normalizedIntervalHours) ||
        normalizedIntervalHours <= 0
      ) {
        return res.status(400).json({
          status: "error",
          message: "interval_hours must be a positive integer",
        });
      }

      if (
        typeof start_time !== "string" ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(start_time)
      ) {
        return res.status(400).json({
          status: "error",
          message: "start_time must be in HH:mm format",
        });
      }

      const normalizedReminder = Number(reminder_minutes_before);

      if (
        !Number.isInteger(normalizedReminder) ||
        normalizedReminder < 0
      ) {
        return res.status(400).json({
          status: "error",
          message:
            "reminder_minutes_before must be a non-negative integer",
        });
      }

      if (!["24_7", "custom"].includes(schedule_scope)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid schedule_scope",
        });
      }

      const siteResult = await client.query(
        `
        SELECT id
        FROM sites
        WHERE id = $1
          AND (
            $2::boolean = true
            OR company_id = $3
          )
        `,
        [
          siteId,
          isSystemOwner,
          req.auth.company_id,
        ]
      );

      if (siteResult.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Site not found",
        });
      }

      const pointsResult = await client.query(
        `
        SELECT id
        FROM patrol_points
        WHERE site_id = $1
          AND active = true
        ORDER BY id ASC
        `,
        [siteId]
      );

      if (pointsResult.rows.length === 0) {
        return res.status(400).json({
          status: "error",
          message: "No active patrol points found for this site",
        });
      }

      const intervalMinutes = normalizedIntervalHours * 60;

      await client.query("BEGIN");

      const updatePointsResult = await client.query(
        `
        UPDATE patrol_points
        SET expected_interval_minutes = $1
        WHERE site_id = $2
          AND active = true
        RETURNING
          id,
          point_name,
          expected_interval_minutes
        `,
        [
          intervalMinutes,
          siteId,
        ]
      );

      await client.query(
        `
        UPDATE patrol_schedules
        SET active = false
        WHERE site_id = $1
          AND schedule_type = 'recurring'
        `,
        [siteId]
      );

      const inserted = [];

      for (const point of pointsResult.rows) {
        const result = await client.query(
          `
          INSERT INTO patrol_schedules (
            site_id,
            patrol_point_id,
            schedule_type,
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
    COALESCE(c.timezone, 'Europe/Athens') AS timezone,
    gs.expected_slot AS scheduled_at
  FROM patrol_schedules ps

  LEFT JOIN patrol_points pp
    ON pp.id = ps.patrol_point_id
  INNER JOIN sites schedule_site ON schedule_site.id = ps.site_id
  INNER JOIN companies c ON c.id = schedule_site.company_id

  CROSS JOIN LATERAL (
  SELECT
    (
      (ps.created_at AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
      + ps.start_time
    ) AS anchor_time,

    (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date AS day_start,

    (
      (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
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
          COALESCE(c.timezone, 'Europe/Athens') AS timezone,
          (ps.scheduled_date::timestamp + ps.scheduled_time) AS scheduled_at
        FROM patrol_schedules ps

        LEFT JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
        INNER JOIN sites schedule_site ON schedule_site.id = ps.site_id
        INNER JOIN companies c ON c.id = schedule_site.company_id

        WHERE ps.schedule_type = 'manual'
  AND ps.active = true
  AND ps.scheduled_date =
      (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
      ),

      random_next AS (
        SELECT
          rpo.site_id,
          rpo.patrol_point_id AS point_id,
          pp.point_name,
          'random' AS schedule_type,
          rpd.timezone,
          rpo.scheduled_at
        FROM random_patrol_occurrences rpo
        INNER JOIN random_patrol_days rpd ON rpd.id = rpo.random_patrol_day_id
        INNER JOIN patrol_points pp ON pp.id = rpo.patrol_point_id AND pp.active = TRUE
        WHERE rpd.local_date = (NOW() AT TIME ZONE rpd.timezone)::date
          AND NOT EXISTS (
            SELECT 1 FROM patrol_logs pl WHERE pl.random_occurrence_id = rpo.id
          )
      ),

      upcoming AS (
        SELECT * FROM recurring_next
        WHERE scheduled_at IS NOT NULL

        UNION ALL

        SELECT * FROM manual_next
        WHERE scheduled_at IS NOT NULL

        UNION ALL

        SELECT * FROM random_next
        WHERE scheduled_at IS NOT NULL
      ),

      site_next AS (
  SELECT DISTINCT ON (site_id)
    site_id,
    point_id AS next_patrol_point_id,
    point_name AS next_patrol_point,
    schedule_type AS next_patrol_type,
    timezone AS next_timezone,
    scheduled_at AS next_patrol
  FROM upcoming
  WHERE
  scheduled_at >= (NOW() AT TIME ZONE timezone)
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
  WHEN u.scheduled_at + INTERVAL '2 hours' <= (NOW() AT TIME ZONE u.timezone)
    THEN 'missed'

  WHEN u.scheduled_at < (NOW() AT TIME ZONE u.timezone)
    THEN 'overdue'

  WHEN u.scheduled_at <= (NOW() AT TIME ZONE u.timezone) + INTERVAL '5 minutes'
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
  WHEN sn.next_patrol + INTERVAL '2 hours' <= (NOW() AT TIME ZONE sn.next_timezone) THEN 'missed'
WHEN sn.next_patrol < (NOW() AT TIME ZONE sn.next_timezone) THEN 'overdue'
WHEN sn.next_patrol <= (NOW() AT TIME ZONE sn.next_timezone) + INTERVAL '5 minutes' THEN 'due_soon'
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
  (qr_token IS NOT NULL) AS qr_generated,
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
    shift_owner.guard_name,
    shift_owner.guard_session_id,
    shift_owner.scheduled_shift_start,
    shift_owner.scheduled_shift_end,
    CASE
      WHEN shift_owner.scheduled_shift_end IS NOT NULL
        AND shift_owner.scheduled_shift_end
          < gs.expected_slot + INTERVAL '2 hours'
        THEN 'shift_end'
      ELSE NULL::text
    END AS missed_reason

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

  LEFT JOIN LATERAL (
    SELECT
      guard_session.id AS guard_session_id,
      guard_session.scheduled_shift_start,
      guard_session.scheduled_shift_end,
      guard.full_name AS guard_name
    FROM guard_sessions guard_session
    INNER JOIN guards guard
      ON guard.id = guard_session.guard_id
      AND guard.access_mode = 'standard'
    WHERE guard_session.site_id = ps.site_id
      AND guard_session.scheduled_shift_start IS NOT NULL
      AND guard_session.scheduled_shift_end IS NOT NULL
      AND guard_session.scheduled_shift_end
        > guard_session.scheduled_shift_start
      AND gs.expected_slot >= guard_session.scheduled_shift_start
      AND gs.expected_slot < guard_session.scheduled_shift_end
    ORDER BY guard_session.login_time DESC, guard_session.id DESC
    LIMIT 1
  ) shift_owner ON true

  WHERE ps.schedule_type = 'recurring'
    AND ps.active = true
    AND ps.start_time IS NOT NULL
    AND ps.interval_hours IS NOT NULL

    AND CASE
      WHEN shift_owner.scheduled_shift_end IS NOT NULL
        THEN LEAST(
          gs.expected_slot + INTERVAL '2 hours',
          shift_owner.scheduled_shift_end
        )
      ELSE gs.expected_slot + INTERVAL '2 hours'
    END <= (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))

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
          shift_owner.guard_name,
          shift_owner.guard_session_id,
          shift_owner.scheduled_shift_start,
          shift_owner.scheduled_shift_end,
          CASE
            WHEN shift_owner.scheduled_shift_end IS NOT NULL
              AND shift_owner.scheduled_shift_end
                < (ps.scheduled_date + ps.scheduled_time + INTERVAL '2 hours')
              THEN 'shift_end'
            ELSE NULL::text
          END AS missed_reason
        FROM patrol_schedules ps
        LEFT JOIN sites s
          ON s.id = ps.site_id

        LEFT JOIN companies c
          ON c.id = s.company_id
        LEFT JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
        LEFT JOIN LATERAL (
          SELECT
            guard_session.id AS guard_session_id,
            guard_session.scheduled_shift_start,
            guard_session.scheduled_shift_end,
            guard.full_name AS guard_name
          FROM guard_sessions guard_session
          INNER JOIN guards guard
            ON guard.id = guard_session.guard_id
            AND guard.access_mode = 'standard'
          WHERE guard_session.site_id = ps.site_id
            AND guard_session.scheduled_shift_start IS NOT NULL
            AND guard_session.scheduled_shift_end IS NOT NULL
            AND guard_session.scheduled_shift_end
              > guard_session.scheduled_shift_start
            AND (ps.scheduled_date + ps.scheduled_time)
              >= guard_session.scheduled_shift_start
            AND (ps.scheduled_date + ps.scheduled_time)
              < guard_session.scheduled_shift_end
          ORDER BY guard_session.login_time DESC, guard_session.id DESC
          LIMIT 1
        ) shift_owner ON true
        WHERE ps.schedule_type = 'manual'
          AND CASE
            WHEN shift_owner.scheduled_shift_end IS NOT NULL
              THEN LEAST(
                ps.scheduled_date + ps.scheduled_time + INTERVAL '2 hours',
                shift_owner.scheduled_shift_end
              )
            ELSE ps.scheduled_date + ps.scheduled_time + INTERVAL '2 hours'
          END <= (
            NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM patrol_logs pl
            WHERE pl.schedule_id = ps.id
              AND COALESCE(pl.schedule_type, 'manual') = 'manual'
          )
      ),
      random_missed AS (
        SELECT
          CONCAT('random-missed-', rpo.id) AS id,
          rpo.site_id,
          s.name AS site_name,
          s.location AS site_location,
          rpo.patrol_point_id AS point_id,
          pp.point_name,
          rpo.scheduled_at,
          'random' AS schedule_type,
          'missed' AS status,
          shift_owner.guard_name,
          shift_owner.guard_session_id,
          shift_owner.scheduled_shift_start,
          shift_owner.scheduled_shift_end,
          CASE
            WHEN shift_owner.scheduled_shift_end IS NOT NULL
              AND shift_owner.scheduled_shift_end
                < rpo.scheduled_at + INTERVAL '2 hours'
              THEN 'shift_end'
            ELSE NULL::text
          END AS missed_reason
        FROM random_patrol_occurrences rpo
        INNER JOIN random_patrol_days rpd ON rpd.id = rpo.random_patrol_day_id
        INNER JOIN sites s ON s.id = rpo.site_id AND s.company_id = rpo.company_id
        INNER JOIN patrol_points pp ON pp.id = rpo.patrol_point_id
        LEFT JOIN LATERAL (
          SELECT
            guard_session.id AS guard_session_id,
            guard_session.scheduled_shift_start,
            guard_session.scheduled_shift_end,
            guard.full_name AS guard_name
          FROM guard_sessions guard_session
          INNER JOIN guards guard
            ON guard.id = guard_session.guard_id
            AND guard.access_mode = 'standard'
          WHERE guard_session.site_id = rpo.site_id
            AND guard_session.scheduled_shift_start IS NOT NULL
            AND guard_session.scheduled_shift_end IS NOT NULL
            AND guard_session.scheduled_shift_end
              > guard_session.scheduled_shift_start
            AND rpo.scheduled_at >= guard_session.scheduled_shift_start
            AND rpo.scheduled_at < guard_session.scheduled_shift_end
          ORDER BY guard_session.login_time DESC, guard_session.id DESC
          LIMIT 1
        ) shift_owner ON true
        WHERE CASE
          WHEN shift_owner.scheduled_shift_end IS NOT NULL
            THEN LEAST(
              rpo.scheduled_at + INTERVAL '2 hours',
              shift_owner.scheduled_shift_end
            )
          ELSE rpo.scheduled_at + INTERVAL '2 hours'
        END <= (NOW() AT TIME ZONE rpd.timezone)
          AND NOT EXISTS (
            SELECT 1 FROM patrol_logs pl WHERE pl.random_occurrence_id = rpo.id
          )
      ),
      combined AS (
        SELECT * FROM recurring_missed
        UNION ALL
        SELECT * FROM manual_missed
        UNION ALL
        SELECT * FROM random_missed
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
                : item.schedule_type === "random"
                ? "Random Patrol"
                : "Routine Patrol"
            )}</td>
            <td>
  <strong>Guard:</strong> ${escapeHtml(item.guard_name || "-")}<br/>
  <strong>Shift:</strong> ${escapeHtml(item.shift_label || "-")}<br/>
  <strong>Session:</strong> ${escapeHtml(item.guard_session_id ? `#${item.guard_session_id}` : "-")}
</td>
<td>${escapeHtml(
  item.status === "missed"
    ? item.missed_reason === "shift_end"
      ? "Missed - Shift ended"
      : "Missed"
    : item.status
)}</td>
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
          CASE
            WHEN shift_owner.scheduled_shift_end IS NOT NULL
              THEN LEAST(
                ps.scheduled_date::timestamp + ps.scheduled_time + INTERVAL '2 hours',
                shift_owner.scheduled_shift_end
              )
            ELSE ps.scheduled_date::timestamp + ps.scheduled_time + INTERVAL '2 hours'
          END AS missed_at,
          shift_owner.guard_session_id,
          shift_owner.scheduled_shift_start,
          shift_owner.scheduled_shift_end,
          CASE
            WHEN shift_owner.scheduled_shift_end IS NOT NULL
              AND shift_owner.scheduled_shift_end
                < ps.scheduled_date::timestamp + ps.scheduled_time + INTERVAL '2 hours'
              THEN 'shift_end'
            ELSE NULL::text
          END AS missed_reason,

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
          matched_log.delay_minutes,
          matched_log.completion_status

        FROM patrol_schedules ps

        LEFT JOIN sites s
          ON s.id = ps.site_id

        LEFT JOIN companies c
          ON c.id = s.company_id

        LEFT JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id

        LEFT JOIN LATERAL (
          SELECT
            guard_session.id AS guard_session_id,
            guard_session.scheduled_shift_start,
            guard_session.scheduled_shift_end
          FROM guard_sessions guard_session
          INNER JOIN guards guard
            ON guard.id = guard_session.guard_id
            AND guard.access_mode = 'standard'
          WHERE guard_session.site_id = ps.site_id
            AND guard_session.scheduled_shift_start IS NOT NULL
            AND guard_session.scheduled_shift_end IS NOT NULL
            AND guard_session.scheduled_shift_end
              > guard_session.scheduled_shift_start
            AND (ps.scheduled_date::timestamp + ps.scheduled_time)
              >= guard_session.scheduled_shift_start
            AND (ps.scheduled_date::timestamp + ps.scheduled_time)
              < guard_session.scheduled_shift_end
          ORDER BY guard_session.login_time DESC, guard_session.id DESC
          LIMIT 1
        ) shift_owner ON true

        LEFT JOIN LATERAL (
          SELECT
            pl.id,
            pl.patrol_time,
            pl.completion_status,
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
            AND completion_status <> 'completed_late'
            THEN 'completed'

          WHEN patrol_log_id IS NOT NULL
            AND completion_status = 'completed_late'
            THEN 'completed_late'

          WHEN patrol_log_id IS NULL
            AND (NOW() AT TIME ZONE company_timezone)
              < missed_at
            THEN 'pending'

          WHEN patrol_log_id IS NULL
            AND (NOW() AT TIME ZONE company_timezone)
              >= missed_at
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

  const runRandomPatrolGenerator = () =>
    generateRandomPatrolsForCurrentLocalDay(pool).catch((error) => {
      console.error("Random Patrol generator error:", error);
    });
  setTimeout(runRandomPatrolGenerator, 15000);
  setInterval(runRandomPatrolGenerator, 60000);
}

startBackend().catch((err) => {
  console.error("Backend startup failed:", err);
  process.exit(1);
});






