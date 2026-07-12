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



async function getShiftDelayEmailRecipients(companyId) {
  const result = await pool.query(
    `
    SELECT
      id,
      full_name,
      email,
      secondary_email
    FROM users
    WHERE company_id = $1
      AND role = 'supervisor'
      AND status = 'active'
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

  const scheduledStart = new Date(event.scheduled_start).toLocaleString(
  "el-GR",
  {
    timeZone: "UTC",
    dateStyle: "short",
    timeStyle: "short",
  }
);

const alertThreshold = new Date(event.alert_threshold).toLocaleString(
  "el-GR",
  {
    timeZone: "UTC",
    dateStyle: "short",
    timeStyle: "short",
  }
);

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
      ss.scheduled_start,
      ss.scheduled_start + INTERVAL '15 minutes' AS alert_threshold,

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
      const emailResult = await sendShiftDelayEmail(event);

      await pool.query(
        `
        UPDATE operational_events
        SET
          email_status = 'sent',
          email_recipient = $1,
          email_sent_at = (NOW() AT TIME ZONE 'Europe/Athens'),
          email_error = NULL,
          updated_at = (NOW() AT TIME ZONE 'Europe/Athens')
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
          updated_at = (NOW() AT TIME ZONE 'Europe/Athens')
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


const app = express();
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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(morgan('dev'));

app.get('/', (req, res) => {
  res.send('Noctua Panic Backend is running');
});

// Temporary placeholder routes
app.post('/trigger-alert', (req, res) => {
  console.log('Alert received:', req.body);
  return res.json({ status: 'ok', message: 'Alert received by backend' });
});

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
app.post('/incident-log', async (req, res) => {
  try {
    const {
  guardId,
  siteId,
  sessionId,
  timestamp,
  message,
  incidentAnswers
} = req.body;

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
        guardId || null,
        siteId || null,
        sessionId || null,
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
Guard ID: ${guardId || 'N/A'}
Site ID: ${siteId || 'N/A'}
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

app.get("/admin/active", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (username)

username,
role,
login_time,
last_seen

FROM admin_sessions

WHERE is_active=true

AND last_seen >
NOW() - INTERVAL '90 seconds'

ORDER BY username,last_seen DESC
    `);

    res.json({
      status: "ok",
      admins: result.rows
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
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
          EXTRACT(EPOCH FROM (NOW() - login_time))::int
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

app.get("/admin/sessions/history", async (req,res)=>{

try{

const { user, from, to, active } = req.query;

let query = `
SELECT
id,
username,
role,
login_time,
last_seen,
logout_time,
is_active,
session_duration_seconds,

(is_active = true AND last_seen > NOW() - INTERVAL '90 seconds') AS is_currently_online

FROM admin_sessions
WHERE 1=1
`;

const values = [];

if(user){
values.push(user);
query += ` AND username = $${values.length}`;
}

if(from){
  values.push(from);
  query += ` AND COALESCE(logout_time, last_seen, login_time) >= $${values.length}::date`;
}

if(to){
  values.push(to);
  query += ` AND COALESCE(logout_time, last_seen, login_time) < ($${values.length}::date + INTERVAL '1 day')`;
}

if(active === "true" || active === "false"){
values.push(active === "true");
query += ` AND is_active = $${values.length}`;
}

query += ` ORDER BY login_time DESC`;

const result = await pool.query(query, values);

res.json({
status:"ok",
sessions:result.rows
});

}catch(err){

res.status(500).json({
status:"error",
message:err.message
});

}

});


// --------------------------------------------------
// ADMIN LOGIN EXPORT CSV
// --------------------------------------------------

app.get("/admin/sessions/export", async (req,res)=>{

try{

const result = await pool.query(
`
SELECT

username,
role,
login_time,
last_seen,
logout_time,
is_active,
session_duration_seconds,

(is_active = true AND last_seen > NOW() - INTERVAL '90 seconds') AS is_currently_online

FROM admin_sessions

ORDER BY login_time DESC
`
);

result.rows.forEach(row => {

row.login_time = row.login_time
? new Date(row.login_time).toLocaleString(
"el-GR",
{ timeZone: "Europe/Athens" }
)
: "";

row.last_seen = row.last_seen
? new Date(row.last_seen).toLocaleString(
"el-GR",
{ timeZone: "Europe/Athens" }
)
: "";

row.logout_time = row.logout_time
? new Date(row.logout_time).toLocaleString(
"el-GR",
{ timeZone: "Europe/Athens" }
)
: "";

});

let csv =
"username;role;login_time;last_seen;logout_time;is_active;session_duration_seconds\n";

result.rows.forEach(row=>{

csv +=
`${row.username};`+
`${row.role};`+
`${row.login_time};`+
`${row.last_seen};`+
`${row.logout_time || ""};`+
`${row.is_active};`+
`${row.session_duration_seconds || ""}\n`;

});

res.setHeader(
"Content-Type",
"text/csv"
);

res.setHeader(
"Content-Disposition",
"attachment; filename=admin_sessions.csv"
);

res.send(csv);

}catch(err){

res.status(500).json({
status:"error",
message:err.message
});

}

});

// ---------------------------------------------------------------------
// GreekSMS API route
// ---------------------------------------------------------------------
app.post('/send-sms', async (req, res) => {
  try {
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
app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "ok",
      dbTime: result.rows[0]
    });
  } catch (err) {
    console.error("DB test error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});
app.post("/setup/users-table", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(50),
        role VARCHAR(50) NOT NULL DEFAULT 'guard',
        password_hash TEXT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        must_change_password BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.json({ status: "ok", message: "Users table ready" });
  } catch (err) {
    console.error("Users table setup error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/admin/users/create", async (req, res) => {
  try {
    const { full_name, username, email, phone, role, password } = req.body;

    if (!full_name || !username || !password) {
      return res.status(400).json({
        status: "error",
        message: "full_name, username and password are required"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (
        full_name, username, email, phone, role,
        password_hash, status, must_change_password
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'active', true)
      RETURNING id, full_name, username, email, phone, role, status, must_change_password, created_at
      `,
      [full_name, username, email || null, phone || null, role || "guard", passwordHash]
    );

    res.json({
      status: "ok",
      message: "User created",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Create user error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// ADMIN USERS MANAGEMENT
// ----------------------------------------------------------

app.get("/admin/users", async (req, res) => {
  try {
    const result = await pool.query(`
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
      ORDER BY id ASC
    `);

    res.json({
      status: "ok",
      users: result.rows
    });
  } catch (err) {
    console.error("Fetch admin users error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.get("/admin/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

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
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Fetch admin user error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/admin/users", async (req, res) => {
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
      company_id = 1
    } = req.body;

    if (!full_name || !username) {
      return res.status(400).json({
        status: "error",
        message: "full_name and username are required"
      });
    }

    const temporaryPassword = crypto
      .randomBytes(9)
      .toString("base64")
      .replace(/[+/=]/g, "")
      .slice(0, 12);

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

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
        $1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),
        NULLIF($6,''),NULLIF($7,''),$8,$9,$10,$11,true,NOW()
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
        passwordHash
      ]
    );

    res.json({
      status: "ok",
      message: "User created successfully",
      temporary_password: temporaryPassword,
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Create admin user error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/admin/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      full_name,
      username,
      email,
      secondary_email,
      phone,
      mobile_phone,
      backup_phone,
      role,
      status,
      company_id
    } = req.body;

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
        company_id = COALESCE($10, company_id),
        updated_at = NOW()
      WHERE id = $11
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
        company_id || null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      message: "User updated successfully",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Update admin user error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        status: "error",
        message: "Username and password are required",
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
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials",
      });
    }

    const user = userResult.rows[0];

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

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials",
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
      company_id: auth.company_id,
      company_name: auth.company_name,
      company_status: auth.company_status,
      tenant_type: auth.tenant_type,
      access_scope:
        auth.role === "system_owner"
          ? "platform"
          : "company",
    };

    next();
  } catch (err) {
    console.error("Authentication middleware error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message,
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
// USER PASSWORD MANAGEMENT
// ----------------------------------------------------------

app.put("/admin/users/:id/reset-password", async (req, res) => {
  try {
    const { id } = req.params;
    const temporaryPassword = crypto
  .randomBytes(9)
  .toString("base64")
  .replace(/[+/=]/g, "")
  .slice(0, 12);

const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    const result = await pool.query(
      `
      UPDATE users
      SET
        password_hash = $1,
        must_change_password = true
      WHERE id = $2
      RETURNING
        id,
        full_name,
        username,
        email,
        phone,
        role,
        status,
        must_change_password
      `,
      [passwordHash, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
  status: "ok",
  message: "Password reset successfully",
  temporary_password: temporaryPassword,
  user: result.rows[0]
});
  } catch (err) {
    console.error("User reset password error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/auth/change-password", async (req, res) => {
  try {
    const { user_id, current_password, new_password } = req.body;

    if (!user_id || !current_password || !new_password) {
      return res.status(400).json({
        status: "error",
        message: "user_id, current_password and new_password are required"
      });
    }

    const userResult = await pool.query(
      `
      SELECT *
      FROM users
      WHERE id = $1
        AND status = 'active'
      `,
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found or inactive"
      });
    }

    const user = userResult.rows[0];

    const validPassword = await bcrypt.compare(
      current_password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        status: "error",
        message: "Current password is incorrect"
      });
    }

    const newPasswordHash = await bcrypt.hash(new_password, 10);

    const updateResult = await pool.query(
      `
      UPDATE users
      SET
        password_hash = $1,
        must_change_password = false
      WHERE id = $2
      RETURNING
        id,
        full_name,
        username,
        email,
        phone,
        role,
        status,
        must_change_password
      `,
      [newPasswordHash, user_id]
    );

    res.json({
      status: "ok",
      message: "Password changed successfully",
      user: updateResult.rows[0]
    });
  } catch (err) {
    console.error("Change password error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

function pad2(value) {
  return String(value).padStart(2, "0");
}

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
  setInterval(async () => {
    try {
      const athensToday = getAthensDateParts(new Date());

      const todayDate =
        `${athensToday.year}-${pad2(athensToday.month)}-${pad2(athensToday.day)}`;

      console.log("[SHIFT GENERATOR] Running for", todayDate);

      const created = await generateScheduledShiftsForAllSites(todayDate);

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
  }, 60000);
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
      (NOW() AT TIME ZONE 'Europe/Athens'),
      (NOW() AT TIME ZONE 'Europe/Athens'),
      (NOW() AT TIME ZONE 'Europe/Athens'),
      'pending'
    FROM scheduled_shifts ss
    WHERE ss.scheduled_start + INTERVAL '15 minutes'
          <= (NOW() AT TIME ZONE 'Europe/Athens')

      AND ss.scheduled_end >
          (NOW() AT TIME ZONE 'Europe/Athens')

      AND NOT EXISTS (
  SELECT 1
  FROM guard_sessions gs
  WHERE gs.site_id = ss.site_id
    AND gs.login_time >= ss.scheduled_start - INTERVAL '15 minutes'
    AND gs.login_time <= ss.scheduled_start + INTERVAL '15 minutes'
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
  setInterval(async () => {
    try {
      await detectShiftDelayEvents();
      await processPendingShiftDelayEmails();
    } catch (err) {
      console.error("[SHIFT DELAY MONITOR ERROR]", err.message);

      if (err.stack) {
        console.error(err.stack);
      }
    }
  }, 60000);
}

async function syncScheduledShiftsForSession(sessionId) {
  await pool.query(
    `
    INSERT INTO scheduled_shift_sessions (
      scheduled_shift_id,
      guard_session_id,
      guard_id,
      overlap_start,
      overlap_end,
      coverage_minutes,
      created_at
    )
    SELECT
      ss.id,
      gs.id,
      gs.guard_id,
      GREATEST(gs.login_time, ss.scheduled_start),
      CASE
  WHEN gs.logout_time IS NULL THEN NULL
  ELSE LEAST(gs.logout_time, ss.scheduled_end)
END,
       GREATEST(
  FLOOR(
    CASE
      WHEN gs.logout_time IS NULL THEN 0
      ELSE
        EXTRACT(EPOCH FROM (
          LEAST(gs.logout_time, ss.scheduled_end)
          - GREATEST(gs.login_time, ss.scheduled_start)
        )) / 60
    END
  ),
  0
),
      (NOW() AT TIME ZONE 'Europe/Athens')
    FROM guard_sessions gs
    JOIN scheduled_shifts ss
  ON ss.site_id = gs.site_id
 AND gs.login_time >= ss.scheduled_start - INTERVAL '15 minutes'
 AND gs.login_time < ss.scheduled_end
    WHERE gs.id = $1
    ON CONFLICT (scheduled_shift_id, guard_session_id)
    DO UPDATE SET
      overlap_start = EXCLUDED.overlap_start,
      overlap_end = EXCLUDED.overlap_end,
      coverage_minutes = EXCLUDED.coverage_minutes
    `,
    [sessionId]
  );

  await pool.query(
    `
    UPDATE scheduled_shifts ss
    SET
      guard_id = last_session.guard_id,
      guard_session_id = last_session.guard_session_id,
      actual_login_time = first_session.overlap_start,
      actual_logout_time = CASE
  WHEN active_sessions.active_count > 0 THEN NULL
  ELSE last_session.overlap_end
END,

      coverage_minutes = COALESCE(total_coverage.coverage_minutes, 0),

      uncovered_minutes = GREATEST(
        FLOOR(EXTRACT(EPOCH FROM (ss.scheduled_end - ss.scheduled_start)) / 60)
        - COALESCE(total_coverage.coverage_minutes, 0),
        0
      ),

      coverage_percent = ROUND(
        (
          COALESCE(total_coverage.coverage_minutes, 0)
          /
          NULLIF(FLOOR(EXTRACT(EPOCH FROM (ss.scheduled_end - ss.scheduled_start)) / 60), 0)
        ) * 100,
        2
      ),

      login_delay_minutes = CASE
        WHEN first_session.overlap_start IS NULL THEN NULL
        ELSE GREATEST(
          FLOOR(EXTRACT(EPOCH FROM (first_session.overlap_start - ss.scheduled_start)) / 60),
          0
        )
      END,

      logout_delay_minutes = CASE
        WHEN last_session.overlap_end IS NULL THEN NULL
        ELSE GREATEST(
          FLOOR(EXTRACT(EPOCH FROM (last_session.overlap_end - ss.scheduled_end)) / 60),
          0
        )
      END,

      early_logout_minutes = CASE
        WHEN last_session.overlap_end IS NULL THEN NULL
        ELSE GREATEST(
          FLOOR(EXTRACT(EPOCH FROM (ss.scheduled_end - last_session.overlap_end)) / 60),
          0
        )
      END,

      coverage_status = CASE
        WHEN COALESCE(total_coverage.coverage_minutes, 0) = 0 THEN 'no_login'
        WHEN active_sessions.active_count > 0 THEN 'active'
        WHEN first_session.overlap_start <= ss.scheduled_start + INTERVAL '15 minutes'
AND last_session.overlap_end >= ss.scheduled_end - INTERVAL '15 minutes'
         AND COALESCE(total_coverage.coverage_minutes, 0) >=
             FLOOR(EXTRACT(EPOCH FROM (ss.scheduled_end - ss.scheduled_start)) / 60) - 20
          THEN 'completed'
        ELSE 'partial_coverage'
      END,

      status = CASE
        WHEN COALESCE(total_coverage.coverage_minutes, 0) = 0 THEN 'no_login'
        WHEN active_sessions.active_count > 0 THEN 'active'
        WHEN first_session.overlap_start <= ss.scheduled_start + INTERVAL '15 minutes'
AND last_session.overlap_end >= ss.scheduled_end - INTERVAL '15 minutes'
         AND COALESCE(total_coverage.coverage_minutes, 0) >=
             FLOOR(EXTRACT(EPOCH FROM (ss.scheduled_end - ss.scheduled_start)) / 60) - 20
          THEN 'completed'
        ELSE 'partial_coverage'
      END,

      updated_at = (NOW() AT TIME ZONE 'Europe/Athens')

    FROM (
      SELECT scheduled_shift_id, SUM(coverage_minutes) AS coverage_minutes
      FROM scheduled_shift_sessions
      GROUP BY scheduled_shift_id
    ) total_coverage

    LEFT JOIN LATERAL (
      SELECT overlap_start
      FROM scheduled_shift_sessions
      WHERE scheduled_shift_id = total_coverage.scheduled_shift_id
      ORDER BY overlap_start ASC
      LIMIT 1
    ) first_session ON TRUE

    LEFT JOIN LATERAL (
  SELECT
    sss.guard_id,
    sss.guard_session_id,
    CASE
      WHEN gs.logout_time IS NULL THEN NULL
      ELSE sss.overlap_end
    END AS overlap_end
  FROM scheduled_shift_sessions sss
  JOIN guard_sessions gs
    ON gs.id = sss.guard_session_id
  WHERE sss.scheduled_shift_id = total_coverage.scheduled_shift_id
  ORDER BY sss.overlap_start DESC
) last_session ON TRUE

    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_count
      FROM scheduled_shift_sessions sss
      JOIN guard_sessions gs ON gs.id = sss.guard_session_id
      WHERE sss.scheduled_shift_id = total_coverage.scheduled_shift_id
        AND gs.logout_time IS NULL
    ) active_sessions ON TRUE

    WHERE ss.id = total_coverage.scheduled_shift_id
    `
  );
}

// ----------------------------------------------------------
// GUARD LOGIN
// ----------------------------------------------------------
app.post("/guard/login", async (req, res) => {
  try {
    const { username, password, device_info } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        status: "error",
        message: "username and password are required"
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM guards
      WHERE username = $1
        AND active = true
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials"
      });
    }

    const guard = result.rows[0];

    let validPassword = false;

    if (guard.password_hash && guard.password_hash.startsWith("$2")) {
      validPassword = await bcrypt.compare(password, guard.password_hash);
    } else {
      validPassword = password === guard.password_hash;
    }

    if (!validPassword) {
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials"
      });
    }

    const closedSessions = await pool.query(
  `
  UPDATE guard_sessions
  SET
    logout_time = NOW(),
    status = 'auto_closed',
    last_heartbeat = NOW()
  WHERE guard_id = $1
    AND logout_time IS NULL
  RETURNING id
  `,
  [guard.id]
);

for (const row of closedSessions.rows) {
  await syncScheduledShiftsForSession(row.id);
}

    const siteResult = await pool.query(
  `
  SELECT shift_rules
  FROM sites
  WHERE id = $1
  `,
  [guard.site_id]
);

const scheduledShift =
  siteResult.rows.length > 0
    ? getScheduledShiftFromRules(siteResult.rows[0].shift_rules)
    : null;

    console.log("SCHEDULED SHIFT:", scheduledShift);

    const sessionResult = await pool.query(
      `
      INSERT INTO guard_sessions (
    guard_id,
    site_id,
    login_time,
    last_heartbeat,
    status,
    device_info,
    ip_address,
    created_at,
    scheduled_shift_start,
    scheduled_shift_end,
    scheduled_shift_label
  )
  VALUES (
  $1,
  $2,
  (NOW() AT TIME ZONE 'Europe/Athens'),
  (NOW() AT TIME ZONE 'Europe/Athens'),
  'online',
  $3,
  $4,
  (NOW() AT TIME ZONE 'Europe/Athens'),
  $5::timestamp,
  $6::timestamp,
  $7
)
  RETURNING *
  `,
  [
    guard.id,
    guard.site_id,
    device_info || null,
    req.ip || null,
    scheduledShift?.start || null,
scheduledShift?.end || null,
scheduledShift?.label || null
  ]
);

console.log("NEW SESSION:", sessionResult.rows[0]);

const athensToday = getAthensDateParts(new Date());
const todayDate = `${athensToday.year}-${pad2(athensToday.month)}-${pad2(athensToday.day)}`;

await generateScheduledShiftsForSite(guard.site_id, todayDate);
await syncScheduledShiftsForSession(sessionResult.rows[0].id);

    res.json({
      status: "ok",
      message: "Guard login successful",
      guard: {
        id: guard.id,
        full_name: guard.full_name,
        username: guard.username,
        phone: guard.phone,
        role: guard.role,
        site_id: guard.site_id
      },
      session: sessionResult.rows[0]
    });

  } catch (err) {
    console.error("Guard login error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/admin/scheduled-shifts/generate", async (req, res) => {
  try {
    const { site_id, date } = req.body;

    if (!site_id || !date) {
      return res.status(400).json({
        status: "error",
        message: "site_id and date are required"
      });
    }

    const created = await generateScheduledShiftsForSite(site_id, date);

    res.json({
      status: "ok",
      created_count: created.length,
      scheduled_shifts: created
    });
  } catch (err) {
    console.error("Generate scheduled shifts error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// GUARD LOGOUT
// ----------------------------------------------------------
app.post("/guard/logout", async (req, res) => {
  try {
    const { guard_id, session_id } = req.body;

    if (!guard_id || !session_id) {
      return res.status(400).json({
        status: "error",
        message: "guard_id and session_id are required"
      });
    }

    const logoutResult = await pool.query(
  `
  UPDATE guard_sessions
  SET
    logout_time = (NOW() AT TIME ZONE 'Europe/Athens'),
    status = 'logged_out',
    last_heartbeat = (NOW() AT TIME ZONE 'Europe/Athens')
  WHERE id = $1
    AND guard_id = $2
    AND logout_time IS NULL
  RETURNING id
  `,
  [session_id, guard_id]
);

for (const row of logoutResult.rows) {
  await syncScheduledShiftsForSession(row.id);
}

    res.json({ status: "ok" });

  } catch (err) {
    console.error("Guard logout error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});


// ----------------------------------------------------------
// GUARD SESSION HEARTBEAT
// ----------------------------------------------------------
app.post("/guard/heartbeat", async (req, res) => {
  try {
    const { guard_id, session_id } = req.body;

    if (!guard_id || !session_id) {
      return res.status(400).json({
        status: "error",
        message: "guard_id and session_id are required"
      });
    }

    const result = await pool.query(
      `
      UPDATE guard_sessions
      SET
        last_heartbeat = NOW(),
        status = 'online'
      WHERE id = $1
        AND guard_id = $2
        AND logout_time IS NULL
      RETURNING *
      `,
      [session_id, guard_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Active session not found"
      });
    }

    res.json({
      status: "ok",
      session: result.rows[0]
    });

  } catch (err) {
    console.error("Guard heartbeat error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// GUARD CHECK IN
// ----------------------------------------------------------
app.post("/guards/checkin", async (req, res) => {
  try {
    const { username, site_id } = req.body;

    if (!username || !site_id) {
      return res.status(400).json({
        status: "error",
        message: "username and site_id are required"
      });
    }

    const guardResult = await pool.query(
      `
      SELECT *
      FROM guards
      WHERE username = $1
        AND active = true
      `,
      [username]
    );

    if (guardResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Guard not found or inactive"
      });
    }

    const guard = guardResult.rows[0];

    await pool.query(
      `
      UPDATE guard_shifts
      SET
        check_out_time = NOW(),
        status = 'auto_closed',
        online = false
      WHERE guard_ref = $1
        AND check_out_time IS NULL
      `,
      [guard.id]
    );

    const shiftResult = await pool.query(
      `
      INSERT INTO guard_shifts (
        company_id,
        guard_id,
        guard_ref,
        site_id,
        check_in_time,
        last_seen,
        online,
        status,
        created_at
      )
      VALUES (
        1,
        $1,
        $1,
        $2,
        NOW(),
        NOW(),
        true,
        'on_duty',
        NOW()
      )
      RETURNING *
      `,
      [guard.id, site_id]
    );

    await pool.query(
      `
      UPDATE sites
      SET active_guard_id = $1
      WHERE id = $2
      `,
      [guard.id, site_id]
    );

    res.json({
      status: "ok",
      guard,
      shift: shiftResult.rows[0]
    });

  } catch (err) {
    console.error("Guard checkin error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});


// ----------------------------------------------------------
// GUARD HEARTBEAT
// ----------------------------------------------------------
app.post("/guards/heartbeat", async (req, res) => {
  try {
    const { guard_id } = req.body;

    if (!guard_id) {
      return res.status(400).json({
        status: "error",
        message: "guard_id is required"
      });
    }

    await pool.query(
      `
      UPDATE guard_shifts
      SET
        last_seen = NOW(),
        online = true
      WHERE guard_ref = $1
        AND check_out_time IS NULL
      `,
      [guard_id]
    );

    res.json({ status: "ok" });

  } catch (err) {
    console.error("Guard heartbeat error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});


// ----------------------------------------------------------
// GUARD CHECK OUT
// ----------------------------------------------------------
app.post("/guards/checkout", async (req, res) => {
  try {
    const { guard_id, site_id } = req.body;

    if (!guard_id || !site_id) {
      return res.status(400).json({
        status: "error",
        message: "guard_id and site_id are required"
      });
    }

    await pool.query(
      `
      UPDATE guard_shifts
      SET
        check_out_time = NOW(),
        status = 'completed',
        online = false,
        last_seen = NOW()
      WHERE guard_ref = $1
        AND site_id = $2
        AND check_out_time IS NULL
      `,
      [guard_id, site_id]
    );

    await pool.query(
      `
      UPDATE sites
      SET active_guard_id = NULL
      WHERE id = $1
        AND active_guard_id = $2
      `,
      [site_id, guard_id]
    );

    res.json({ status: "ok" });

  } catch (err) {
    console.error("Guard checkout error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// AUTO CLOSE STALE GUARD SESSIONS
// ----------------------------------------------------------
async function autoCloseStaleGuardSessions() {
  try {
    await pool.query(`
      WITH stale_sessions AS (
        UPDATE guard_shifts
        SET
          check_out_time = NOW(),
          status = 'abandoned',
          online = false,
          last_seen = NOW()
        WHERE check_out_time IS NULL
          AND online = true
          AND last_seen < NOW() - INTERVAL '90 seconds'
        RETURNING guard_ref, site_id
      )
      UPDATE sites s
      SET active_guard_id = NULL
      FROM stale_sessions ss
      WHERE s.id = ss.site_id
        AND s.active_guard_id = ss.guard_ref
    `);
  } catch (err) {
    console.error("Auto close stale guard sessions error:", err);
  }
}

setInterval(autoCloseStaleGuardSessions, 30000);


// ----------------------------------------------------------
// ACTIVE GUARDS
// ----------------------------------------------------------
app.get("/guards/active", async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT
        s.id AS site_id,
        s.name AS site_name,
        s.location AS site_location,

        g.id AS guard_id,
g.full_name,
g.username,
g.phone,
g.mobile_phone,

        gs.login_time,
        gs.login_time AS check_in_time,
        gs.last_heartbeat,
        gs.last_heartbeat AS last_seen,
        gs.status,

        (
  gs.id IS NOT NULL
  AND gs.logout_time IS NULL
) AS is_currently_online,

(
  gs.id IS NOT NULL
  AND gs.logout_time IS NULL
  AND gs.last_heartbeat > NOW() - INTERVAL '90 seconds'
) AS has_recent_heartbeat

      FROM sites s

      LEFT JOIN guard_sessions gs
        ON gs.site_id = s.id
        AND gs.logout_time IS NULL

      LEFT JOIN guards g
        ON g.id = gs.guard_id

      ORDER BY s.id ASC
    `);

    res.json({
      status: "ok",
      guards: result.rows
    });

  } catch (err) {

    console.error("Active guards error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });

  }
});

app.get("/dashboard/metrics", async (req, res) => {
  try {

    // Active guards
    const guardsResult = await pool.query(`
  SELECT COUNT(*)::int AS count
  FROM guard_sessions
  WHERE logout_time IS NULL
`);

    // Active incidents (προς το παρόν δεν υπάρχουν)
    const incidentsResult = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM incidents
      WHERE status = 'active'
    `).catch(() => ({ rows: [{ count: 0 }] }));

    // Alerts today
    const alertsTodayResult = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM incidents
      WHERE DATE(created_at) = CURRENT_DATE
    `).catch(() => ({ rows: [{ count: 0 }] }));

    const responseTimeResult = await pool.query(`
  SELECT
    trigger_time,
    resolved_time,
    EXTRACT(EPOCH FROM (resolved_time - trigger_time))::int AS duration_seconds
  FROM incidents
  WHERE status = 'resolved'
    AND trigger_time IS NOT NULL
    AND resolved_time IS NOT NULL
  ORDER BY resolved_time DESC
  LIMIT 1
`).catch(() => ({
  rows: [{ duration_seconds: null }]
}));

let responseTime = "0s";

const durationSeconds =
  responseTimeResult.rows[0]?.duration_seconds;

if (durationSeconds !== null && durationSeconds !== undefined) {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;

  responseTime =
    hours > 0
      ? `${hours}h ${minutes}m ${seconds}s`
      : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;
}

    res.json({
      activeIncidents: incidentsResult.rows[0]?.count || 0,
      alertsToday: alertsTodayResult.rows[0]?.count || 0,
      responseTime,
      guardsOnDuty: guardsResult.rows[0]?.count || 0,
    });

  } catch (err) {
    console.error("Dashboard metrics error:", err);

    res.status(500).json({
      error: "Failed to load metrics"
    });
  }
});

// ----------------------------------------------------------
// DASHBOARD INCIDENT TIMELINE
// Uses real alert_events for the latest active / recent incident
// ----------------------------------------------------------
app.get("/dashboard/incident-timeline", async (req, res) => {
  try {
    await ensureAlertEventsTable();

    const incidentResult = await pool.query(`
      SELECT
        i.id,
        i.incident_ref,
        i.status,
        i.priority,
        i.trigger_time,
        i.resolved_time,
        s.name AS site_name,
        s.location AS site_location,
        COALESCE(g.full_name, g.username, 'Unknown guard') AS guard_name
      FROM incidents i
      LEFT JOIN sites s ON s.id = i.site_id
      LEFT JOIN guards g ON g.id = i.guard_ref
      WHERE
        i.status IN ('active', 'in_progress')
        OR (
          i.status = 'resolved'
          AND i.resolved_time > NOW() - INTERVAL '1 hour'
        )
      ORDER BY
        CASE
          WHEN i.status IN ('active', 'in_progress') THEN 1
          WHEN i.status = 'resolved' THEN 2
          ELSE 3
        END,
        i.trigger_time DESC
      LIMIT 1
    `);

    if (incidentResult.rows.length === 0) {
      return res.json({
        status: "normal",
        incidentRef: null,
        location: "Normal",
        alertTime: null,
        guardName: null,
        alertStatus: "normal",
        callStatus: "normal",
        smsStatus: "normal",
        incidentStatus: "normal",
        resolvedTime: null,
        duration: null,
        events: []
      });
    }

    const incident = incidentResult.rows[0];

    const eventsResult = await pool.query(
      `
      SELECT
        id,
        event_type,
        source,
        status,
        sms_sent,
        sms_failed,
        voice_attempted,
        voice_status,
        recipient_phone,
        provider,
        provider_message_id,
        provider_call_uuid,
        event_payload,
        created_at
      FROM alert_events
      WHERE incident_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [incident.id]
    );

    const rawEvents = eventsResult.rows;

    const events = [];

rawEvents.forEach((event) => {
  if (event.event_type === "WEBAPP_ALERT") {
    events.push({
      id: `${event.id}-alert`,
      type: "alert",
      label: "Alert Triggered",
      detail: "Panic alert received from web app",
      eventType: event.event_type,
      status: event.status,
      time: event.created_at,
      provider: event.provider,
      recipientPhone: event.recipient_phone,
      providerCallUuid: event.provider_call_uuid
    });

    if (Number(event.sms_sent) > 0) {
      events.push({
        id: `${event.id}-sms-sent`,
        type: "sms",
        label: "SMS Sent",
        detail: `${event.sms_sent} SMS notification(s) sent`,
        eventType: "SMS_SENT",
        status: "completed",
        time: event.created_at,
        provider: event.provider,
        recipientPhone: event.recipient_phone,
        providerCallUuid: event.provider_call_uuid
      });
    }

    if (Number(event.sms_failed) > 0) {
      events.push({
        id: `${event.id}-sms-failed`,
        type: "sms",
        label: "SMS Failed",
        detail: `${event.sms_failed} SMS notification(s) failed`,
        eventType: "SMS_FAILED",
        status: "failed",
        time: event.created_at,
        provider: event.provider,
        recipientPhone: event.recipient_phone,
        providerCallUuid: event.provider_call_uuid
      });
    }

    return;
  }

  if (event.event_type === "VOICE_CALL_SUBMITTED") {
    events.push({
      id: event.id,
      type: "call",
      label: "Call Submitted",
      detail: event.recipient_phone
        ? `Call submitted to ${event.recipient_phone}`
        : "Voice call submitted to Vonage",
      eventType: event.event_type,
      status: event.status,
      time: event.created_at,
      provider: event.provider,
      recipientPhone: event.recipient_phone,
      providerCallUuid: event.provider_call_uuid
    });

    return;
  }

  if (event.event_type === "VOICE_WEBHOOK") {
    let label = `Call ${event.status || "Event"}`;
    let detail = event.voice_status || event.status || "Voice webhook received";

    if (event.status === "ringing") {
      label = "Call Ringing";
      detail = "Phone is ringing";
    } else if (event.status === "started") {
      label = "Call Started";
      detail = "Voice call started";
    } else if (event.status === "answered") {
      label = "Call Answered";
      detail = "Voice call answered";
    } else if (event.status === "completed") {
      label = "Call Completed";

      const duration =
        event.event_payload?.duration ||
        event.event_payload?.duration_ms ||
        null;

      detail = duration
        ? `Voice call completed · Duration: ${duration} sec`
        : "Voice call completed";
    }

    events.push({
      id: event.id,
      type: "call",
      label,
      detail,
      eventType: event.event_type,
      status: event.status,
      time: event.created_at,
      provider: event.provider,
      recipientPhone: event.recipient_phone,
      providerCallUuid: event.provider_call_uuid
    });
  }
});

events.sort((a, b) => {
  const order = {
    "Alert Triggered": 1,
    "SMS Sent": 2,
    "SMS Failed": 3,
    "Call Submitted": 4,
    "Call Started": 5,
    "Call Ringing": 6,
    "Call Answered": 7,
    "Call Completed": 8
  };

  return (
    (order[a.label] || 99) - (order[b.label] || 99) ||
    new Date(a.time) - new Date(b.time)
  );
});

    const hasCallCompleted = rawEvents.some(
      (event) =>
        event.event_type === "VOICE_WEBHOOK" &&
        event.status === "completed"
    );

    const hasCallAnswered = rawEvents.some(
      (event) =>
        event.event_type === "VOICE_WEBHOOK" &&
        event.status === "answered"
    );

    const hasCallStarted = rawEvents.some(
      (event) =>
        event.event_type === "VOICE_WEBHOOK" &&
        event.status === "started"
    );

    const hasCallRinging = rawEvents.some(
      (event) =>
        event.event_type === "VOICE_WEBHOOK" &&
        event.status === "ringing"
    );

    const hasCallSubmitted = rawEvents.some(
      (event) => event.event_type === "VOICE_CALL_SUBMITTED"
    );

    const webAlertEvent = rawEvents.find(
      (event) => event.event_type === "WEBAPP_ALERT"
    );

    const smsSent =
      webAlertEvent && Number(webAlertEvent.sms_sent) > 0;

    let callStatus = "normal";

    if (hasCallCompleted) {
      callStatus = "completed";
    } else if (hasCallAnswered) {
      callStatus = "answered";
    } else if (hasCallStarted) {
      callStatus = "started";
    } else if (hasCallRinging) {
      callStatus = "ringing";
    } else if (hasCallSubmitted) {
      callStatus = "submitted";
    }

    let duration = null;

    if (incident.trigger_time && incident.resolved_time) {
      const start = new Date(incident.trigger_time);
      const end = new Date(incident.resolved_time);
      const seconds = Math.floor((end - start) / 1000);
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;

      duration = `${minutes}m ${remainingSeconds}s`;
    }

    const isResolved = incident.status === "resolved";

    return res.json({
      status: isResolved ? "resolved_recent" : "active",

      incidentId: incident.id,
      incidentRef: incident.incident_ref,
      location: incident.site_name || incident.site_location || "Unknown site",
      alertTime: incident.trigger_time,
      guardName: incident.guard_name || "Unknown guard",

      alertStatus: webAlertEvent ? "triggered" : "normal",
      callStatus,
      smsStatus: smsSent ? "completed" : "normal",
      incidentStatus: isResolved ? "resolved" : incident.status,

      resolvedTime: incident.resolved_time,
      duration,

      events
    });
  } catch (err) {
    console.error("Dashboard incident timeline error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});


// ----------------------------------------------------------
// GUARD SHIFT HISTORY
// Event Logs source of truth: scheduled_shifts
// ----------------------------------------------------------
app.get("/guards/shifts/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ss.id,
        NULL AS company_id,

        ss.guard_id,
        COALESCE(g.full_name, g.username, 'No Login') AS full_name,

        ss.site_id,
        s.name AS site_name,
        s.location AS site_location,

        to_char(ss.scheduled_start, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS shift_start,
to_char(ss.scheduled_end, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS shift_end,

FLOOR(
  EXTRACT(EPOCH FROM (ss.scheduled_end - ss.scheduled_start)) / 60
)::int AS shift_minutes,

        ss.shift_label AS shift_label,

        ss.actual_login_time AS check_in_time,
        ss.actual_logout_time AS check_out_time,
        ss.updated_at AS last_seen,

        ss.coverage_minutes,
        ss.uncovered_minutes,
        ss.coverage_percent,
        COALESCE(
  (
    SELECT SUM(
      CASE
        WHEN gs.logout_time IS NULL THEN
          GREATEST(
            FLOOR(
              EXTRACT(EPOCH FROM (
                LEAST((NOW() AT TIME ZONE 'Europe/Athens'), ss.scheduled_end)
                - sss.overlap_start
              )) / 60
            ),
            0
          )
        ELSE COALESCE(sss.coverage_minutes, 0)
      END
    )
    FROM scheduled_shift_sessions sss
    JOIN guard_sessions gs
      ON gs.id = sss.guard_session_id
    WHERE sss.scheduled_shift_id = ss.id
  ),
  0
)::int AS live_coverage_minutes,

ROUND(
  (
    COALESCE(
      (
        SELECT SUM(
          CASE
            WHEN gs.logout_time IS NULL THEN
              GREATEST(
                FLOOR(
                  EXTRACT(EPOCH FROM (
                    LEAST((NOW() AT TIME ZONE 'Europe/Athens'), ss.scheduled_end)
                    - sss.overlap_start
                  )) / 60
                ),
                0
              )
            ELSE COALESCE(sss.coverage_minutes, 0)
          END
        )
        FROM scheduled_shift_sessions sss
        JOIN guard_sessions gs
          ON gs.id = sss.guard_session_id
        WHERE sss.scheduled_shift_id = ss.id
      ),
      0
    )
    /
    NULLIF(
      FLOOR(EXTRACT(EPOCH FROM (ss.scheduled_end - ss.scheduled_start)) / 60),
      0
    )
  ) * 100,
  2
) AS live_coverage_percent,
        ss.login_delay_minutes,
        ss.logout_delay_minutes,
        ss.early_logout_minutes,
        ss.guard_session_id,
        ss.created_at,

        EXISTS (
          SELECT 1
          FROM scheduled_shift_sessions sss
          JOIN guard_sessions gs
            ON gs.id = sss.guard_session_id
          WHERE sss.scheduled_shift_id = ss.id
            AND gs.logout_time IS NULL
        ) AS online,

        EXISTS (
          SELECT 1
          FROM scheduled_shift_sessions sss
          JOIN guard_sessions gs
            ON gs.id = sss.guard_session_id
          WHERE sss.scheduled_shift_id = ss.id
            AND gs.logout_time IS NULL
            AND gs.last_heartbeat > (NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '90 seconds'
        ) AS is_currently_online,

        CASE
          WHEN (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_start
            THEN 'scheduled'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') >= ss.scheduled_start
            AND (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_end
            AND EXISTS (
              SELECT 1
              FROM scheduled_shift_sessions sss
              JOIN guard_sessions gs
                ON gs.id = sss.guard_session_id
              WHERE sss.scheduled_shift_id = ss.id
                AND gs.logout_time IS NULL
            )
            THEN 'on_duty'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') >= ss.scheduled_start
            AND (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_end
            AND COALESCE(ss.coverage_minutes, 0) > 0
            THEN 'in_progress'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') >= ss.scheduled_start
            AND (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_end
            THEN 'no_guard'

          ELSE 'finished'
        END AS operational_status,

        CASE
          WHEN (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_end
            THEN 'pending'

          WHEN COALESCE(ss.coverage_minutes, 0) = 0
            THEN 'missed'

          WHEN ss.coverage_status = 'completed'
            THEN 'completed'

          ELSE 'partial_coverage'
        END AS evaluation_status,

        CASE
          WHEN (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_start
            THEN 'scheduled'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_end
            AND EXISTS (
              SELECT 1
              FROM scheduled_shift_sessions sss
              JOIN guard_sessions gs
                ON gs.id = sss.guard_session_id
              WHERE sss.scheduled_shift_id = ss.id
                AND gs.logout_time IS NULL
            )
            THEN 'on_duty'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_end
            AND COALESCE(ss.coverage_minutes, 0) > 0
            THEN 'in_progress'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') < ss.scheduled_end
            THEN 'no_guard'

          WHEN COALESCE(ss.coverage_minutes, 0) = 0
            THEN 'missed'

          WHEN ss.coverage_status = 'completed'
            THEN 'completed'

          ELSE 'partial_coverage'
        END AS display_status,

        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'guard_session_id', sss.guard_session_id,
                'guard_id', sss.guard_id,
                'guard_name', COALESCE(sg.full_name, sg.username, 'Unknown Guard'),
                'login_time', to_char(gs.login_time, 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
'logout_time', CASE
  WHEN gs.logout_time IS NULL THEN NULL
  ELSE to_char(gs.logout_time, 'YYYY-MM-DD"T"HH24:MI:SS.MS')
END,
'overlap_start', to_char(sss.overlap_start, 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
'overlap_end', CASE
  WHEN sss.overlap_end IS NULL THEN NULL
  ELSE to_char(sss.overlap_end, 'YYYY-MM-DD"T"HH24:MI:SS.MS')
END,
                'coverage_minutes',
CASE
  WHEN gs.logout_time IS NULL THEN
    GREATEST(
      FLOOR(
        EXTRACT(EPOCH FROM (
          LEAST((NOW() AT TIME ZONE 'Europe/Athens'), ss.scheduled_end)
          - sss.overlap_start
        )) / 60
      ),
      0
    )
  ELSE sss.coverage_minutes
END
              )
              ORDER BY sss.overlap_start ASC
            )
            FROM scheduled_shift_sessions sss
            JOIN guard_sessions gs
              ON gs.id = sss.guard_session_id
            LEFT JOIN guards sg
              ON sg.id = sss.guard_id
            WHERE sss.scheduled_shift_id = ss.id
          ),
          '[]'::json
        ) AS sessions

      FROM scheduled_shifts ss

      LEFT JOIN guards g
        ON g.id = ss.guard_id

      LEFT JOIN sites s
        ON s.id = ss.site_id

        WHERE
  ss.scheduled_end > to_char((NOW() AT TIME ZONE 'Europe/Athens')::date, 'YYYY-MM-DD')::timestamp
  AND ss.scheduled_start < (
    to_char((NOW() AT TIME ZONE 'Europe/Athens')::date + INTERVAL '1 day', 'YYYY-MM-DD')::timestamp
    + INTERVAL '7 hours'
  )

      ORDER BY ss.scheduled_start ASC
    `);

    res.json({
      status: "ok",
      shifts: result.rows
    });

  } catch (err) {
    console.error("Guard shift history error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// ALL GUARDS
// ----------------------------------------------------------
app.get("/guards", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
  g.id,
  g.full_name,
  g.username,
  g.phone,
  g.mobile_phone,
  g.landline_phone,
  g.tax_id,
  g.home_address,
  g.education_level,
  g.foreign_languages,
  g.security_experience_range,
  g.guard_notes,
  g.assignment_status,
  g.employment_status,
  g.role,
  g.site_id,
  g.active,
  s.name AS site_name,
  s.location AS site_location
FROM guards g
LEFT JOIN sites s ON s.id = g.site_id
ORDER BY g.full_name ASC
    `);

    res.json({
      status: "ok",
      guards: result.rows
    });

  } catch (err) {
    console.error("All guards error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// UPDATE GUARD PROFILE
// ----------------------------------------------------------
app.put("/guards/:id/profile", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      full_name,
      username,
      mobile_phone,
      landline_phone,
      tax_id,
      home_address,
      education_level,
      foreign_languages,
      security_experience_range,
      guard_notes,
      site_id,
      assignment_status,
    } = req.body;

    const result = await pool.query(
      `
      UPDATE guards
      SET
        full_name = $1,
        username = $2,
        mobile_phone = $3,
        landline_phone = $4,
        tax_id = $5,
        home_address = $6,
        education_level = $7,
        foreign_languages = $8,
        security_experience_range = $9,
        guard_notes = $10,
        site_id = $11,
        assignment_status = $12
      WHERE id = $13
      RETURNING *
      `,
      [
        full_name,
        username,
        mobile_phone,
        landline_phone,
        tax_id,
        home_address,
        education_level,
        foreign_languages,
        security_experience_range,
        guard_notes,
        site_id,
        assignment_status,
        id,
      ]
    );

    res.json({
      status: "ok",
      guard: result.rows[0],
    });
  } catch (err) {
    console.error("Guard profile update error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// ----------------------------------------------------------
// ALL SITES
// ----------------------------------------------------------
app.get("/sites", async (req, res) => {
  try {
    const result = await pool.query(`
  SELECT
    s.id,
    s.company_id,
    s.name,
    s.location,
    s.status,
    s.created_at,
    s.site_phone,
s.full_address,
s.coverage_type,

    CASE
      WHEN s.status <> 'active' THEN 'Guarding suspended'
      ELSE COALESCE(active_guard.full_name, 'No active guard')
    END AS active_guard,

    (
      SELECT COUNT(*)
      FROM guards g2
      WHERE g2.site_id = s.id
        AND g2.active = true
    )::int AS guards_assigned,

    CASE
      WHEN s.status <> 'active' THEN 0
      ELSE (
        SELECT COUNT(*)
        FROM guard_sessions gs3
        WHERE gs3.site_id = s.id
          AND gs3.logout_time IS NULL
      )::int
    END AS on_duty,

    CASE
      WHEN s.status <> 'active' THEN 'Suspended'
      ELSE 'Active'
    END AS coverage_status

    ,
CASE
  WHEN s.status <> 'active' THEN 'Inactive'
  WHEN (
    SELECT COUNT(*)
    FROM guard_sessions gs3
    WHERE gs3.site_id = s.id
      AND gs3.logout_time IS NULL
  ) > 0 THEN 'Covered'
  ELSE 'No Guard'
END AS status_label,

CASE
  WHEN s.status <> 'active' THEN 'inactive'
  WHEN (
    SELECT COUNT(*)
    FROM guard_sessions gs3
    WHERE gs3.site_id = s.id
      AND gs3.logout_time IS NULL
  ) > 0 THEN 'normal'
  ELSE 'no-guard'
END AS status_class

  FROM sites s
  
  LEFT JOIN LATERAL (
    SELECT
      g.full_name
    FROM guard_sessions gs
    LEFT JOIN guards g
      ON g.id = gs.guard_id
    WHERE gs.site_id = s.id
      AND gs.logout_time IS NULL
    ORDER BY gs.login_time DESC
    LIMIT 1
  ) active_guard ON true

  WHERE s.status <> 'archived'

  ORDER BY s.id ASC
`);

    res.json({
      status: "ok",
      sites: result.rows
    });

  } catch (err) {
    console.error("Sites error:", err);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// ALERT RECIPIENTS TABLE
// ----------------------------------------------------------

async function ensureAlertRecipientsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_recipients (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(255),
      phone VARCHAR(50) NOT NULL,
      sms_enabled BOOLEAN DEFAULT true,
      voice_enabled BOOLEAN DEFAULT true,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// ----------------------------------------------------------
// ALERT HELPERS
// ----------------------------------------------------------

let lastAlertTestResult = null;

function getAlertRecipients() {
  const recipientsEnv =
    process.env.ALERT_RECIPIENTS ||
    process.env.ALERT_TARGET ||
    "";

  return recipientsEnv
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function getAlertRecipientsFromDatabase() {
  await ensureAlertRecipientsTable();

  const result = await pool.query(`
    SELECT
      id,
      full_name,
      phone,
      sms_enabled,
      voice_enabled,
      active
    FROM alert_recipients
    WHERE active = true
    ORDER BY id ASC
  `);

  return result.rows;
}

async function getEffectiveAlertRecipients() {
  const dbRecipients = await getAlertRecipientsFromDatabase();

  const envPhones = getAlertRecipients();

  const envRecipients = envPhones.map((phone, index) => ({
    id: `env-${index + 1}`,
    full_name: "Railway recipient",
    phone,
    sms_enabled: true,
    voice_enabled: true,
    active: true,
    source: "env"
  }));

  const combined = [...dbRecipients, ...envRecipients];

  const uniqueByPhone = new Map();

  combined.forEach((recipient) => {
    if (!recipient.phone) return;

    const normalizedPhone = recipient.phone.replace(/\s+/g, "");

    if (!uniqueByPhone.has(normalizedPhone)) {
      uniqueByPhone.set(normalizedPhone, {
        ...recipient,
        phone: normalizedPhone
      });
    }
  });

  return Array.from(uniqueByPhone.values());
}

async function ensureAlertEventsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(50) NOT NULL,
      source VARCHAR(100),
      status VARCHAR(50),
      recipients_count INTEGER DEFAULT 0,
      sms_sent INTEGER DEFAULT 0,
      sms_failed INTEGER DEFAULT 0,
      voice_attempted INTEGER DEFAULT 0,
      voice_status VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function ensureIncidentGuardResponsesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incident_guard_responses (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER REFERENCES incidents(id) ON DELETE CASCADE,
      guard_id INTEGER,
      site_id INTEGER,
      session_id INTEGER,
      question_key VARCHAR(100),
      question_text TEXT,
      answer TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// ----------------------------------------------------------
// ALERT RECIPIENTS API
// ----------------------------------------------------------

app.get("/settings/alert-recipients", async (req,res)=>{

try{

const recipients =
await getEffectiveAlertRecipients();

res.json({
status:"ok",
recipients
});

}catch(err){

console.error(
"Alert recipients GET error:",
err
);

res.status(500).json({
status:"error",
message:
err.message || String(err)
});

}

});


app.post("/settings/alert-recipients", async (req,res)=>{

try{

await ensureAlertRecipientsTable();

const {

full_name,
phone,
sms_enabled=true,
voice_enabled=true

}=req.body;

const result =
await pool.query(
`
INSERT INTO alert_recipients(

full_name,
phone,
sms_enabled,
voice_enabled

)

VALUES(
$1,$2,$3,$4
)

RETURNING *
`,
[
full_name,
phone,
sms_enabled,
voice_enabled
]
);

res.json({
status:"ok",
recipient:
result.rows[0]
});

}catch(err){

res.status(500).json({
status:"error",
message:err.message
});

}

});

app.put(
"/settings/alert-recipients/:id/toggle",
async (req,res)=>{

try{

const { id } = req.params;

const result =
await pool.query(
`
UPDATE alert_recipients

SET active =
NOT active

WHERE id=$1

RETURNING *
`,
[id]
);

res.json({
status:"ok",
recipient:
result.rows[0]
});

}catch(err){

res.status(500).json({
status:"error",
message:err.message
});

}

});

app.delete(
"/settings/alert-recipients/:id",
async (req,res)=>{

try{

const { id } = req.params;

await pool.query(
`
DELETE FROM alert_recipients
WHERE id=$1
`,
[id]
);

res.json({
status:"ok"
});

}catch(err){

res.status(500).json({
status:"error",
message:err.message
});

}

});

// ----------------------------------------------------------
// SETTINGS - SITES MANAGEMENT
// ----------------------------------------------------------

app.get("/settings/sites", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        company_id,
        name,
        location,
        status,
        required_shifts,
        full_address,
        coverage_type,
shift_rules,
site_phone,
shift_schedule,
residence_contact_name,
residence_contact_phone,
supervisor_contact_name,
supervisor_contact_phone,
operational_notes,
sop_text,
sop_file_url,
sop_title,
sop_version,
sop_updated_at,
general_notes,
access_instructions,
patrol_instructions,
emergency_instructions,
special_warnings,
        created_at
      FROM sites
      ORDER BY id ASC
    `);

    res.json({
      status: "ok",
      sites: result.rows
    });
  } catch (err) {
    console.error("Settings sites GET error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/settings/sites", async (req, res) => {
  try {
    const {
      name,
      location,
      required_shifts = 1
    } = req.body;

    if (!name) {
      return res.status(400).json({
        status: "error",
        message: "Site name is required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO sites (
        company_id,
        name,
        location,
        status,
        required_shifts,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,NOW())
      RETURNING *
      `,
      [
        1,
        name,
        location || "",
        "active",
        required_shifts
      ]
    );

    res.json({
      status: "ok",
      site: result.rows[0]
    });
  } catch (err) {
    console.error("Settings site POST error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/settings/sites/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      location,
      required_shifts,
      status,
      full_address,
      site_phone,
      shift_schedule,
      residence_contact_name,
      residence_contact_phone,
      supervisor_contact_name,
      supervisor_contact_phone,
      operational_notes,
      sop_text,
      sop_file_url,
      sop_title,
sop_version,
      coverage_type,
      shift_rules,
      general_notes,
      access_instructions,
      patrol_instructions,
      emergency_instructions,
      special_warnings
    } = req.body;

    const result = await pool.query(
      `
      UPDATE sites
      SET
        name = COALESCE($1, name),
        location = COALESCE($2, location),
        required_shifts = COALESCE($3, required_shifts),
        status = COALESCE($4, status),
        full_address = COALESCE($5, full_address),
        site_phone = COALESCE($6, site_phone),
        shift_schedule = COALESCE($7, shift_schedule),
        residence_contact_name = COALESCE($8, residence_contact_name),
        residence_contact_phone = COALESCE($9, residence_contact_phone),
        supervisor_contact_name = COALESCE($10, supervisor_contact_name),
        supervisor_contact_phone = COALESCE($11, supervisor_contact_phone),
        operational_notes = COALESCE($12, operational_notes),
        sop_text = COALESCE($13, sop_text),
sop_file_url = COALESCE($14, sop_file_url),
sop_title = COALESCE($15, sop_title),
sop_version = COALESCE($16, sop_version),
sop_updated_at = CASE
  WHEN $13 IS NOT NULL OR $14 IS NOT NULL OR $15 IS NOT NULL OR $16 IS NOT NULL
  THEN NOW()
  ELSE sop_updated_at
END,
coverage_type = COALESCE($17, coverage_type),
shift_rules = COALESCE($18, shift_rules),
general_notes = COALESCE($19, general_notes),
access_instructions = COALESCE($20, access_instructions),
patrol_instructions = COALESCE($21, patrol_instructions),
emergency_instructions = COALESCE($22, emergency_instructions),
special_warnings = COALESCE($23, special_warnings)
WHERE id = $24
      RETURNING *
      `,
      [
        name || null,
        location || null,
        required_shifts || null,
        status || null,
        full_address || null,
        site_phone || null,
        shift_schedule || null,
        residence_contact_name || null,
        residence_contact_phone || null,
        supervisor_contact_name || null,
        supervisor_contact_phone || null,
        operational_notes || null,
        sop_text || null,
sop_file_url || null,
sop_title || null,
sop_version || null,
coverage_type || null,
shift_rules || null,
general_notes || null,
access_instructions || null,
patrol_instructions || null,
emergency_instructions || null,
special_warnings || null,
id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Site not found"
      });
    }

    res.json({
      status: "ok",
      site: result.rows[0]
    });
  } catch (err) {
    console.error("Settings site PUT error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post(
  "/settings/sites/:id/sop/upload",
  upload.single("sop_file"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "No SOP file uploaded",
        });
      }

      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({
          status: "error",
          message: "Only PDF files are allowed",
        });
      }

      const bucket =
        process.env.SUPABASE_SOP_BUCKET || "aegis-sop-files";

      const safeOriginalName = req.file.originalname
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9._-]/g, "");

      const filePath = `sites/site-${id}/sop-${Date.now()}-${safeOriginalName}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, req.file.buffer, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (uploadError) {
        console.error("Supabase SOP upload error:", uploadError);

        return res.status(500).json({
          status: "error",
          message: "Failed to upload SOP file",
          error: uploadError.message,
        });
      }

      const { data: publicUrlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(filePath);

      const publicUrl = publicUrlData.publicUrl;

      const result = await pool.query(
        `
        UPDATE sites
        SET
          sop_file_url = $1,
          sop_updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [publicUrl, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Site not found",
        });
      }

      res.json({
        status: "ok",
        message: "SOP file uploaded",
        site: result.rows[0],
        sop_file_url: publicUrl,
      });
    } catch (err) {
      console.error("SOP upload endpoint error:", err);

      res.status(500).json({
        status: "error",
        message: err.message,
      });
    }
  }
);

app.post(
  "/settings/sites/:id/documents/:slot/upload",
  upload.single("site_document"),
  async (req, res) => {
    try {
      const siteId = req.params.id;
      const slot = Number(req.params.slot);

      if (![1, 2].includes(slot)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid document slot",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "No document file uploaded",
        });
      }

      const fileExt = req.file.originalname.split(".").pop();
      const fileName = `sites/site-${siteId}/documents/document-${slot}-${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("aegis-sop-files")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data } = supabase.storage
        .from("aegis-sop-files")
        .getPublicUrl(fileName);

      const columnName = `document_${slot}_url`;

      await pool.query(
        `
        UPDATE sites
        SET ${columnName} = $1
        WHERE id = $2
        `,
        [data.publicUrl, siteId]
      );

      res.json({
        status: "ok",
        slot,
        document_url: data.publicUrl,
      });
    } catch (err) {
      console.error("Site document upload error:", err);

      res.status(500).json({
        status: "error",
        message: "Site document upload failed",
      });
    }
  }
);

app.put("/settings/sites/:id/toggle-active", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE sites
      SET status =
        CASE
          WHEN status = 'active' THEN 'inactive'
          ELSE 'active'
        END
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Site not found"
      });
    }

    res.json({
      status: "ok",
      site: result.rows[0]
    });
  } catch (err) {
    console.error("Site toggle error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/settings/sites/:id/archive", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE sites
      SET status = 'archived'
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Site not found"
      });
    }

    res.json({
      status: "ok",
      site: result.rows[0]
    });
  } catch (err) {
    console.error("Settings site archive error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// SETTINGS - GUARDS MANAGEMENT
// ----------------------------------------------------------

app.get("/settings/guards", async (req, res) => {
  try {
    const result = await pool.query(`
  SELECT
    g.id,
    g.full_name,
    g.username,
    g.phone,
    g.role,
    g.site_id,
    g.active,
    g.created_at,
    g.mobile_phone,
    g.landline_phone,
    g.tax_id,
    g.home_address,
    g.education_level,
    g.foreign_languages,
    g.security_experience_range,
    g.guard_notes,
    g.assignment_status,
    g.employment_status,
    s.name AS site_name
  FROM guards g
  LEFT JOIN sites s
    ON s.id = g.site_id
  ORDER BY g.id ASC
`);

    res.json({
      status: "ok",
      guards: result.rows
    });
  } catch (err) {
    console.error("Settings guards GET error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/settings/guards", async (req, res) => {
  try {
    const {
      full_name,
      username,
      phone,
      password,
      role = "guard",
      site_id
    } = req.body;

    if (!full_name || !username || !password || !site_id) {
      return res.status(400).json({
        status: "error",
        message: "full_name, username, password and site_id are required"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO guards (
        full_name,
        username,
        phone,
        role,
        site_id,
        active,
        password_hash,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,true,$6,NOW())
      RETURNING
        id,
        full_name,
        username,
        phone,
        role,
        site_id,
        active,
        created_at
      `,
      [
        full_name,
        username,
        phone || "",
        role,
        site_id,
        passwordHash
      ]
    );

    res.json({
      status: "ok",
      guard: result.rows[0]
    });
  } catch (err) {
    console.error("Settings guard POST error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/settings/guards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, username, phone, role, site_id, active } = req.body;

    const result = await pool.query(
      `
      UPDATE guards
      SET
        full_name = COALESCE($1, full_name),
        username = COALESCE($2, username),
        phone = COALESCE($3, phone),
        role = COALESCE($4, role),
        site_id = COALESCE($5, site_id),
        active = COALESCE($6, active)
      WHERE id = $7
      RETURNING
        id,
        full_name,
        username,
        phone,
        role,
        site_id,
        active,
        created_at
      `,
      [
        full_name || null,
        username || null,
        phone || null,
        role || null,
        site_id || null,
        typeof active === "boolean" ? active : null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Guard not found"
      });
    }

    res.json({
      status: "ok",
      guard: result.rows[0]
    });
  } catch (err) {
    console.error("Settings guard PUT error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/settings/guards/:id/toggle-active", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE guards
      SET active = NOT active
      WHERE id = $1
      RETURNING
        id,
        full_name,
        username,
        phone,
        role,
        site_id,
        active,
        created_at
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Guard not found"
      });
    }

    res.json({
      status: "ok",
      guard: result.rows[0]
    });
  } catch (err) {
    console.error("Settings guard toggle error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/settings/guards/:id/reset-password", async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        status: "error",
        message: "Password is required"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      UPDATE guards
      SET password_hash = $1
      WHERE id = $2
      RETURNING id, full_name, username
      `,
      [passwordHash, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Guard not found"
      });
    }

    res.json({
      status: "ok",
      guard: result.rows[0]
    });
  } catch (err) {
    console.error("Settings guard reset password error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// ALERT CONFIGURATION STATUS
// ----------------------------------------------------------
app.get("/settings/alert-configuration", async (req, res) => {
  try {
    const recipients = getAlertRecipients();

    const smsConfigured = Boolean(
      process.env.VONAGE_API_KEY &&
      process.env.VONAGE_API_SECRET &&
      process.env.VONAGE_SMS_FROM
    );

    const voiceConfigured = Boolean(
      process.env.VONAGE_APPLICATION_ID &&
      process.env.VONAGE_PRIVATE_KEY &&
      process.env.VONAGE_FROM_NUMBER
    );

    await ensureAlertEventsTable();

const lastTestResult = await pool.query(`
  SELECT *
  FROM alert_events
  WHERE event_type = 'test_alert'
  ORDER BY created_at DESC
  LIMIT 1
`);

    res.json({
      status: "ok",

      sms: {
        status: smsConfigured ? "online" : "error",
        configured: smsConfigured,
        recipients_count: recipients.length,
      },

      voice: {
        status: voiceConfigured ? "online" : "error",
        configured: voiceConfigured,
        recipients_count: recipients.length,
      },

      escalation: {
        status: recipients.length > 0 ? "online" : "error",
        order: recipients.length > 0 ? "configured" : "not configured",
      },

      last_test: lastTestResult.rows[0]
  ? {
      tested_at: lastTestResult.rows[0].created_at,
      recipients_count: lastTestResult.rows[0].recipients_count,
      sms: {
        sent: lastTestResult.rows[0].sms_sent,
        failed: lastTestResult.rows[0].sms_failed,
        status: lastTestResult.rows[0].sms_failed === 0 ? "online" : "error",
      },
      voice: {
        attempted: lastTestResult.rows[0].voice_attempted,
        status: lastTestResult.rows[0].voice_status,
      },
    }
  : null,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.get("/event-logs", async (req, res) => {
  try {
    await ensureAlertEventsTable();

    const result = await pool.query(`
      SELECT *
      FROM alert_events
      ORDER BY created_at DESC
      LIMIT 50
    `);

    res.json({
      status: "ok",
      logs: result.rows,
    });
  } catch (err) {
    console.error("Event logs error:", err);
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// ----------------------------------------------------------
// ANALYTICS SUMMARY
// ----------------------------------------------------------
app.get("/analytics/summary", async (req, res) => {
  try {
    const siteId = 1;

    const siteResult = await pool.query(
      `
      SELECT
        id,
        name,
        location,
        required_shifts
      FROM sites
      WHERE id = $1
      `,
      [siteId]
    );

    if (siteResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Site not found"
      });
    }

    const site = siteResult.rows[0];

    const alertsResult = await pool.query(
      `
      SELECT COUNT(*)::int AS alerts_count
      FROM alert_events
      WHERE site_id = $1
      `,
      [siteId]
    );

    const guardsResult = await pool.query(
      `
      SELECT COUNT(*)::int AS assigned_guards
      FROM guards
      WHERE site_id = $1
      AND active = true
      `,
      [siteId]
    );

    const alertsCount = alertsResult.rows[0].alerts_count;
    const assignedGuards = guardsResult.rows[0].assigned_guards;
    const requiredShifts = site.required_shifts;

    let riskLevel = "No Data";

    if (alertsCount > 0 && alertsCount <= 5) {
      riskLevel = "Normal";
    } else if (alertsCount >= 6 && alertsCount <= 10) {
      riskLevel = "Medium";
    } else if (alertsCount >= 11) {
      riskLevel = "High";
    }

    let readinessRatio = null;
    let readinessLevel = "No Data";

    if (assignedGuards > 0 && requiredShifts > 0) {
      readinessRatio = Number(
        (assignedGuards / requiredShifts).toFixed(2)
      );

      if (readinessRatio >= 1.3) {
        readinessLevel = "High";
      } else if (readinessRatio >= 1) {
        readinessLevel = "Medium";
      } else {
        readinessLevel = "Low";
      }
    }

    res.json({
      status: "ok",
      updated_at: new Date().toISOString(),

      site: {
        id: site.id,
        name: site.name,
        location: site.location
      },

      alerts: {
        count: alertsCount,
        risk_level: riskLevel
      },

      readiness: {
        assigned_guards: assignedGuards,
        required_shifts: requiredShifts,
        ratio: readinessRatio,
        level: readinessLevel
      },

      fatigue: {
        level: "No Data",
        reason: "Guard shift history is not connected yet"
      },

      stability: {
        score: "No Data",
        reason: "Stability requires fatigue data"
      }
    });

  } catch (err) {
    console.error("Analytics summary error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ----------------------------------------------------------
// DASHBOARD TEST ALERT
// ----------------------------------------------------------
app.post("/alerts/test", async (req, res) => {
  try {
    const allRecipients = await getEffectiveAlertRecipients();

const smsRecipients = allRecipients
  .filter((r) => r.sms_enabled)
  .map((r) => r.phone);

const voiceRecipients = allRecipients
  .filter((r) => r.voice_enabled)
  .map((r) => r.phone);

const recipients = allRecipients.map((r) => r.phone);

    if (recipients.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "No alert recipients configured",
      });
    }

    const text =
      `AEGIS LINK TEST ALERT\n` +
      `Source: Dashboard Settings\n` +
      `Time: ${new Date().toISOString()}`;

    const smsResults = await Promise.allSettled(
      smsRecipients.map((to) => sendVonageSms(to, text))
    );

    let callResults = [];

try {

console.log(
"VOICE RECIPIENTS:",
voiceRecipients
);

callResults =
await startVoiceCalls(
voiceRecipients
);

} catch (callErr) {

console.error(
"Test voice call failed:",
callErr
);

callResults = [
{
status:"error",
message:callErr.message
}
];

}

    const smsSent = smsResults.filter((r) => r.status === "fulfilled").length;
    const smsFailed = smsResults.filter((r) => r.status === "rejected").length;

    lastAlertTestResult = {
      tested_at: new Date().toISOString(),

      recipients_count: recipients.length,

      sms: {
        sent: smsSent,
        failed: smsFailed,
        status: smsFailed === 0 ? "online" : "error",
      },

      voice: {
        attempted: recipients.length,
        status:
          Array.isArray(callResults) && callResults.length > 0
            ? "online"
            : "error",
      },
    };

    await ensureAlertEventsTable();

await pool.query(
  `
  INSERT INTO alert_events (
    event_type,
    source,
    status,
    recipients_count,
    sms_sent,
    sms_failed,
    voice_attempted,
    voice_status
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `,
  [
    "test_alert",
    "Dashboard Settings",
    "completed",
    recipients.length,
    smsSent,
    smsFailed,
    recipients.length,
    lastAlertTestResult.voice.status,
  ]
);

    res.json({
      status: "ok",
      message: "Test alert executed",
      result: lastAlertTestResult,
    });
  } catch (err) {
    lastAlertTestResult = {
      tested_at: new Date().toISOString(),
      status: "error",
      message: err.message,
    };

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// ----------------------------------------------------------
// DASHBOARD SETTINGS CONFIG
// ----------------------------------------------------------
app.get("/settings/config", async (req, res) => {
  res.json({
    status: "ok",

    incident_rules: {
      timeline_reset: process.env.TIMELINE_RESET || "1 hour",
      default_priority: process.env.DEFAULT_PRIORITY || "High",
      ai_intake: process.env.AI_INTAKE_ENABLED === "true" ? "Enabled" : "Disabled",
    },

    guard_sessions: {
      heartbeat: process.env.GUARD_HEARTBEAT || "30 sec",
      offline_timeout: process.env.GUARD_OFFLINE_TIMEOUT || "90 sec",
      auto_close: process.env.GUARD_AUTO_CLOSE === "true" ? "Enabled" : "Disabled",
    },

    notifications: {
      desktop_alerts: process.env.DESKTOP_ALERTS_ENABLED === "true" ? "Enabled" : "Disabled",
      sound_alerts: process.env.SOUND_ALERTS_ENABLED === "true" ? "Enabled" : "Disabled",
      push_notifications: process.env.PUSH_NOTIFICATIONS_ENABLED === "true" ? "Enabled" : "Disabled",
    },
  });
});


// ----------------------------------------------------------
// SYSTEM STATUS
// ----------------------------------------------------------
app.get("/system/status", async (req, res) => {

  const startedAt = Date.now();

  try {

    let webAppStatus = "offline";

try {
  const webCheck = await fetch(
    "https://noctua76.github.io/noctua-panic-webapp/health.json",
    {
      cache: "no-store"
    }
  );

  if (webCheck.ok) {
    const webData = await webCheck.json();

    if (webData.status === "ok") {
      webAppStatus = "online";
    }
  }
} catch {
  webAppStatus = "offline";
}

    const status = {
      checked_at: new Date().toISOString(),
      overall_status: "operational",

      services: {

        web_app: {
         label: "Web App",
         status: webAppStatus
        },

        backend_api: {
          label: "Backend API",
          status: "operational",
          message: "Backend responding"
        },

        database: {
          label: "Database",
          status: "unknown"
        },

        guard_sessions: {
          label: "Guard Sessions",
          status: "unknown"
        },

        incidents: {
          label: "Incidents",
          status: "unknown"
        },

        sms_gateway: {
  label: "SMS Gateway",
  status:
    process.env.VONAGE_API_KEY &&
    process.env.VONAGE_API_SECRET &&
    process.env.VONAGE_SMS_FROM
      ? "operational"
      : "offline",
  configured:
    Boolean(
      process.env.VONAGE_API_KEY &&
      process.env.VONAGE_API_SECRET &&
      process.env.VONAGE_SMS_FROM
    )
},

        voice_calls: {
  label: "Voice Calls",
  status:
    process.env.VONAGE_APPLICATION_ID &&
    process.env.VONAGE_PRIVATE_KEY &&
    process.env.VONAGE_FROM_NUMBER
      ? "operational"
      : "offline",
  configured:
    Boolean(
      process.env.VONAGE_APPLICATION_ID &&
      process.env.VONAGE_PRIVATE_KEY &&
      process.env.VONAGE_FROM_NUMBER
    )
},

        ai_intake: {
  label: "AI Intake",
  status: process.env.OPENAI_API_KEY
    ? "operational"
    : "offline",
  configured: Boolean(process.env.OPENAI_API_KEY)
}

      }

    };

    // DATABASE

    const dbCheck =
      await pool.query(
        "SELECT NOW() AS server_time"
      );

    status.services.database = {
      label: "Database",
      status: "operational",
      server_time:
        dbCheck.rows[0].server_time
    };

    // ACTIVE GUARDS

    const guards =
      await pool.query(`
SELECT COUNT(*)::int AS active_guards

FROM guard_shifts

WHERE check_out_time IS NULL

AND last_seen >
NOW() - INTERVAL '90 seconds'
`);

    status.services.guard_sessions = {
      label: "Guard Sessions",
      status: "operational",
      active_guards:
        guards.rows[0].active_guards
    };

    // INCIDENTS

    const incidents =
      await pool.query(`
SELECT COUNT(*)::int AS active_incidents

FROM incidents

WHERE status IN (
'active',
'in_progress'
)
`);

    status.services.incidents = {
      label: "Incidents",
      status: "operational",
      active_incidents:
        incidents.rows[0]
        .active_incidents
    };

    status.response_time_ms =
      Date.now() - startedAt;

    res.json(status);

  } catch(err){

    console.error(
      "System status error:",
      err
    );

    res.status(500).json({
      overall_status:"degraded",
      message:err.message
    });

  }

});

// ----------------------------------------------------------
// Helper: Αποστολή SMS μέσω Vonage (κοινή λογική)
// ----------------------------------------------------------
async function sendVonageSms(to, text) {
  const params = new URLSearchParams();
  params.append('api_key', process.env.VONAGE_API_KEY);
  params.append('api_secret', process.env.VONAGE_API_SECRET);
  params.append('to', to);
  params.append('from', process.env.VONAGE_SMS_FROM || 'AegisLink');
  params.append('text', text);

  const response = await fetch('https://rest.nexmo.com/sms/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const data = await response.json();
  console.log('Vonage SMS Response:', data);
  return data;
}


// ----------------------------------------------------------
// Vonage SMS Test Route (χρησιμοποιεί το helper sendVonageSms)
// ----------------------------------------------------------
app.post('/test-sms', async (req, res) => {
  const { to, text } = req.body;

  if (!to || !text) {
    return res.status(400).json({ error: 'Required fields: to, text' });
  }

  try {
    const data = await sendVonageSms(to, text);
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('Vonage SMS Error:', err);
    res.status(500).json({ error: 'SMS failed', details: err.message });
  }
});

async function startVoiceCalls(recipients, context = {}) {
  const baseUrl = 'https://noctua-panic-backend-production.up.railway.app';

  const results = [];
  for (const to of recipients) {
    const r = await vonageVoice.voice.createOutboundCall({
  to: [{ type: 'phone', number: to.replace("+", "") }],
  from: { type: 'phone', number: process.env.VONAGE_FROM_NUMBER },
  answer_url: [`${baseUrl}/webhooks/answer`],
  event_url:  [`${baseUrl}/webhooks/event`],
  event_method: 'POST'
});

const callUuid = r.uuid || r.call_uuid || null;

await ensureAlertEventsTable();

await pool.query(
  `
  INSERT INTO alert_events (
    event_type,
    source,
    status,
    incident_id,
    site_id,
    guard_id,
    recipient_phone,
    voice_attempted,
    voice_status,
    provider,
    provider_call_uuid,
    event_payload
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `,
  [
    "VOICE_CALL_SUBMITTED",
    "vonage",
    "submitted",
    context.incidentId || null,
    context.siteId || null,
    context.guardId || null,
    to,
    1,
    "submitted",
    "vonage",
    callUuid,
    r
  ]
);

results.push({ to, response: r });
  }
  return results;
}

// === ALERT ENDPOINT used by the WebApp ===
app.post('/alert', async (req, res) => {
  console.log('ALERT ENDPOINT HIT:', req.body);

  const {
  siteId,
  guardId,
  triggeredAt,
  source,
  latitude,
  longitude,
  accuracy,
  battery,
  locationAddress
} = req.body || {};

  const recipientsEnv =
    process.env.ALERT_RECIPIENTS || process.env.ALERT_TARGET || '';

  const recipients = recipientsEnv
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    console.error('No alert recipients configured (ALERT_RECIPIENTS empty)');
    return res.status(500).json({
      status: 'error',
      message: 'No alert recipients configured on server.'
    });
  }

  const alertTime = triggeredAt || new Date().toISOString();
  const incidentRef = `INC-${Date.now()}`;

  const text =
    `NOCTUA PANIC ALERT\n` +
    `Site: ${siteId || 'N/A'}\n` +
    `Guard: ${guardId || 'N/A'}\n` +
    `Source: ${source || 'noctua-panic-webapp'}\n` +
    `Time: ${alertTime}`;

  try {
    const incidentResult = await pool.query(
  `
  INSERT INTO incidents (
    incident_ref,
    company_id,
    site_id,
    guard_ref,
    status,
    priority,
    trigger_time,
    resolved_time,
    auto_reset_time,
    ai_summary,
    needs_support,
    incident_latitude,
    incident_longitude,
    incident_accuracy,
    incident_battery_level,
    incident_address,
    incident_location_timestamp,
    created_at
  )
  SELECT
    $1,
    s.company_id,
    $2::int,
    $3::int,
    'active',
    'High',
    $4::timestamptz,
    NULL,
    $4::timestamptz + INTERVAL '2 minutes',
    $5,
    true,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11::timestamptz,
    NOW()
  FROM sites s
  WHERE s.id = $2::int
  RETURNING *
  `,
  [
    incidentRef,
    siteId || 1,
    guardId || null,
    alertTime,
    'Panic alert triggered from web app.',
    latitude || null,
    longitude || null,
    accuracy !== null && accuracy !== undefined ? Math.round(Number(accuracy)) : null,
    battery !== null && battery !== undefined ? Math.round(Number(battery)) : null,
    latitude && longitude
  ? await reverseGeocode(latitude, longitude)
  : locationAddress || null,
    triggeredAt || alertTime
  ]
);

    const incident = incidentResult.rows[0];

    const results = await Promise.all(
      recipients.map(to => sendVonageSms(to, text))
    );

    let callResults = [];

    try {
      callResults = await startVoiceCalls(recipients, {
  incidentId: incident.id,
  siteId: siteId || 1,
  guardId: guardId || null
});
    } catch (callErr) {
      console.error('Voice call failed (non-blocking):', callErr);
    }

    await ensureAlertEventsTable();

await pool.query(
  `
  INSERT INTO alert_events (
    event_type,
    source,
    status,
    incident_id,
    site_id,
    guard_id,
    recipients_count,
    sms_sent,
    sms_failed,
    voice_attempted,
    voice_status,
    provider
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
  )
  `,
  [
    "WEBAPP_ALERT",
    source || "webapp",
    "submitted",

    incident.id,
    siteId || 1,
    guardId || null,

    recipients.length,
    results.length,
    0,
    recipients.length,
    "submitted",

    "vonage"
  ]
);

    return res.json({
      status: 'ok',
      message: 'Alert received, incident created, SMS sent and voice calls started',
      incident: incidentResult.rows[0],
      recipients,
      smsResults: results,
      callResults
    });

  } catch (err) {
    console.error('Error processing panic alert from /alert:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Alert received but processing failed',
      error: err.message
    });
  }
});


// ----------------------------------------------------------
// Vonage Voice Webhooks (match Vonage Application URLs)
// ----------------------------------------------------------

function answerNcco(req, res) {
  console.log("VONAGE ANSWER HIT:", { method: req.method, query: req.query, body: req.body });

  const audioUrl = process.env.ALERT_AUDIO_URL;

  if (!audioUrl) {
    return res.status(500).json([{ action: "talk", text: "Audio URL is not configured." }]);
  }

  return res.json([{ action: "stream", streamUrl: [audioUrl] }]);
}

app.get('/webhooks/answer', answerNcco);
app.post('/webhooks/answer', answerNcco);

async function eventHook(req, res) {
  try {
    const payload = req.body || {};
    const callStatus = payload.status || "unknown";
    const callUuid = payload.uuid || payload.conversation_uuid || null;

    const incidentLookup = await pool.query(
      `
      SELECT
        incident_id,
        site_id,
        guard_id
      FROM alert_events
      WHERE provider_call_uuid = $1
        AND event_type = 'VOICE_CALL_SUBMITTED'
      ORDER BY id DESC
      LIMIT 1
      `,
      [callUuid]
    );

    const incidentInfo = incidentLookup.rows[0] || {};

    console.log("VONAGE VOICE EVENT:", {
      method: req.method,
      query: req.query,
      body: payload
    });

    await ensureAlertEventsTable();

    await pool.query(
      `
      INSERT INTO alert_events (
        event_type,
        source,
        status,
        incident_id,
        site_id,
        guard_id,
        voice_attempted,
        voice_status,
        provider,
        provider_call_uuid,
        event_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        "VOICE_WEBHOOK",
        "vonage",
        callStatus,

        incidentInfo.incident_id || null,
        incidentInfo.site_id || null,
        incidentInfo.guard_id || null,

        1,
        callStatus,
        "vonage",
        callUuid,
        payload
      ]
    );

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Vonage voice webhook error:", err);
    return res.status(200).send("ok");
  }
}

app.get('/webhooks/event', eventHook);
app.post('/webhooks/event', eventHook);
app.post("/incidents/create", async (req, res) => {
  try {
    const {
      site_id,
      guard_ref,
      priority = "high",
      ai_summary = "",
      needs_support = false,
    } = req.body;

    const incidentRef =
      `INC-${Date.now()}`;

    const result = await pool.query(
      `
      INSERT INTO incidents (
        incident_ref,
        site_id,
        guard_ref,
        status,
        priority,
        ai_summary,
        needs_support,
        auto_reset_time
      )
      VALUES (
        $1,$2,$3,
        'active',
        $4,$5,$6,
        NOW() + INTERVAL '2 hours'
      )
      RETURNING *
      `,
      [
        incidentRef,
        site_id,
        guard_ref,
        priority,
        ai_summary,
        needs_support,
      ]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "incident create failed"
    });
  }
});

app.get("/incidents/live", async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT
        i.id,
        i.incident_ref,
        i.status,
        i.priority,
        i.trigger_time,
        i.resolved_time,
        i.ai_summary,
        i.needs_support,
        i.incident_latitude,
i.incident_longitude,
i.incident_accuracy,
i.incident_battery_level,
i.incident_address,
i.incident_location_timestamp,

        s.name AS site_name,

        COALESCE(
          g.full_name,
          g.username
        ) AS guard_name

      FROM incidents i

      LEFT JOIN sites s
      ON s.id = i.site_id

      LEFT JOIN guards g
      ON g.id = i.guard_ref

      ORDER BY i.trigger_time DESC
    `);

    res.json(result.rows);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "live incidents failed"
    });
  }

});

app.get("/incidents/site-monitoring", async (req, res) => {
  try {
    await pool.query(`
  UPDATE incidents
SET
  status = 'in_progress'
WHERE status = 'active'
  AND auto_reset_time IS NOT NULL
  AND auto_reset_time <= NOW()
`);

    const result = await pool.query(`
      SELECT
        s.id AS site_id,
        s.name AS site_name,
        s.location AS site_location,
        s.status AS site_status,

        COALESCE(gs.full_name, gs.username, 'No active guard') AS guard_name,

        i.id AS incident_id,
        i.incident_ref,
        i.status AS incident_status,
        i.priority,
        i.trigger_time,
        i.resolved_time,
        i.ai_summary,
        i.needs_support,
        i.incident_latitude,
i.incident_longitude,
i.incident_accuracy,
i.incident_battery_level,
i.incident_address,
i.incident_location_timestamp,
        ae.status AS alert_event_status,
        ae.sms_sent,
        ae.sms_failed,
        ae.voice_attempted,
        ae.voice_status,
        ae.has_call_submitted,
ae.has_call_ringing,
ae.has_call_answered,
ae.has_call_completed,

        CASE
  WHEN s.status <> 'active' THEN 'inactive'
  WHEN i.id IS NULL THEN 'normal'
  ELSE i.status
END AS display_status

      FROM sites s

      LEFT JOIN LATERAL (
  SELECT
    gs.site_id,
    g.full_name,
    g.username,
    gs.login_time
  FROM guard_sessions gs
  LEFT JOIN guards g
    ON g.id = gs.guard_id
  WHERE gs.site_id = s.id
    AND gs.logout_time IS NULL
  ORDER BY gs.login_time DESC
  LIMIT 1
) gs ON true

      LEFT JOIN LATERAL (
  SELECT *
  FROM incidents i
  WHERE i.site_id = s.id
    AND (
      (
        i.status = 'active'
        AND (
          i.auto_reset_time IS NULL
          OR i.auto_reset_time > NOW()
        )
      )
      OR i.status = 'in_progress'
    )
  ORDER BY i.trigger_time DESC
  LIMIT 1
) i ON true
       LEFT JOIN LATERAL (
  SELECT
    ae.*,

    EXISTS (
      SELECT 1
      FROM alert_events e
      WHERE e.incident_id = i.id
        AND e.event_type = 'VOICE_CALL_SUBMITTED'
    ) AS has_call_submitted,

    EXISTS (
      SELECT 1
      FROM alert_events e
      WHERE e.incident_id = i.id
        AND e.event_type = 'VOICE_WEBHOOK'
        AND e.status = 'ringing'
    ) AS has_call_ringing,

    EXISTS (
      SELECT 1
      FROM alert_events e
      WHERE e.incident_id = i.id
        AND e.event_type = 'VOICE_WEBHOOK'
        AND e.status = 'answered'
    ) AS has_call_answered,

    EXISTS (
      SELECT 1
      FROM alert_events e
      WHERE e.incident_id = i.id
        AND e.event_type = 'VOICE_WEBHOOK'
        AND e.status = 'completed'
    ) AS has_call_completed

  FROM alert_events ae
  WHERE ae.event_type = 'WEBAPP_ALERT'
    AND ae.incident_id = i.id
  ORDER BY ae.created_at DESC
  LIMIT 1
) ae ON true

      ORDER BY s.id ASC
    `);

    const cards = result.rows.map((row) => ({
      siteId: row.site_id,
      title: row.site_name,
      site: row.site_name,
      location: row.site_location,

      guard:
  row.display_status === "inactive"
    ? "Guarding suspended"
    : row.guard_name || "Waiting for guard check-in",

      status: row.display_status || "normal",
      priority: row.priority || "Normal",

      incidentId: row.incident_ref || null,
      incidentDbId: row.incident_id || null,
      triggerTime: row.trigger_time || null,
      resolvedTime: row.resolved_time || null,
      incidentLatitude: row.incident_latitude || null,
incidentLongitude: row.incident_longitude || null,
incidentAccuracy: row.incident_accuracy || null,
incidentBatteryLevel: row.incident_battery_level || null,
incidentAddress: row.incident_address || null,
incidentLocationTimestamp: row.incident_location_timestamp || null,
      
      triggerStatus: row.incident_id
  ? row.display_status === "resolved"
    ? "Completed"
    : "Received"
  : "Ready",

smsStatus: row.incident_id
  ? Number(row.sms_sent) > 0
    ? "Sent"
    : Number(row.sms_failed) > 0
    ? "Failed"
    : "Sending"
  : "Ready",

callStatus: row.incident_id
  ? row.has_call_completed
    ? "Completed"
    : row.has_call_answered
    ? "Answered"
    : row.has_call_ringing
    ? "Ringing"
    : row.has_call_submitted
    ? "Dialing"
    : "Pending"
  : "Ready",

aiStatus: row.incident_id
  ? row.alert_event_status === "completed"
    ? "Completed"
    : "Processing"
  : "Ready",

      aiSummary: row.ai_summary || null,
      escalation: row.needs_support ? "Supervisor required" : "Standby",
    }));

    res.json({
      status: "ok",
      cards,
    });
  } catch (err) {
    console.error("Site monitoring error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.get("/incidents/:id/guard-responses", async (req, res) => {
  try {
    await ensureIncidentGuardResponsesTable();

    const incidentId = req.params.id;

    const result = await pool.query(
      `
      SELECT
        id,
        incident_id,
        guard_id,
        site_id,
        session_id,
        question_key,
        question_text,
        answer,
        created_at
      FROM incident_guard_responses
      WHERE incident_id = $1
      ORDER BY created_at ASC
      `,
      [incidentId]
    );

    res.json({
      status: "ok",
      responses: result.rows,
      guard_notes: result.rows
        .map((row) => `${row.question_text}\n${row.answer}`)
        .join("\n\n")
    });

  } catch (err) {
    console.error("Guard responses error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/incidents/:id/resolve", async (req, res) => {
  try {
    const incidentId = req.params.id;

    const {
      supervisor_notified,
      supervisor_name,
      supervisor_notes,

      guard_contacted,
      guard_contacted_name,
      guard_notes,

      residence_contacted,
      residence_contacted_name,
      residence_notes,

      admin_notes,
      approved_by,
    } = req.body;

    await pool.query(
      `
      INSERT INTO incident_resolution_actions (
        incident_id,
        supervisor_notified,
        supervisor_name,
        supervisor_notes,
        guard_contacted,
        guard_contacted_name,
        guard_notes,
        residence_contacted,
        residence_contacted_name,
        residence_notes,
        admin_notes,
        approved_by,
        approved_at
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,
        $8,$9,$10,
        $11,$12,
        NOW()
      )
      `,
      [
        incidentId,

        supervisor_notified,
        supervisor_name,
        supervisor_notes,

        guard_contacted,
        guard_contacted_name,
        guard_notes,

        residence_contacted,
        residence_contacted_name,
        residence_notes,

        admin_notes,
        approved_by,
      ]
    );

    await pool.query(
      `
      UPDATE incidents
      SET
        status = 'resolved',
        resolved_time = NOW()
      WHERE id = $1
      `,
      [incidentId]
    );

    res.json({
      status: "ok",
      message: "Incident resolved",
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.get("/incidents/resolved", async (req, res) => {
  try {
    const { date, site_id } = req.query;

    const values = [];
    let query = `
      SELECT
        i.id,
        i.incident_ref,
        i.status,
        i.priority,
        i.trigger_time,
        i.resolved_time,
        i.ai_summary,
        i.needs_support,
        i.incident_latitude,
i.incident_longitude,
i.incident_accuracy,
i.incident_battery_level,
i.incident_address,
i.incident_location_timestamp,

        s.id AS site_id,
        s.name AS site_name,
        s.location AS site_location,

        COALESCE(g.full_name, g.username, 'Unknown guard') AS guard_name,

        ira.supervisor_notified,
        ira.supervisor_name,
        ira.supervisor_notes,
        ira.guard_contacted,
        ira.guard_contacted_name,
        ira.guard_notes,
        ira.residence_contacted,
        ira.residence_contacted_name,
        ira.residence_notes,
        ira.admin_notes,
        ira.approved_by,
        ira.approved_at

      FROM incidents i

      LEFT JOIN sites s
        ON s.id = i.site_id

      LEFT JOIN guards g
        ON g.id = i.guard_ref

      LEFT JOIN LATERAL (
        SELECT *
        FROM incident_resolution_actions ira
        WHERE ira.incident_id = i.id
        ORDER BY ira.approved_at DESC
        LIMIT 1
      ) ira ON true

      WHERE i.status = 'resolved'
    `;

    if (date) {
      values.push(date);
      query += `
        AND DATE(i.resolved_time) = $${values.length}::date
      `;
    }

    if (site_id) {
      values.push(site_id);
      query += `
        AND i.site_id = $${values.length}
      `;
    }

    query += `
      ORDER BY i.resolved_time DESC
      LIMIT 10
    `;

    const result = await pool.query(query, values);

    res.json({
      status: "ok",
      incidents: result.rows,
    });

  } catch (err) {
    console.error("Resolved incidents error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.post("/setup/alert-events-upgrade", async (req, res) => {
  try {
    await ensureAlertEventsTable();

    await pool.query(`
      ALTER TABLE alert_events
      ADD COLUMN IF NOT EXISTS incident_id INTEGER,
      ADD COLUMN IF NOT EXISTS site_id INTEGER,
      ADD COLUMN IF NOT EXISTS guard_id INTEGER,
      ADD COLUMN IF NOT EXISTS recipient_phone VARCHAR(50),
      ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
      ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
      ADD COLUMN IF NOT EXISTS provider_call_uuid TEXT,
      ADD COLUMN IF NOT EXISTS event_payload JSONB
    `);

    res.json({
      status: "ok",
      message: "alert_events upgraded"
    });
  } catch (err) {
    console.error("Alert events upgrade error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/setup/sites-profile-upgrade", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS full_address TEXT,
      ADD COLUMN IF NOT EXISTS site_phone VARCHAR(50),
      ADD COLUMN IF NOT EXISTS shift_schedule TEXT,
      ADD COLUMN IF NOT EXISTS residence_contact_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS residence_contact_phone VARCHAR(50),
      ADD COLUMN IF NOT EXISTS supervisor_contact_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS supervisor_contact_phone VARCHAR(50),
      ADD COLUMN IF NOT EXISTS operational_notes TEXT,
      ADD COLUMN IF NOT EXISTS sop_text TEXT,
      ADD COLUMN IF NOT EXISTS sop_file_url TEXT
    `);

    res.json({
      status: "ok",
      message: "Sites profile fields added"
    });
  } catch (err) {
    console.error("Sites profile upgrade error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/setup/sites-shift-rules-upgrade", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS coverage_type VARCHAR(50) DEFAULT '24_7',
      ADD COLUMN IF NOT EXISTS shift_rules JSONB
    `);

    res.json({
      status: "ok",
      message: "Site shift rules fields added"
    });
  } catch (err) {
    console.error("Site shift rules upgrade error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/setup/sites-operational-notes-upgrade", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE sites
      ADD COLUMN IF NOT EXISTS general_notes TEXT,
      ADD COLUMN IF NOT EXISTS access_instructions TEXT,
      ADD COLUMN IF NOT EXISTS patrol_instructions TEXT,
      ADD COLUMN IF NOT EXISTS emergency_instructions TEXT,
      ADD COLUMN IF NOT EXISTS special_warnings TEXT
    `);

    res.json({
      status: "ok",
      message: "Site operational notes fields added"
    });
  } catch (err) {
    console.error("Site operational notes upgrade error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

function formatDuration(ms) {
  if (!ms || ms < 0) return "N/A";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function formatReportTime(value) {
  if (!value) return null;

  return new Date(value).toLocaleString("el-GR", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

app.get("/incidents/:id/report", async (req, res) => {
  try {
    const incidentId = req.params.id;

    const incidentResult = await pool.query(
      `
      SELECT
        i.id,
        i.incident_ref,
        i.status,
        i.priority,
        i.trigger_time,
        i.resolved_time,
        i.ai_summary,
        i.needs_support,
        i.needs_support,
i.incident_latitude,
i.incident_longitude,
i.incident_accuracy,
i.incident_battery_level,
i.incident_address,
i.incident_location_timestamp,
        s.name AS site_name,
        s.location AS site_location,
        COALESCE(g.full_name, g.username, 'Unknown guard') AS guard_name
      FROM incidents i
      LEFT JOIN sites s ON s.id = i.site_id
      LEFT JOIN guards g ON g.id = i.guard_ref
      WHERE i.id = $1
      `,
      [incidentId]
    );

    if (incidentResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Incident not found",
      });
    }

    const incident = incidentResult.rows[0];

    const guardResponsesResult = await pool.query(
      `
      SELECT
        question_key,
        question_text,
        answer,
        created_at
      FROM incident_guard_responses
      WHERE incident_id = $1
      ORDER BY created_at ASC
      `,
      [incidentId]
    );

    const resolutionResult = await pool.query(
      `
      SELECT
        supervisor_name,
        supervisor_notes,
        guard_contacted_name,
        guard_notes,
        residence_contacted_name,
        residence_notes,
        admin_notes,
        approved_by,
        approved_at
      FROM incident_resolution_actions
      WHERE incident_id = $1
      ORDER BY approved_at DESC
      LIMIT 1
      `,
      [incidentId]
    );

    const alertEventsResult = await pool.query(
  `
  SELECT
    id,
    event_type,
    source,
    status,
    sms_sent,
    sms_failed,
    voice_attempted,
    voice_status,
    recipient_phone,
    provider,
    provider_call_uuid,
    event_payload,
    created_at
  FROM alert_events
  WHERE incident_id = $1
  ORDER BY created_at ASC, id ASC
  `,
  [incidentId]
);

    const guardResponses = guardResponsesResult.rows;
    const resolution = resolutionResult.rows[0] || null;
    const alertEvents = alertEventsResult.rows;

    const durationMs =
      incident.trigger_time && incident.resolved_time
        ? new Date(incident.resolved_time) - new Date(incident.trigger_time)
        : null;

    const timeline = [];

alertEvents.forEach((event) => {
  if (event.event_type === "WEBAPP_ALERT") {
    timeline.push({
      event: "Alert Triggered",
      timestamp: event.created_at,
      display_time: formatReportTime(event.created_at),
    });

    if (Number(event.sms_sent) > 0) {
      timeline.push({
        event: `SMS Sent (${event.sms_sent})`,
        timestamp: event.created_at,
        display_time: formatReportTime(event.created_at),
      });
    }

    if (Number(event.sms_failed) > 0) {
      timeline.push({
        event: `SMS Failed (${event.sms_failed})`,
        timestamp: event.created_at,
        display_time: formatReportTime(event.created_at),
      });
    }

    return;
  }

  if (event.event_type === "VOICE_CALL_SUBMITTED") {
    timeline.push({
      event: event.recipient_phone
        ? `Voice Call Submitted (${event.recipient_phone})`
        : "Voice Call Submitted",
      timestamp: event.created_at,
      display_time: formatReportTime(event.created_at),
    });

    return;
  }

  if (event.event_type === "VOICE_WEBHOOK") {
    let label = `Voice Call ${event.status || "Event"}`;

    if (event.status === "started") {
      label = "Voice Call Started";
    }

    if (event.status === "ringing") {
      label = "Voice Call Ringing";
    }

    if (event.status === "answered") {
      label = "Voice Call Answered";
    }

    if (event.status === "completed") {
      const duration =
        event.event_payload?.duration ||
        event.event_payload?.duration_ms ||
        null;

      label = duration
        ? `Voice Call Completed (${duration} sec)`
        : "Voice Call Completed";
    }

    timeline.push({
      event: label,
      timestamp: event.created_at,
      display_time: formatReportTime(event.created_at),
    });
  }
});

if (guardResponses.length > 0) {
  const lastResponse = guardResponses[guardResponses.length - 1];

  timeline.push({
    event: "Guard Questions Completed",
    timestamp: lastResponse.created_at,
    display_time: formatReportTime(lastResponse.created_at),
  });
}

if (resolution?.approved_at) {
  timeline.push({
    event: "Investigation Completed",
    timestamp: resolution.approved_at,
    display_time: formatReportTime(resolution.approved_at),
  });
}

if (incident.resolved_time) {
  timeline.push({
    event: "Incident Resolved",
    timestamp: incident.resolved_time,
    display_time: formatReportTime(incident.resolved_time),
  });
}

    timeline.sort((a, b) => {
  const order = {
    "Alert Triggered": 1,
    "SMS Sent": 2,
    "SMS Failed": 3,
    "Voice Call Submitted": 4,
    "Voice Call Started": 5,
    "Voice Call Ringing": 6,
    "Voice Call Answered": 7,
    "Voice Call Completed": 8,
    "Guard Questions Completed": 9,
    "Investigation Completed": 10,
    "Incident Resolved": 11
  };

  const getOrder = (item) => {
    if (item.event?.startsWith("SMS Sent")) return order["SMS Sent"];
    if (item.event?.startsWith("SMS Failed")) return order["SMS Failed"];
    if (item.event?.startsWith("Voice Call Submitted")) return order["Voice Call Submitted"];
    if (item.event?.startsWith("Voice Call Completed")) return order["Voice Call Completed"];
    return order[item.event] || 99;
  };

  return (
    getOrder(a) - getOrder(b) ||
    new Date(a.timestamp) - new Date(b.timestamp)
  );
});

    res.json({
      status: "ok",
      report_title: "Aegis Link Security Incident Report",
      report_id: `RPT-${incident.incident_ref || incident.id}`,
      generated_at: new Date().toISOString(),
      generated_at_display: formatReportTime(new Date()),

      incident: {
        id: incident.id,
        incident_ref: incident.incident_ref,
        status: incident.status,
        priority: incident.priority,
        site: incident.site_name,
        site_location: incident.site_location,
        guard: incident.guard_name,
        trigger_time: incident.trigger_time,
        trigger_time_display: formatReportTime(incident.trigger_time),
        resolved_time: incident.resolved_time,
        resolved_time_display: formatReportTime(incident.resolved_time),
        duration_seconds: durationMs ? Math.floor(durationMs / 1000) : null,
        duration_display: formatDuration(durationMs),
        ai_summary: incident.ai_summary,
        needs_support: incident.needs_support,
        incident_latitude: incident.incident_latitude,
incident_longitude: incident.incident_longitude,
incident_accuracy: incident.incident_accuracy,
incident_battery_level: incident.incident_battery_level,
incident_address: incident.incident_address,
incident_location_timestamp: incident.incident_location_timestamp,
incident_location_timestamp_display: formatReportTime(
  incident.incident_location_timestamp
),
      },

      timeline,

      guard_responses: guardResponses.map((row) => ({
        question_key: row.question_key,
        question_text: row.question_text,
        answer: row.answer,
        created_at: row.created_at,
        created_at_display: formatReportTime(row.created_at),
      })),

      investigation: resolution
        ? {
            supervisor_name: resolution.supervisor_name,
            supervisor_notes: resolution.supervisor_notes,
            guard_contact_name: resolution.guard_contacted_name,
            guard_notes: resolution.guard_notes,
            residence_contact_name: resolution.residence_contacted_name,
            residence_notes: resolution.residence_notes,
            admin_notes: resolution.admin_notes,
            approved_by: resolution.approved_by,
            approved_at: resolution.approved_at,
            approved_at_display: formatReportTime(resolution.approved_at),
          }
        : null,
    });
  } catch (err) {
    console.error("Incident report error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to generate incident report",
      error: err.message,
    });
  }
});

function escapeHtml(value) {
  if (value === null || value === undefined) return "-";

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

app.get("/incidents/:id/report/pdf", async (req, res) => {
  let browser;

  try {
    const incidentId = req.params.id;

    const reportResponse = await fetch(
      `${req.protocol}://${req.get("host")}/incidents/${incidentId}/report`
    );

    const data = await reportResponse.json();

    if (data.status !== "ok") {
      return res.status(404).json({
        status: "error",
        message: "Report data not found",
      });
    }

    const timelineHtml = data.timeline
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.display_time)}</td>
            <td>${escapeHtml(
              item.event === "Voice Call online"
                ? "Voice Call Completed"
                : item.event
            )}</td>
          </tr>
        `
      )
      .join("");

    const responsesHtml = data.guard_responses
      .map(
        (item) => `
          <div style="margin-bottom:12px">
            <strong>${escapeHtml(item.question_text)}</strong><br/>
            ${escapeHtml(item.answer)}
          </div>
        `
      )
      .join("");

      const incidentLocationHtml =
  data.incident?.incident_latitude && data.incident?.incident_longitude
    ? `
      <h2>Incident Location</h2>

      <div class="summary-grid">
        <div class="summary-item">
          <span class="label">Address</span>
          <span class="value">${escapeHtml(data.incident.incident_address)}</span>
        </div>

        <div class="summary-item">
          <span class="label">Coordinates</span>
          <span class="value">
            ${escapeHtml(data.incident.incident_latitude)}, ${escapeHtml(data.incident.incident_longitude)}
          </span>
        </div>

        <div class="summary-item">
          <span class="label">Accuracy</span>
          <span class="value">${escapeHtml(data.incident.incident_accuracy)}m</span>
        </div>

        <div class="summary-item">
          <span class="label">Battery</span>
          <span class="value">${escapeHtml(data.incident.incident_battery_level)}%</span>
        </div>

        <div class="summary-item">
          <span class="label">Snapshot Time</span>
          <span class="value">${escapeHtml(data.incident.incident_location_timestamp_display)}</span>
        </div>

        <div class="summary-item">
          <span class="label">Map</span>
          <span class="value">
            https://www.google.com/maps?q=${escapeHtml(data.incident.incident_latitude)},${escapeHtml(data.incident.incident_longitude)}
          </span>
        </div>
      </div>
    `
    : "";

    const html = `
      <html>
        <head>
          <title>${escapeHtml(data.report_title)}</title>
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

            td {
              border-bottom: 1px solid #eee;
              padding: 9px 8px;
              font-size: 14px;
              vertical-align: top;
            }

            .notes {
              white-space: pre-line;
              line-height: 1.5;
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
              <strong>Security Incident Report</strong><br/>
              Report ID: ${escapeHtml(data.report_id)}<br/>
              Generated: ${escapeHtml(data.generated_at_display)}<br/>
              Generated By: System
            </div>
          </div>

          <div class="summary-grid">
            <div class="summary-item">
              <span class="label">Incident Ref</span>
              <span class="value">${escapeHtml(data.incident.incident_ref)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Duration</span>
              <span class="value">${escapeHtml(data.incident.duration_display)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Site</span>
              <span class="value">${escapeHtml(data.incident.site)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Guard</span>
              <span class="value">${escapeHtml(data.incident.guard)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Status</span>
              <span class="value">${escapeHtml(data.incident.status)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Priority</span>
              <span class="value">${escapeHtml(data.incident.priority)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Triggered</span>
              <span class="value">${escapeHtml(data.incident.trigger_time_display)}</span>
            </div>

            <div class="summary-item">
              <span class="label">Resolved</span>
              <span class="value">${escapeHtml(data.incident.resolved_time_display)}</span>
            </div>
          </div>

          ${incidentLocationHtml}

          <h2>Incident Timeline</h2>
          <table>${timelineHtml}</table>

          <h2>Guard Responses</h2>
          ${responsesHtml}

          <h2>Investigation Notes</h2>

          <p><strong>Supervisor:</strong> ${escapeHtml(data.investigation?.supervisor_name)}</p>

          <p><strong>Supervisor Notes:</strong><br/>
            <span class="notes">${escapeHtml(data.investigation?.supervisor_notes)}</span>
          </p>

          <p><strong>Guard Notes:</strong><br/>
            <span class="notes">${escapeHtml(data.investigation?.guard_notes)}</span>
          </p>

          <p><strong>Residence Notes:</strong><br/>
            <span class="notes">${escapeHtml(data.investigation?.residence_notes)}</span>
          </p>

          <p><strong>Admin Notes:</strong><br/>
            <span class="notes">${escapeHtml(data.investigation?.admin_notes)}</span>
          </p>

          <h2>Resolution Summary</h2>

          <p><strong>Approved By:</strong> ${escapeHtml(data.investigation?.approved_by)}</p>
          <p><strong>Approved At:</strong> ${escapeHtml(data.investigation?.approved_at_display)}</p>

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
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${data.report_id}.pdf"`
    );

    res.send(pdfBuffer);
  } catch (err) {
    if (browser) {
      await browser.close();
    }

    console.error("Incident PDF report error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to generate PDF report",
      error: err.message,
    });
  }
});

app.get("/setup/guard-location-upgrade", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE guard_sessions
      ADD COLUMN IF NOT EXISTS last_latitude DECIMAL(10,8),
      ADD COLUMN IF NOT EXISTS last_longitude DECIMAL(11,8),
      ADD COLUMN IF NOT EXISTS last_location_accuracy INTEGER,
      ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_speed DECIMAL(8,2),
      ADD COLUMN IF NOT EXISTS last_battery_level INTEGER,
      ADD COLUMN IF NOT EXISTS last_location_address TEXT;
    `);

    res.json({
      status: "ok",
      message: "Guard location fields added to guard_sessions"
    });
  } catch (err) {
    console.error("Guard location upgrade failed:", err);
    res.status(500).json({
      status: "error",
      message: "Guard location upgrade failed",
      detail: err.message
    });
  }
});

app.get("/setup/incident-location-upgrade", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE incidents
      ADD COLUMN IF NOT EXISTS incident_latitude DECIMAL(10,8),
      ADD COLUMN IF NOT EXISTS incident_longitude DECIMAL(11,8),
      ADD COLUMN IF NOT EXISTS incident_accuracy INTEGER,
      ADD COLUMN IF NOT EXISTS incident_battery_level INTEGER,
      ADD COLUMN IF NOT EXISTS incident_address TEXT,
      ADD COLUMN IF NOT EXISTS incident_location_timestamp TIMESTAMP;
    `);

    res.json({
      status: "ok",
      message: "Incident GPS snapshot fields added"
    });
  } catch (err) {
    console.error("Incident location upgrade failed:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.get("/setup/patrol-system", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patrol_points (
        id SERIAL PRIMARY KEY,
        site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
        point_name VARCHAR(255) NOT NULL,
        point_description TEXT,
        qr_token UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
        expected_interval_minutes INTEGER,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS patrol_scans (
        id SERIAL PRIMARY KEY,
        patrol_point_id INTEGER REFERENCES patrol_points(id) ON DELETE SET NULL,
        site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
        guard_id INTEGER REFERENCES guards(id) ON DELETE SET NULL,
        session_id INTEGER,

        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        accuracy INTEGER,
        battery_level INTEGER,
        address TEXT,

        scanned_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
  CREATE TABLE IF NOT EXISTS patrol_schedules (
    id SERIAL PRIMARY KEY,

    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    patrol_point_id INTEGER REFERENCES patrol_points(id) ON DELETE CASCADE,

    schedule_type VARCHAR(50) NOT NULL DEFAULT 'recurring',

    interval_hours INTEGER,
    start_time TIME,
    end_time TIME,

    scheduled_date DATE,
    scheduled_time TIME,

    reminder_minutes_before INTEGER DEFAULT 5,

    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  );
`);

    res.json({
      status: "ok",
      message: "QR Patrol system tables ready"
    });
  } catch (err) {
    console.error("QR Patrol setup failed:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/setup/patrol-logs-table", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patrol_logs (
        id SERIAL PRIMARY KEY,

        site_id INTEGER REFERENCES sites(id),
        point_id INTEGER REFERENCES patrol_points(id),
        guard_id INTEGER REFERENCES guards(id),

        qr_token TEXT,

        latitude NUMERIC,
        longitude NUMERIC,
        accuracy NUMERIC,

        patrol_time TIMESTAMP DEFAULT NOW(),

        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    res.json({
      status: "ok",
      message: "Patrol logs table ready"
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.get("/setup/patrol-log-lifecycle-upgrade", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE patrol_logs
      ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS delay_minutes INTEGER,
      ADD COLUMN IF NOT EXISTS completion_status TEXT DEFAULT 'completed',
      ADD COLUMN IF NOT EXISTS was_missed BOOLEAN DEFAULT false;
    `);

    res.json({
      status: "ok",
      message: "patrol_logs lifecycle columns added",
    });
  } catch (err) {
    console.error("Patrol log lifecycle upgrade error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to upgrade patrol_logs lifecycle",
      detail: err.message,
    });
  }
});

app.get("/setup/patrol-scan-window-upgrade", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE patrol_logs
      ADD COLUMN IF NOT EXISTS schedule_id INTEGER,
      ADD COLUMN IF NOT EXISTS schedule_type VARCHAR(50),
      ADD COLUMN IF NOT EXISTS session_id INTEGER,
      ADD COLUMN IF NOT EXISTS scan_available_from TIMESTAMP,
      ADD COLUMN IF NOT EXISTS scan_available_until TIMESTAMP;
    `);

    await pool.query(`
      ALTER TABLE patrol_schedules
      ADD COLUMN IF NOT EXISTS manual_status VARCHAR(50) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS created_by_admin_id INTEGER,
      ADD COLUMN IF NOT EXISTS created_by_username VARCHAR(255),
      ADD COLUMN IF NOT EXISTS created_by_role VARCHAR(100),
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS cancelled_by_username VARCHAR(255),
      ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
    `);

    res.json({
      status: "ok",
      message: "Patrol scan window upgrade completed",
    });
  } catch (err) {
    console.error("Patrol scan window upgrade error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to upgrade patrol scan window fields",
      detail: err.message,
    });
  }
});

// ----------------------------------------------------------
// QR PATROL POINTS API
// ----------------------------------------------------------

app.get("/settings/sites/:siteId/patrol-points", async (req, res) => {
  try {
    const { siteId } = req.params;

    const result = await pool.query(
      `
      SELECT
        id,
        site_id,
        point_name,
        point_description,
        qr_token,
        expected_interval_minutes,
        active,
        created_at
      FROM patrol_points
      WHERE site_id = $1
        AND active = true
      ORDER BY id ASC
      `,
      [siteId]
    );

    res.json({
      status: "ok",
      points: result.rows
    });
  } catch (err) {
    console.error("Load patrol points error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.get("/guard/patrols/board", async (req, res) => {
  try {
    const { guard_id, session_id } = req.query;

    if (!guard_id || !session_id) {
      return res.status(400).json({
        status: "error",
        message: "guard_id and session_id are required",
      });
    }

    const sessionResult = await pool.query(
      `
      SELECT
        gs.id AS session_id,
        gs.guard_id,
        gs.site_id,
        gs.login_time,
        gs.logout_time,
        g.full_name AS guard_name,
        s.name AS site_name,
        s.location AS site_location
      FROM guard_sessions gs
      LEFT JOIN guards g
        ON g.id = gs.guard_id
      LEFT JOIN sites s
        ON s.id = gs.site_id
      WHERE gs.id = $1
        AND gs.guard_id = $2
        AND gs.logout_time IS NULL
      LIMIT 1
      `,
      [session_id, guard_id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Active guard session not found",
      });
    }

    const session = sessionResult.rows[0];

    const boardResult = await pool.query(
      `
      WITH active_session AS (
        SELECT
          $1::int AS guard_id,
          $2::int AS session_id,
          $3::int AS site_id
      ),

      recurring_slots AS (
        SELECT
          NULL::integer AS schedule_instance_id,
          ps.id AS schedule_id,
          'recurring' AS schedule_type,
          ps.site_id,
          ps.patrol_point_id AS point_id,
          pp.point_name AS checkpoint,
          pp.qr_token,
          ps.reminder_minutes_before,
          gs.expected_slot AS scheduled_at
        FROM patrol_schedules ps

        JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
          AND pp.active = true

        CROSS JOIN LATERAL (
          SELECT
            (
              (ps.created_at AT TIME ZONE 'Europe/Athens')::date
              + ps.start_time
            ) AS anchor_time,
            (NOW() AT TIME ZONE 'Europe/Athens')::date AS day_start,
            ((NOW() AT TIME ZONE 'Europe/Athens')::date + INTERVAL '1 day') AS day_end
        ) w

        CROSS JOIN LATERAL generate_series(
          w.anchor_time,
          w.anchor_time + INTERVAL '365 days',
          (ps.interval_hours || ' hours')::interval
        ) AS gs(expected_slot)

        WHERE ps.schedule_type = 'recurring'
          AND ps.active = true
          AND ps.site_id = (SELECT site_id FROM active_session)
          AND ps.start_time IS NOT NULL
          AND ps.interval_hours IS NOT NULL
          AND gs.expected_slot >= w.day_start
          AND gs.expected_slot < w.day_end
      ),

      manual_slots AS (
        SELECT
          ps.id AS schedule_instance_id,
          ps.id AS schedule_id,
          'manual' AS schedule_type,
          ps.site_id,
          ps.patrol_point_id AS point_id,
          pp.point_name AS checkpoint,
          pp.qr_token,
          ps.reminder_minutes_before,
          (ps.scheduled_date::timestamp + ps.scheduled_time) AS scheduled_at
        FROM patrol_schedules ps

        JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
          AND pp.active = true

        WHERE ps.schedule_type = 'manual'
          AND ps.active = true
          AND ps.site_id = (SELECT site_id FROM active_session)
          AND ps.scheduled_date = (NOW() AT TIME ZONE 'Europe/Athens')::date
      ),

      patrol_items AS (
        SELECT * FROM recurring_slots
        UNION ALL
        SELECT * FROM manual_slots
      ),

      enriched AS (
        SELECT
          pi.*,

          (
            pi.scheduled_at
            - (COALESCE(pi.reminder_minutes_before, 5) || ' minutes')::interval
          ) AS scan_available_from,

          (
            pi.scheduled_at + INTERVAL '15 minutes'
          ) AS scan_available_until,

          EXISTS (
            SELECT 1
            FROM patrol_logs pl
            WHERE pl.site_id = pi.site_id
              AND pl.point_id = pi.point_id
              AND COALESCE(pl.schedule_type, pi.schedule_type) = pi.schedule_type
              AND (
                pi.schedule_type = 'manual'
                AND pl.schedule_id = pi.schedule_id
                OR
                pi.schedule_type = 'recurring'
                AND pl.scheduled_at = pi.scheduled_at
              )
          ) AS already_completed
        FROM patrol_items pi
      )

      SELECT
        schedule_instance_id,
        schedule_id,
        schedule_type,
        site_id,
        point_id,
        checkpoint,
        qr_token,
        reminder_minutes_before,
        to_char(scheduled_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS scheduled_at,
        to_char(scan_available_from, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS scan_available_from,
        to_char(scan_available_until, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS scan_available_until,

        CASE
          WHEN already_completed = true
            THEN 'completed'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') < scan_available_from
            THEN 'scheduled'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') >= scan_available_from
            AND (NOW() AT TIME ZONE 'Europe/Athens') < scheduled_at
            THEN 'due_soon'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') >= scheduled_at
            AND (NOW() AT TIME ZONE 'Europe/Athens') <= scan_available_until
            THEN 'overdue'

          WHEN (NOW() AT TIME ZONE 'Europe/Athens') > scan_available_until
            THEN 'missed'

          ELSE 'scheduled'
        END AS status,

        CASE
          WHEN already_completed = true THEN false
          WHEN (NOW() AT TIME ZONE 'Europe/Athens') >= scan_available_from
            AND (NOW() AT TIME ZONE 'Europe/Athens') <= scan_available_until
            THEN true
          ELSE false
        END AS scan_enabled,

        FLOOR(
          EXTRACT(
            EPOCH FROM (
              (NOW() AT TIME ZONE 'Europe/Athens') - scheduled_at
            )
          ) / 60
        )::int AS minutes_delta

      FROM enriched

      ORDER BY scheduled_at ASC, point_id ASC
      `,
      [guard_id, session_id, session.site_id]
    );

    const completedResult = await pool.query(
  `
  SELECT
    pl.id,
    pl.site_id,
    pl.point_id,
    pp.point_name AS checkpoint,
    COALESCE(pl.schedule_type, 'recurring') AS schedule_type,
    pl.schedule_id,
    pl.scheduled_at,
    pl.patrol_time,
    pl.delay_minutes,
    pl.completion_status,
    pl.was_missed,
    pl.latitude,
    pl.longitude,
    pl.accuracy,
    'completed' AS status,
    false AS scan_enabled
  FROM patrol_logs pl
  LEFT JOIN patrol_points pp
    ON pp.id = pl.point_id
  WHERE pl.guard_id = $1
    AND pl.session_id = $2
    AND pl.site_id = $3
    AND pl.patrol_time >= NOW() - INTERVAL '24 hours'
  ORDER BY pl.patrol_time DESC
  LIMIT 20
  `,
  [guard_id, session_id, session.site_id]
);

    res.json({
      status: "ok",
      guard: {
        id: session.guard_id,
        name: session.guard_name,
      },
      session: {
        id: session.session_id,
        site_id: session.site_id,
        login_time: session.login_time,
      },
      site: {
        id: session.site_id,
        name: session.site_name,
        location: session.site_location,
      },
      patrols: boardResult.rows,
      completed_patrols: completedResult.rows,
    });
  } catch (err) {
    console.error("Guard patrol board error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load guard patrol board",
      detail: err.message,
    });
  }
});

// ==========================
// Push Notifications
// ==========================

app.get("/push/vapid-public-key", (req, res) => {
  res.json({
    status: "ok",
    publicKey: process.env.VAPID_PUBLIC_KEY,
  });
});

app.post("/push/subscribe", async (req, res) => {
  try {
    const {
      guard_id,
      session_id,
      subscription,
      user_agent,
      device_name,
    } = req.body;

    if (!guard_id || !session_id || !subscription) {
      return res.status(400).json({
        status: "error",
        message: "guard_id, session_id and subscription are required",
      });
    }

    if (
      !subscription.endpoint ||
      !subscription.keys ||
      !subscription.keys.p256dh ||
      !subscription.keys.auth
    ) {
      return res.status(400).json({
        status: "error",
        message: "Invalid push subscription payload",
      });
    }

    const sessionResult = await pool.query(
      `
      SELECT id, guard_id, site_id, logout_time
      FROM guard_sessions
      WHERE id = $1
        AND guard_id = $2
        AND logout_time IS NULL
      LIMIT 1
      `,
      [session_id, guard_id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(403).json({
        status: "error",
        message: "No active guard session found",
      });
    }

    const activeSession = sessionResult.rows[0];

    const result = await pool.query(
      `
      INSERT INTO push_subscriptions (
        guard_id,
        session_id,
        site_id,
        endpoint,
        p256dh,
        auth,
        user_agent,
        device_name,
        active,
        created_at,
        last_seen
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), NOW())
      ON CONFLICT (endpoint)
      DO UPDATE SET
        guard_id = EXCLUDED.guard_id,
        session_id = EXCLUDED.session_id,
        site_id = EXCLUDED.site_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        device_name = EXCLUDED.device_name,
        active = TRUE,
        last_seen = NOW()
      RETURNING id, guard_id, session_id, site_id, active, created_at, last_seen
      `,
      [
        guard_id,
        session_id,
        activeSession.site_id,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        user_agent || req.headers["user-agent"] || null,
        device_name || null,
      ]
    );

    res.json({
      status: "ok",
      message: "Push subscription saved",
      subscription: result.rows[0],
    });
  } catch (err) {
    console.error("Push subscribe error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to save push subscription",
      detail: err.message,
    });
  }
});

async function sendPushNotificationToGuard(guardId, payload) {
  const subscriptions = await pool.query(
    `
    SELECT *
    FROM push_subscriptions
    WHERE guard_id = $1
      AND active = TRUE
    `,
    [guardId]
  );

  if (subscriptions.rows.length === 0) {
    return {
      status: "no_subscriptions",
      sent: [],
    };
  }

  const results = [];

  for (const sub of subscriptions.rows) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        },
        JSON.stringify(payload)
      );

      results.push({
        subscription_id: sub.id,
        success: true,
      });
    } catch (err) {
      console.error("Push send error:", err);

      results.push({
        subscription_id: sub.id,
        success: false,
        error: err.message,
      });
    }
  }

  return {
    status: "ok",
    sent: results,
  };
}

async function sendScanOpenPushIfNeeded({
  guardId,
  sessionId,
  siteId,
  scheduleId,
  scheduleType,
  scheduledAt,
  checkpoint,
  siteName,
  scanAvailableFrom,
}) {
  const notificationType = "scan_open";

  const existing = await pool.query(
    `
    SELECT id
    FROM patrol_push_notifications
    WHERE guard_id = $1
      AND site_id = $2
      AND schedule_id = $3
      AND schedule_type = $4
      AND scheduled_at = $5::timestamp
      AND notification_type = $6
    LIMIT 1
    `,
    [
      guardId,
      siteId,
      scheduleId,
      scheduleType,
      scheduledAt,
      notificationType,
    ]
  );

  if (existing.rows.length > 0) {
    return {
      status: "already_sent",
    };
  }

  const payload = {
  title: "Patrol Reminder",
  body: `${siteName || "Site"} · ${checkpoint || "Checkpoint"}\nScan window is now open.`,
  url: "/noctua-panic-webapp/patrol.html",
};

  const pushResult = await sendPushNotificationToGuard(guardId, payload);

  await pool.query(
    `
    INSERT INTO patrol_push_notifications (
      guard_id,
      session_id,
      site_id,
      schedule_id,
      schedule_type,
      scheduled_at,
      notification_type,
      sent_at,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7, NOW(), NOW())
    ON CONFLICT (
      guard_id,
      site_id,
      schedule_id,
      schedule_type,
      scheduled_at,
      notification_type
    )
    DO NOTHING
    `,
    [
      guardId,
      sessionId,
      siteId,
      scheduleId,
      scheduleType,
      scheduledAt,
      notificationType,
    ]
  );

  return {
    status: "sent",
    pushResult,
  };
}

let patrolPushSchedulerRunning = false;

async function runPatrolPushScheduler() {
  if (patrolPushSchedulerRunning) {
    return;
  }

  patrolPushSchedulerRunning = true;

  try {
    const dueSoonResult = await pool.query(
      `
      WITH active_sessions AS (
        SELECT
          gs.id AS session_id,
          gs.guard_id,
          gs.site_id,
          s.name AS site_name
        FROM guard_sessions gs
        LEFT JOIN sites s
          ON s.id = gs.site_id
        WHERE gs.logout_time IS NULL
      ),

      recurring_slots AS (
        SELECT
          NULL::integer AS schedule_instance_id,
          ps.id AS schedule_id,
          'recurring' AS schedule_type,
          ps.site_id,
          ps.patrol_point_id AS point_id,
          pp.point_name AS checkpoint,
          ps.reminder_minutes_before,
          gs.expected_slot AS scheduled_at
        FROM patrol_schedules ps

        JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
          AND pp.active = true

        CROSS JOIN LATERAL (
          SELECT
            (
              (ps.created_at AT TIME ZONE 'Europe/Athens')::date
              + ps.start_time
            ) AS anchor_time,
            (NOW() AT TIME ZONE 'Europe/Athens')::date AS day_start,
            ((NOW() AT TIME ZONE 'Europe/Athens')::date + INTERVAL '1 day') AS day_end
        ) w

        CROSS JOIN LATERAL generate_series(
          w.anchor_time,
          w.anchor_time + INTERVAL '365 days',
          (ps.interval_hours || ' hours')::interval
        ) AS gs(expected_slot)

        WHERE ps.schedule_type = 'recurring'
          AND ps.active = true
          AND ps.start_time IS NOT NULL
          AND ps.interval_hours IS NOT NULL
          AND gs.expected_slot >= w.day_start
          AND gs.expected_slot < w.day_end
      ),

      manual_slots AS (
        SELECT
          ps.id AS schedule_instance_id,
          ps.id AS schedule_id,
          'manual' AS schedule_type,
          ps.site_id,
          ps.patrol_point_id AS point_id,
          pp.point_name AS checkpoint,
          ps.reminder_minutes_before,
          (ps.scheduled_date::timestamp + ps.scheduled_time) AS scheduled_at
        FROM patrol_schedules ps

        JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
          AND pp.active = true

        WHERE ps.schedule_type = 'manual'
          AND ps.active = true
          AND ps.scheduled_date = (NOW() AT TIME ZONE 'Europe/Athens')::date
      ),

      patrol_items AS (
        SELECT * FROM recurring_slots
        UNION ALL
        SELECT * FROM manual_slots
      ),

      enriched AS (
        SELECT
          pi.*,
          (
            pi.scheduled_at
            - (COALESCE(pi.reminder_minutes_before, 5) || ' minutes')::interval
          ) AS scan_available_from,
          (
            pi.scheduled_at + INTERVAL '15 minutes'
          ) AS scan_available_until
        FROM patrol_items pi
      )

      SELECT
        e.schedule_id,
        e.schedule_type,
        e.site_id,
        e.point_id,
        e.checkpoint,
        e.reminder_minutes_before,
        e.scheduled_at,
        e.scan_available_from,
        e.scan_available_until,
        active_sessions.guard_id,
        active_sessions.session_id,
        active_sessions.site_name
      FROM enriched e

      JOIN active_sessions
        ON active_sessions.site_id = e.site_id

      WHERE (NOW() AT TIME ZONE 'Europe/Athens') >= e.scan_available_from
        AND (NOW() AT TIME ZONE 'Europe/Athens') < e.scheduled_at

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
            )
        )

      ORDER BY e.scheduled_at ASC, e.point_id ASC
      `
    );

    for (const patrol of dueSoonResult.rows) {
      await sendScanOpenPushIfNeeded({
        guardId: Number(patrol.guard_id),
        sessionId: Number(patrol.session_id),
        siteId: Number(patrol.site_id),
        scheduleId: Number(patrol.schedule_id),
        scheduleType: patrol.schedule_type,
        scheduledAt: patrol.scheduled_at,
        checkpoint: patrol.checkpoint,
        siteName: patrol.site_name,
        scanAvailableFrom: patrol.scan_available_from,
      });
    }
  } catch (err) {
    console.error("Patrol push scheduler error:", err);
  } finally {
    patrolPushSchedulerRunning = false;
  }
}

app.post("/push/test", async (req, res) => {
  try {
    const { guard_id } = req.body;

    if (!guard_id) {
      return res.status(400).json({
        status: "error",
        message: "guard_id is required",
      });
    }

    const payload = {
      title: "Aegis Link",
      body: "Test Push Notification",
      url: "/patrol.html",
    };

    const result = await sendPushNotificationToGuard(guard_id, payload);

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

app.post("/patrol/scan", async (req, res) => {
  try {
    const {
      schedule_id,
      schedule_type,
      scheduled_at,
      guard_id,
      session_id,
      qr_token,
      latitude,
      longitude,
      accuracy,
    } = req.body;

    if (
      !schedule_id ||
      !schedule_type ||
      !scheduled_at ||
      !guard_id ||
      !session_id ||
      !qr_token
    ) {
      return res.status(400).json({
        status: "error",
        message:
          "schedule_id, schedule_type, scheduled_at, guard_id, session_id and qr_token are required",
      });
    }

    if (!["manual", "recurring"].includes(schedule_type)) {
      return res.status(400).json({
        status: "error",
        message: "schedule_type must be manual or recurring",
      });
    }

    const sessionResult = await pool.query(
      `
      SELECT
        gs.id AS session_id,
        gs.guard_id,
        gs.site_id,
        gs.login_time,
        gs.logout_time
      FROM guard_sessions gs
      WHERE gs.id = $1
        AND gs.guard_id = $2
        AND gs.logout_time IS NULL
      LIMIT 1
      `,
      [session_id, guard_id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(403).json({
        status: "error",
        message: "Active guard session not found",
      });
    }

    const activeSession = sessionResult.rows[0];

    const patrolResult = await pool.query(
      `
      SELECT
        ps.id AS schedule_id,
        ps.schedule_type,
        ps.site_id,
        ps.patrol_point_id AS point_id,
        pp.point_name,
        pp.qr_token,
        pp.active AS point_active,
        ps.reminder_minutes_before,

        CASE
          WHEN ps.schedule_type = 'manual'
            THEN (ps.scheduled_date::timestamp + ps.scheduled_time)
          ELSE $3::timestamp
        END AS resolved_scheduled_at

      FROM patrol_schedules ps

      JOIN patrol_points pp
        ON pp.id = ps.patrol_point_id

      WHERE ps.id = $1
        AND ps.schedule_type = $2
        AND ps.active = true
        AND pp.active = true
      LIMIT 1
      `,
      [schedule_id, schedule_type, scheduled_at]
    );

    if (patrolResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Scheduled patrol not found or inactive",
      });
    }

    const patrol = patrolResult.rows[0];

    if (Number(patrol.site_id) !== Number(activeSession.site_id)) {
      return res.status(403).json({
        status: "error",
        message: "Patrol does not belong to active guard site",
      });
    }

    if (String(patrol.qr_token) !== String(qr_token)) {
      return res.status(403).json({
        status: "error",
        message: "QR token does not match this patrol checkpoint",
      });
    }

    const windowResult = await pool.query(
      `
      SELECT
        $1::timestamp AS scheduled_at,

        (
          $1::timestamp
          - (COALESCE($2::int, 5) || ' minutes')::interval
        ) AS scan_available_from,

        (
          $1::timestamp + INTERVAL '15 minutes'
        ) AS scan_available_until,

        (NOW() AT TIME ZONE 'Europe/Athens') AS now_athens
      `,
      [
        patrol.resolved_scheduled_at,
        patrol.reminder_minutes_before || 5,
      ]
    );

    const scanWindow = windowResult.rows[0];

    if (new Date(scanWindow.now_athens) < new Date(scanWindow.scan_available_from)) {
      return res.status(403).json({
        status: "error",
        message: "Scan not allowed yet",
        current_status: "scheduled",
        scan_enabled: false,
        scan_available_from: scanWindow.scan_available_from,
        scan_available_until: scanWindow.scan_available_until,
      });
    }

    if (new Date(scanWindow.now_athens) > new Date(scanWindow.scan_available_until)) {
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
        AND schedule_id = $3
        AND schedule_type = $4
        AND scheduled_at = $5::timestamp
      LIMIT 1
      `,
      [
        patrol.site_id,
        patrol.point_id,
        schedule_id,
        schedule_type,
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

    const delayResult = await pool.query(
      `
      SELECT
        GREATEST(
          0,
          FLOOR(
            EXTRACT(
              EPOCH FROM (
                (NOW() AT TIME ZONE 'Europe/Athens') - $1::timestamp
              )
            ) / 60
          )
        )::int AS delay_minutes
      `,
      [scanWindow.scheduled_at]
    );

    const delayMinutes = delayResult.rows[0].delay_minutes;

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
        scan_available_from,
        scan_available_until
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        NOW(),
        $9,$10,
        'completed',
        false,
        $11,$12,$13,$14
      )
      RETURNING *
      `,
      [
        patrol.site_id,
        patrol.point_id,
        guard_id,
        session_id,
        qr_token,
        latitude || null,
        longitude || null,
        accuracy || null,
        scanWindow.scheduled_at,
        delayMinutes,
        schedule_id,
        schedule_type,
        scanWindow.scan_available_from,
        scanWindow.scan_available_until,
      ]
    );

    if (schedule_type === "manual") {
      await pool.query(
        `
        UPDATE patrol_schedules
        SET
          active = false,
          manual_status = 'completed'
        WHERE id = $1
          AND schedule_type = 'manual'
        `,
        [schedule_id]
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

    res.status(500).json({
      status: "error",
      message: "Failed to complete patrol scan",
      detail: err.message,
    });
  }
});

app.post("/settings/sites/:siteId/patrol-points", async (req, res) => {
  try {
    const { siteId } = req.params;

    const {
      point_name,
      point_description,
      expected_interval_minutes
    } = req.body;

    if (!point_name) {
      return res.status(400).json({
        status: "error",
        message: "point_name is required"
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
        point_name,
        point_description || null,
        expected_interval_minutes || null
      ]
    );

    res.json({
      status: "ok",
      point: result.rows[0]
    });
  } catch (err) {
    console.error("Create patrol point error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.put("/settings/patrol-points/:id/deactivate", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE patrol_points
      SET active = false
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    res.json({
      status: "ok",
      point: result.rows[0]
    });
  } catch (err) {
    console.error("Deactivate patrol point error:", err);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.post("/settings/patrol-points/:id/generate-qr", async (req, res) => {
  try {
    const { id } = req.params;

    const qrToken = crypto.randomUUID();

    const result = await pool.query(
      `
      UPDATE patrol_points
      SET qr_token = $1
      WHERE id = $2
      RETURNING *
      `,
      [qrToken, id]
    );

    res.json({
      status: "ok",
      point: result.rows[0],
    });
  } catch (err) {
    console.error("Generate QR error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.put("/settings/patrol-points/:id/schedule", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      expected_interval_minutes,
    } = req.body;

    if (!expected_interval_minutes) {
      return res.status(400).json({
        status: "error",
        message: "expected_interval_minutes is required",
      });
    }

    const result = await pool.query(
      `
      UPDATE patrol_points
      SET expected_interval_minutes = $1
      WHERE id = $2
      RETURNING *
      `,
      [expected_interval_minutes, id]
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
    console.error("Update patrol point schedule error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.post("/settings/sites/:siteId/patrol-schedules/manual", async (req, res) => {
  try {
    const { siteId } = req.params;

    const {
      scheduled_date,
      scheduled_time,
      reminder_minutes_before = 5,
      created_by_admin_id,
      created_by_username,
      created_by_role,
    } = req.body;

    if (!scheduled_date || !scheduled_time) {
      return res.status(400).json({
        status: "error",
        message: "scheduled_date and scheduled_time are required",
      });
    }

    if (!created_by_username) {
      return res.status(400).json({
        status: "error",
        message: "created_by_username is required",
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
          reminder_minutes_before,
          created_by_admin_id || null,
          created_by_username,
          created_by_role || "admin",
        ]
      );

      inserted.push(result.rows[0]);
    }

    res.json({
      status: "ok",
      message: "Manual patrol schedule added",
      schedules: inserted,
    });
  } catch (err) {
    console.error("Manual patrol schedule error:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.post("/settings/sites/:siteId/patrol-schedules/recurring", async (req, res) => {
  try {
    const { siteId } = req.params;

    const {
  interval_hours,
  start_time,
  reminder_minutes_before = 5,
  schedule_scope = "24_7",
  created_by_admin_id,
  created_by_username,
  created_by_role,
} = req.body;

    if (!interval_hours) {
      return res.status(400).json({
        status: "error",
        message: "interval_hours is required",
      });
    }

    if (!start_time) {
  return res.status(400).json({
    status: "error",
    message: "start_time is required",
  });
}

if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start_time)) {
  return res.status(400).json({
    status: "error",
    message: "start_time must be in HH:mm format",
  });
}

if (!created_by_username) {
  return res.status(400).json({
    status: "error",
    message: "created_by_username is required",
  });
}

    const intervalMinutes = Number(interval_hours) * 60;

    const updatePointsResult = await pool.query(
  `
  UPDATE patrol_points
  SET expected_interval_minutes = $1
  WHERE site_id = $2
    AND active = true
  RETURNING id, point_name, expected_interval_minutes
  `,
  [intervalMinutes, siteId]
);

    await pool.query(
      `
      UPDATE patrol_schedules
      SET active = false
      WHERE site_id = $1
        AND schedule_type = 'recurring'
      `,
      [siteId]
    );

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

    const inserted = [];

    for (const point of pointsResult.rows) {
      const result = await pool.query(
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
VALUES ($1,$2,'recurring',$3,$4,$5,true,NOW(),$6,$7,$8)
RETURNING *
        `,
        [
  siteId,
  point.id,
  Number(interval_hours),
  start_time,
  Number(reminder_minutes_before),
  created_by_admin_id || null,
  created_by_username,
  created_by_role || "admin",
]
      );

      inserted.push(result.rows[0]);
    }

    res.json({
      status: "ok",
      message: "Recurring patrol schedule saved for site",
      interval_minutes: intervalMinutes,
      schedule_scope,
      updated_points_count: updatePointsResult.rowCount,
updated_points: updatePointsResult.rows,
      schedules: inserted,
    });
  } catch (err) {
    console.error("Recurring patrol schedule error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to save recurring patrol schedule",
      detail: err.message,
    });
  }
});

app.get("/settings/sites/:siteId/patrol-schedules", async (req, res) => {
  try {
    const { siteId } = req.params;

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
      WHERE ps.site_id = $1
      ORDER BY
        ps.active DESC,
        ps.created_at DESC,
        ps.id DESC
      `,
      [siteId]
    );

    res.json({
      status: "ok",
      schedules: result.rows,
    });
  } catch (err) {
    console.error("Get patrol schedules error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load patrol schedules",
      detail: err.message,
    });
  }
});

app.get("/patrols/sites", async (req, res) => {
  try {
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
    AND u.scheduled_at < (NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '15 minutes'
    THEN 'missed'

  WHEN u.schedule_type = 'manual'
    AND u.scheduled_at < (NOW() AT TIME ZONE 'Europe/Athens')
    THEN 'overdue'

  WHEN u.schedule_type = 'manual'
    AND u.scheduled_at <= (NOW() AT TIME ZONE 'Europe/Athens') + INTERVAL '5 minutes'
    THEN 'due_soon'

  WHEN u.schedule_type = 'recurring'
  AND u.scheduled_at < (NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '15 minutes'
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
  WHEN sn.next_patrol < (NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '15 minutes' THEN 'missed'
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

      WHERE ss.active_points > 0

      ORDER BY ss.site_id ASC
    `);

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

app.get("/patrols/sites/:siteId/details", async (req, res) => {
  const { siteId } = req.params;

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

app.get("/patrol-points/:id/qr", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        point_name,
        qr_token,
        active
      FROM patrol_points
      WHERE id = $1
      `,
      [id]
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

app.post("/guard/location", async (req, res) => {
  console.log("GPS REQUEST BODY:", req.body);
  try {
    const {
  guard_id,
  session_id,
  latitude,
  longitude,
  accuracy,
  speed,
  battery
} = req.body;

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

app.get("/guards/live-locations", async (req, res) => {
  try {
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
WHERE gs.logout_time IS NULL
ORDER BY g.full_name ASC
    `);

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
app.get("/debug/patrol-logs-columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'patrol_logs'
      ORDER BY ordinal_position
    `);

    res.json({
      status: "ok",
      columns: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      detail: err.message,
    });
  }
});
app.get("/debug/guard-sessions-columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_name = 'guard_sessions'
      ORDER BY ordinal_position
    `);

    res.json({
      status: "ok",
      columns: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      detail: err.message,
    });
  }
});
app.get("/debug/sites-columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_name = 'sites'
      ORDER BY ordinal_position
    `);

    res.json({
      status: "ok",
      columns: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      detail: err.message,
    });
  }
});
app.get("/debug/site-shift-rules/:siteId", async (req, res) => {
  const { siteId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        coverage_type,
        shift_rules
      FROM sites
      WHERE id = $1
      `,
      [siteId]
    );

    res.json({
      status: "ok",
      site: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      detail: err.message,
    });
  }
});
app.get("/debug/guard-sessions", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        gs.id,
        gs.guard_id,
        g.full_name,
        gs.site_id,
        gs.login_time,
        gs.logout_time,
        gs.status
      FROM guard_sessions gs
      LEFT JOIN guards g
        ON g.id = gs.guard_id
      ORDER BY gs.login_time DESC
      LIMIT 20
    `);

    res.json({
      status: "ok",
      sessions: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      detail: err.message,
    });
  }
});

app.get("/debug/patrol-schedules-columns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'patrol_schedules'
      ORDER BY ordinal_position
    `);

    res.json({
      status: "ok",
      columns: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      detail: err.message,
    });
  }
});

function resolveShiftLabel(site, scheduledAtValue) {
  try {
    const shiftRules = site?.shift_rules;

    if (!shiftRules || !Array.isArray(shiftRules.shifts)) {
      return "Shift rules not configured";
    }

    const scheduledAt = new Date(scheduledAtValue);

    const athensTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Athens",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(scheduledAt);

    const [currentHour, currentMinute] = athensTime.split(":").map(Number);
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

app.get("/patrols/missed-history", async (req, res) => {
  try {
    const { site_id, point_id, from, to, type = "all" } = req.query;

    const result = await pool.query(
      `
      WITH last_patrol_per_point AS (
        SELECT DISTINCT ON (pp.id)
          pp.id AS point_id,
          pp.site_id,
          pp.point_name,
          pp.expected_interval_minutes,
          pl.patrol_time AS last_patrol_time
        FROM patrol_points pp
        LEFT JOIN patrol_logs pl
          ON pl.point_id = pp.id
        WHERE pp.active = true
        ORDER BY pp.id, pl.patrol_time DESC NULLS LAST
      ),
      recurring_missed AS (
        SELECT
          CONCAT(
            'recurring-missed-',
            lpp.point_id,
            '-',
            EXTRACT(EPOCH FROM generated_at)
          ) AS id,
          lpp.site_id,
          s.name AS site_name,
          s.location AS site_location,
          lpp.point_id,
          lpp.point_name,
          generated_at AS scheduled_at,
          'recurring' AS schedule_type,
          'missed' AS status,
          NULL::text AS guard_name
        FROM last_patrol_per_point lpp
        CROSS JOIN LATERAL generate_series(
          lpp.last_patrol_time + (lpp.expected_interval_minutes || ' minutes')::interval,
          NOW(),
          (lpp.expected_interval_minutes || ' minutes')::interval
        ) AS generated_at
        LEFT JOIN sites s
          ON s.id = lpp.site_id
        WHERE lpp.last_patrol_time IS NOT NULL
          AND lpp.expected_interval_minutes IS NOT NULL
          AND generated_at < NOW()
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
        LEFT JOIN patrol_points pp
          ON pp.id = ps.patrol_point_id
        LEFT JOIN guard_sessions gs
          ON gs.site_id = ps.site_id
          AND gs.login_time <= (ps.scheduled_date + ps.scheduled_time)
          AND (
            gs.logout_time IS NULL
            OR gs.logout_time >= (ps.scheduled_date + ps.scheduled_time)
          )
        LEFT JOIN guards g
          ON g.id = gs.guard_id
        WHERE ps.schedule_type = 'manual'
          AND (ps.scheduled_date + ps.scheduled_time) < NOW()
          AND NOT EXISTS (
            SELECT 1
            FROM patrol_logs pl
            WHERE pl.point_id = ps.patrol_point_id
              AND pl.site_id = ps.site_id
              AND pl.patrol_time >= (ps.scheduled_date + ps.scheduled_time) - INTERVAL '10 minutes'
              AND pl.patrol_time <= (ps.scheduled_date + ps.scheduled_time) + INTERVAL '30 minutes'
          )
      ),
      combined AS (
        SELECT * FROM recurring_missed
        UNION ALL
        SELECT * FROM manual_missed
      )
      SELECT *
      FROM combined
      WHERE ($1::int IS NULL OR site_id = $1::int)
        AND ($2::int IS NULL OR point_id = $2::int)
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
      ORDER BY scheduled_at DESC
      LIMIT 300
      `,
      [
        site_id ? Number(site_id) : null,
        point_id ? Number(point_id) : null,
        from || null,
        to || null,
        type || "all",
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
    `,
    [siteIds]
  );

  sitesById = sitesResult.rows.reduce((acc, site) => {
    acc[site.id] = site;
    return acc;
  }, {});
}

const historyWithShift = result.rows.map((row) => {
  const site = sitesById[row.site_id];

  return {
    ...row,
    shift_label: resolveShiftLabel(site, row.scheduled_at),
  };
});

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

app.get("/patrols/missed-history/report/pdf", async (req, res) => {
  let browser;

  try {
    const { site_id, from, to, point_id, type = "all" } = req.query;

    const params = new URLSearchParams();

    if (site_id) params.append("site_id", site_id);
    if (from) params.append("from", from);
    if (to) params.append("to", to);
    if (point_id) params.append("point_id", point_id);
    if (type) params.append("type", type);

    const historyResponse = await fetch(
      `${req.protocol}://${req.get("host")}/patrols/missed-history?${params.toString()}`
    );

    const data = await historyResponse.json();

    if (data.status !== "ok") {
      return res.status(404).json({
        status: "error",
        message: "Missed patrol history not found",
      });
    }

    const history = data.history || [];

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
              new Date(item.scheduled_at).toLocaleString("el-GR", {
                timeZone: "Europe/Athens",
              })
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
                new Date().toLocaleString("el-GR", {
                  timeZone: "Europe/Athens",
                })
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

app.put("/patrols/manual/:scheduleId/cancel", async (req, res) => {
  try {
    const { scheduleId } = req.params;

    const {
      cancelled_by_username,
      cancel_reason = "Cancelled by admin",
    } = req.body;

    if (!cancelled_by_username) {
      return res.status(400).json({
        status: "error",
        message: "cancelled_by_username is required",
      });
    }

    const result = await pool.query(
      `
      UPDATE patrol_schedules
      SET
        active = false,
        manual_status = 'cancelled',
        cancelled_at = NOW(),
        cancelled_by_username = $2,
        cancel_reason = $3
      WHERE id = $1
        AND schedule_type = 'manual'
        AND cancelled_at IS NULL
      RETURNING *
      `,
      [
        scheduleId,
        cancelled_by_username,
        cancel_reason,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Manual patrol not found or already cancelled",
      });
    }

    res.json({
      status: "ok",
      message: "Manual patrol cancelled",
      manual_patrol: result.rows[0],
    });
  } catch (err) {
    console.error("Manual patrol cancel error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to cancel manual patrol",
      detail: err.message,
    });
  }
});

app.get("/patrols/manual-history", async (req, res) => {
  try {
    const { site_id } = req.query;

    const values = [];
    let whereClause = `
      WHERE ps.schedule_type = 'manual'
    `;

    if (site_id) {
      values.push(Number(site_id));
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
          WHERE pl.site_id = ps.site_id
            AND pl.point_id = ps.patrol_point_id
            AND pl.patrol_time >=
              (ps.scheduled_date::timestamp + ps.scheduled_time) - INTERVAL '10 minutes'
            AND pl.patrol_time <=
              (ps.scheduled_date::timestamp + ps.scheduled_time) + INTERVAL '24 hours'
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
            AND patrol_time <= scheduled_at + INTERVAL '15 minutes'
            THEN 'completed_late'

          WHEN patrol_log_id IS NOT NULL
            AND patrol_time > scheduled_at + INTERVAL '15 minutes'
            THEN 'missed_completed_late'

          WHEN patrol_log_id IS NULL
            AND NOW() <= scheduled_at + INTERVAL '15 minutes'
            THEN 'pending'

          WHEN patrol_log_id IS NULL
            AND NOW() > scheduled_at + INTERVAL '15 minutes'
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

app.get("/patrols/history", async (req, res) => {
  try {
    const countResult = await pool.query(`
  SELECT
    site_id,
    COUNT(*) AS total
  FROM patrol_logs
  WHERE patrol_time >= NOW() - INTERVAL '24 hours'
  GROUP BY site_id
`);
    const result = await pool.query(`
      SELECT
  pl.id,
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

LEFT JOIN sites s
  ON s.id = pl.site_id

LEFT JOIN patrol_points pp
  ON pp.id = pl.point_id

LEFT JOIN guards g
  ON g.id = pl.guard_id

ORDER BY pl.patrol_time DESC
LIMIT 50
    `);

    res.json({
  status: "ok",
  history: result.rows,
  completed_by_site: countResult.rows,
});
  } catch (err) {
    console.error("Patrol history load error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load patrol history",
      detail: err.message,
    });
  }
});

app.get("/patrols/completed-history", async (req, res) => {
  try {
    const {
      site_id,
      point_id,
      from,
      to,
      type = "all",
      status = "all",
    } = req.query;

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

      LEFT JOIN sites s
        ON s.id = pl.site_id

      LEFT JOIN patrol_points pp
        ON pp.id = pl.point_id

      LEFT JOIN guards g
        ON g.id = pl.guard_id

      WHERE 1=1

        AND ($1::int IS NULL OR pl.site_id = $1::int)
        AND ($2::int IS NULL OR pl.point_id = $2::int)

        AND (
          $3::date IS NULL
          OR (pl.patrol_time AT TIME ZONE 'Europe/Athens')::date >= $3::date
        )

        AND (
          $4::date IS NULL
          OR (pl.patrol_time AT TIME ZONE 'Europe/Athens')::date <= $4::date
        )

        AND (
          $5::text = 'all'
          OR COALESCE(pl.schedule_type, 'recurring') = $5::text
        )

        
      ORDER BY pl.patrol_time DESC
      LIMIT 300
      `,
      [
        site_id ? Number(site_id) : null,
        point_id ? Number(point_id) : null,
        from || null,
        to || null,
        type || "all",        
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
        `,
        [siteIds]
      );

      sitesById = sitesResult.rows.reduce((acc, site) => {
        acc[site.id] = site;
        return acc;
      }, {});
    }

    const historyWithShift = result.rows.map((row) => {
  const site = sitesById[row.site_id];

  let displayStatus = "completed";

  if (row.was_missed === true) {
    displayStatus = "missed_completed_late";
  } else if (row.completion_status === "completed_late") {
    displayStatus = "completed_late";
  } else if (row.completion_status === "missed_completed_late") {
    displayStatus = "missed_completed_late";
  } else {
    displayStatus = "completed";
  }

  return {
    ...row,
    display_status: displayStatus,
    shift_label: resolveShiftLabel(site, row.patrol_time),
  };
});

let filteredHistory = historyWithShift;

if (status && status !== "all") {
  filteredHistory = historyWithShift.filter(
    (row) => row.display_status === status
  );
}

    res.json({
      status: "ok",
      history: filteredHistory,
    });
  } catch (err) {
    console.error("Completed patrol history load error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to load completed patrol history",
      detail: err.message,
    });
  }
});

app.get("/patrols/completed-history/report/pdf", async (req, res) => {
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

    const params = new URLSearchParams();

    if (site_id) params.append("site_id", site_id);
    if (from) params.append("from", from);
    if (to) params.append("to", to);
    if (point_id) params.append("point_id", point_id);
    if (type) params.append("type", type);
    if (status) params.append("status", status);

    const historyResponse = await fetch(
      `${req.protocol}://${req.get("host")}/patrols/completed-history?${params.toString()}`
    );

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
    const missedCompletedLate = history.filter(
      (item) => item.display_status === "missed_completed_late"
    ).length;
    const completedOnTime = history.filter(
      (item) => item.display_status === "completed"
    ).length;

    const siteName = history[0]?.site_name || "Selected Site";
    const siteLocation = history[0]?.site_location || "-";

    const reportId = `COMPLETED-PATROL-${site_id || "ALL"}-${Date.now()}`;

    const formatStatus = (value) => {
      if (value === "missed_completed_late") return "Missed Completed Late";
      if (value === "completed_late") return "Completed Late";
      return "Completed";
    };

    const rowsHtml = history
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(
              new Date(item.patrol_time).toLocaleString("el-GR", {
                timeZone: "Europe/Athens",
              })
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
                new Date().toLocaleString("el-GR", {
                  timeZone: "Europe/Athens",
                })
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
                  : status === "missed_completed_late"
                  ? "Missed Completed Late"
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

            <div class="summary-item">
              <span class="label">Missed Completed Late</span>
              <span class="value">${escapeHtml(missedCompletedLate)}</span>
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

app.get("/debug/scheduled-shifts", async (req, res) => {
  const result = await pool.query(`
    SELECT
      id,
      site_id,
      scheduled_start,
      scheduled_end,
      shift_label
    FROM scheduled_shifts
    ORDER BY scheduled_start DESC
    LIMIT 20
  `);

  res.json(result.rows);
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

startScheduledShiftGenerator();
startShiftDelayMonitor();

setTimeout(runPatrolPushScheduler, 10000);

setInterval(runPatrolPushScheduler, 60000);






