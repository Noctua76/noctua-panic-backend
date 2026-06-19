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

app.post("/admin/heartbeat", async (req, res) => {

try{

const { username } = req.body;

await pool.query(
`
UPDATE admin_sessions

SET last_seen=NOW()

WHERE username=$1
AND is_active=true
`,
[username]
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

// --------------------------------------------------
// ADMIN LOGOUT
// --------------------------------------------------

app.post("/admin/logout", async (req,res)=>{

try{

const { username } = req.body;

await pool.query(
`
UPDATE admin_sessions

SET
logout_time = NOW(),
is_active = false,
last_seen = NOW(),
session_duration_seconds =
EXTRACT(EPOCH FROM (NOW() - login_time))

WHERE username = $1
AND is_active = true
`,
[username]
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

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials"
      });
    }

    const user = result.rows[0];
    

    if (user.status !== "active") {
  return res.status(403).json({
    status: "error",
    message: "User account is inactive"
  });
}
const validPassword = await bcrypt.compare(
  password,
  user.password_hash
);

    if (!validPassword) {
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials"
      });
    }
    await pool.query(
`
INSERT INTO admin_sessions (
  user_id,
  username,
  role,
  login_time,
  last_seen,
  is_active
)
VALUES ($1,$2,$3,NOW(),NOW(),true)
`,
[
  user.id,
  user.username,
  user.role
]
);

    res.json({
      status: "ok",
      message: "Login successful",
      user: {
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        role: user.role,
        must_change_password: user.must_change_password
      }
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

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

    await pool.query(
      `
      UPDATE guard_sessions
      SET
        logout_time = NOW(),
        status = 'auto_closed',
        last_heartbeat = NOW()
      WHERE guard_id = $1
        AND logout_time IS NULL
      `,
      [guard.id]
    );

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
        created_at
      )
      VALUES ($1,$2,NOW(),NOW(),'online',$3,$4,NOW())
      RETURNING *
      `,
      [
        guard.id,
        guard.site_id,
        device_info || null,
        req.ip || null
      ]
    );

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

    await pool.query(
      `
      UPDATE guard_sessions
      SET
        logout_time = NOW(),
        status = 'logged_out',
        last_heartbeat = NOW()
      WHERE id = $1
        AND guard_id = $2
        AND logout_time IS NULL
      `,
      [session_id, guard_id]
    );

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
// ----------------------------------------------------------
app.get("/guards/shifts/history", async (req, res) => {
  try {
    const result = await pool.query(`
  SELECT
    gs.id,
    NULL AS company_id,
    gs.guard_id,

    COALESCE(g.full_name, g.username, 'Unknown Guard') AS full_name,

    gs.site_id,
    s.name AS site_name,
    s.location AS site_location,

    NULL AS shift_start,
    NULL AS shift_end,

    gs.login_time AS check_in_time,
    gs.logout_time AS check_out_time,

    gs.last_heartbeat AS last_seen,

    (gs.logout_time IS NULL) AS online,

    CASE
      WHEN gs.logout_time IS NULL THEN 'active'
      WHEN gs.status = 'auto_closed' THEN 'abandoned'
      ELSE 'completed'
    END AS status,

    gs.login_time AS created_at,

    (
      gs.logout_time IS NULL
      AND gs.last_heartbeat > NOW() - INTERVAL '90 seconds'
    ) AS is_currently_online

  FROM guard_sessions gs

  LEFT JOIN guards g
    ON g.id = gs.guard_id

  LEFT JOIN sites s
    ON s.id = gs.site_id

  ORDER BY gs.login_time DESC
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

app.post("/patrol/scan", async (req, res) => {
  const {
    token,
    latitude,
    longitude,
    accuracy,
  } = req.body;

  if (!token) {
    return res.status(400).json({
      status: "error",
      message: "QR token is required",
    });
  }

  try {
    const pointResult = await pool.query(
      `
      SELECT
        pp.id AS point_id,
        pp.site_id,
        pp.point_name,
        pp.active,
pp.expected_interval_minutes,
s.name AS site_name
      FROM patrol_points pp
      LEFT JOIN sites s
        ON s.id = pp.site_id
      WHERE pp.qr_token = $1
      `,
      [token]
    );

    if (pointResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Invalid patrol QR token",
      });
    }

    const point = pointResult.rows[0];

    if (!point.active) {
      return res.status(403).json({
        status: "error",
        message: "This patrol point is inactive",
      });
    }

    const guardResult = await pool.query(
      `
      SELECT
        gs.guard_id
      FROM guard_sessions gs
      WHERE gs.site_id = $1
        AND gs.logout_time IS NULL
      ORDER BY gs.login_time DESC
      LIMIT 1
      `,
      [point.site_id]
    );

    const guardId =
      guardResult.rows.length > 0
        ? guardResult.rows[0].guard_id
        : null;

        const scheduleResult = await pool.query(
  `
  WITH manual_candidate AS (
    SELECT
      (ps.scheduled_date::timestamp + ps.scheduled_time) AS scheduled_at
    FROM patrol_schedules ps
    WHERE ps.patrol_point_id = $1
      AND ps.site_id = $2
      AND ps.schedule_type = 'manual'
      AND ps.active = true
      AND (ps.scheduled_date::timestamp + ps.scheduled_time) <= (NOW() AT TIME ZONE 'Europe/Athens')
    ORDER BY scheduled_at DESC
    LIMIT 1
  ),

  last_completed AS (
    SELECT MAX(pl.patrol_time) AS last_patrol_time
    FROM patrol_logs pl
    WHERE pl.point_id = $1
  ),

  recurring_candidate AS (
    SELECT
      CASE
        WHEN $3::int IS NULL THEN NULL
        WHEN lc.last_patrol_time IS NULL THEN NULL
        ELSE
          lc.last_patrol_time +
          (
            FLOOR(
              EXTRACT(EPOCH FROM (NOW() - lc.last_patrol_time))
              / 60
              / $3::int
            ) * $3::int || ' minutes'
          )::interval
      END AS scheduled_at
    FROM last_completed lc
  ),

  candidates AS (
  SELECT scheduled_at, 'manual' AS schedule_type FROM manual_candidate
  UNION ALL
  SELECT scheduled_at, 'recurring' AS schedule_type FROM recurring_candidate
)

  SELECT
  scheduled_at,
  schedule_type,
  GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (NOW() - scheduled_at)) / 60)
  )::int AS delay_minutes
FROM candidates
WHERE scheduled_at IS NOT NULL
  AND scheduled_at <= NOW()
ORDER BY
  CASE WHEN schedule_type = 'manual' THEN 0 ELSE 1 END,
  scheduled_at DESC
LIMIT 1
  `,
  [
    point.point_id,
    point.site_id,
    point.expected_interval_minutes || null,
  ]
);

const matchedSchedule = scheduleResult.rows[0] || null;

const scheduledAt = matchedSchedule?.scheduled_at || null;
const delayMinutes =
  matchedSchedule?.delay_minutes !== undefined
    ? matchedSchedule.delay_minutes
    : null;

const wasMissed =
  delayMinutes !== null && Number(delayMinutes) >= 15;

const completionStatus =
  delayMinutes === null
    ? "completed"
    : Number(delayMinutes) > 0
    ? "completed_late"
    : "completed_on_time";

    const insertResult = await pool.query(
  `
  INSERT INTO patrol_logs (
    site_id,
    point_id,
    guard_id,
    qr_token,
    latitude,
    longitude,
    accuracy,
    scheduled_at,
    delay_minutes,
    completion_status,
    was_missed
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  RETURNING *
  `,
  [
    point.site_id,
    point.point_id,
    guardId,
    token,
    latitude || null,
    longitude || null,
    accuracy || null,
    scheduledAt,
    delayMinutes,
    completionStatus,
    wasMissed,
  ]
);

await pool.query(
  `
  WITH target_manual AS (
    SELECT id
    FROM patrol_schedules
    WHERE patrol_point_id = $1
      AND site_id = $2
      AND schedule_type = 'manual'
      AND active = true
      AND (scheduled_date::timestamp + scheduled_time)
        <= (NOW() AT TIME ZONE 'Europe/Athens')
      AND (scheduled_date::timestamp + scheduled_time)
        >= (NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '15 minutes'
    ORDER BY (scheduled_date::timestamp + scheduled_time) DESC
    LIMIT 1
  )
  UPDATE patrol_schedules ps
  SET active = false
  FROM target_manual tm
  WHERE ps.id = tm.id
  `,
  [
    point.point_id,
    point.site_id,
  ]
);

    res.json({
      status: "ok",
      message: "Patrol recorded successfully",
      patrol: insertResult.rows[0],
      point: {
        id: point.point_id,
        name: point.point_name,
        site_id: point.site_id,
        site_name: point.site_name,
      },
    });
  } catch (err) {
    console.error("Patrol scan error:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to record patrol scan",
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
    } = req.body;

    if (!scheduled_date || !scheduled_time) {
      return res.status(400).json({
        status: "error",
        message: "scheduled_date and scheduled_time are required",
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
          created_at
        )
        VALUES ($1,$2,'manual',$3,$4,$5,true,NOW())
        RETURNING *
        `,
        [
          siteId,
          point.id,
          scheduled_date,
          scheduled_time,
          reminder_minutes_before,
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
      reminder_minutes_before = 5,
      schedule_scope = "24_7",
    } = req.body;

    if (!interval_hours) {
      return res.status(400).json({
        status: "error",
        message: "interval_hours is required",
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
          reminder_minutes_before,
          active,
          created_at
        )
        VALUES ($1,$2,'recurring',$3,$4,true,NOW())
        RETURNING *
        `,
        [
          siteId,
          point.id,
          Number(interval_hours),
          Number(reminder_minutes_before),
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
    pp.site_id,
    pp.id AS point_id,
    pp.point_name,
    'recurring' AS schedule_type,
    gs.expected_slot AS scheduled_at
  FROM patrol_points pp

  LEFT JOIN LATERAL (
    SELECT MAX(pl.patrol_time) AS last_patrol_time
    FROM patrol_logs pl
    WHERE pl.point_id = pp.id
  ) last_log ON true

  CROSS JOIN LATERAL generate_series(
    COALESCE(
      last_log.last_patrol_time + (pp.expected_interval_minutes || ' minutes')::interval,
      NOW()
    ),
    NOW() + (pp.expected_interval_minutes || ' minutes')::interval,
    (pp.expected_interval_minutes || ' minutes')::interval
  ) AS gs(expected_slot)

  WHERE pp.active = true
    AND pp.expected_interval_minutes IS NOT NULL
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
    AND scheduled_at >= NOW()
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
              u.scheduled_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
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
    AND u.scheduled_at < NOW() - INTERVAL '15 minutes'
    THEN 'missed'

  WHEN u.schedule_type = 'recurring'
    AND u.scheduled_at < NOW()
    THEN 'overdue'

  WHEN u.schedule_type = 'recurring'
    AND u.scheduled_at <= NOW() + INTERVAL '5 minutes'
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
        sn.next_patrol,
sn.next_patrol_point_id,
sn.next_patrol_point,
sn.next_patrol_type,

        CASE
  WHEN sn.next_patrol IS NULL THEN 'not_scheduled'
  WHEN sn.next_patrol < NOW() - INTERVAL '15 minutes' THEN 'missed'
  WHEN sn.next_patrol < NOW() THEN 'overdue'
  WHEN sn.next_patrol <= NOW() + INTERVAL '5 minutes' THEN 'due_soon'
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
          ps.point_id,
          pp.point_name,
          ps.scheduled_at,
          'manual' AS schedule_type,
          'missed' AS status,
          g.full_name AS guard_name
        FROM patrol_schedules ps
        LEFT JOIN sites s
          ON s.id = ps.site_id
        LEFT JOIN patrol_points pp
          ON pp.id = ps.point_id
        LEFT JOIN guard_sessions gs
          ON gs.site_id = ps.site_id
          AND gs.login_time <= ps.scheduled_at
          AND (
            gs.logout_time IS NULL
            OR gs.logout_time >= ps.scheduled_at
          )
        LEFT JOIN guards g
          ON g.id = gs.guard_id
        WHERE ps.schedule_type = 'manual'
          AND ps.scheduled_at < NOW()
          AND NOT EXISTS (
            SELECT 1
            FROM patrol_logs pl
            WHERE pl.point_id = ps.point_id
              AND pl.site_id = ps.site_id
              AND pl.patrol_time >= ps.scheduled_at - INTERVAL '10 minutes'
              AND pl.patrol_time <= ps.scheduled_at + INTERVAL '30 minutes'
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
        AND ($3::date IS NULL OR scheduled_at >= $3::date)
        AND ($4::date IS NULL OR scheduled_at <= ($4::date + INTERVAL '1 day' - INTERVAL '1 millisecond'))
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

    res.json({
      status: "ok",
      history: result.rows,
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

app.get("/patrols/history", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        pl.id,
        pl.patrol_time,
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
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});






