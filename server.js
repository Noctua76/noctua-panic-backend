require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Vonage } = require('@vonage/server-sdk');
const pool = require("./db");
const bcrypt = require("bcrypt");

const VONAGE_PRIVATE_KEY = (process.env.VONAGE_PRIVATE_KEY || '').includes('\\n')
  ? process.env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : process.env.VONAGE_PRIVATE_KEY;

const vonageVoice = new Vonage({
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: VONAGE_PRIVATE_KEY
});


const app = express();
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
    const { guardId, siteId, timestamp, message } = req.body;

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

const result = await pool.query(
`
SELECT

id,
username,
role,
login_time,
last_seen,
logout_time,
is_active,
session_duration_seconds

FROM admin_sessions

ORDER BY login_time DESC
`
);

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
session_duration_seconds

FROM admin_sessions

ORDER BY login_time DESC
`
);

let csv =
"username,role,login_time,last_seen,logout_time,is_active,session_duration_seconds\n";

result.rows.forEach(row=>{

csv +=
`${row.username},`+
`${row.role},`+
`${row.login_time},`+
`${row.last_seen},`+
`${row.logout_time || ""},`+
`${row.is_active}\n`;+
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
// GUARD CHECK IN
// ----------------------------------------------------------
app.post("/guards/checkin", async (req, res) => {
  try {
    const { guard_id, site_id } = req.body;
    await pool.query(
  `
  DELETE FROM guard_shifts
  WHERE guard_id = $1
    AND check_out_time IS NULL
  `,
  [guard_id]
);

    const result = await pool.query(
      `
      INSERT INTO guard_shifts (
        company_id,
        guard_id,
        site_id,
        check_in_time,
        status,
        created_at
      )
      VALUES (
        1,
        $1,
        $2,
        NOW(),
        'on_duty',
        NOW()
      )
      RETURNING *
      `,
      [guard_id, site_id]
    );

    await pool.query(
      `
      UPDATE sites
      SET active_guard_id = $1
      WHERE id = $2
      `,
      [guard_id, site_id]
    );

    res.json({
      status: "ok",
      shift: result.rows[0]
    });

  } catch (err) {
    console.error(err);

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

    await pool.query(
      `
      UPDATE guard_shifts
      SET
        check_out_time = NOW(),
        status='completed'
      WHERE
        guard_id = $1
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
      `,
      [site_id]
    );

    res.json({
      status:"ok"
    });

  } catch (err) {
    res.status(500).json({
      status:"error",
      message:err.message
    });
  }
});


// ----------------------------------------------------------
// ACTIVE GUARDS
// ----------------------------------------------------------
app.get("/guards/active", async (req,res)=>{

const result = await pool.query(`
SELECT
s.id as site_id,
s.name as site_name,
u.id as guard_id,
u.full_name,
gs.check_in_time

FROM sites s

LEFT JOIN users u
ON s.active_guard_id=u.id

LEFT JOIN guard_shifts gs
ON gs.guard_id=u.id

WHERE gs.check_out_time IS NULL
`);

res.json(result.rows);

});


// ----------------------------------------------------------
// Helper: Αποστολή SMS μέσω Vonage (κοινή λογική)
// ----------------------------------------------------------
async function sendVonageSms(to, text) {
  const params = new URLSearchParams();
  params.append('api_key', process.env.VONAGE_API_KEY);
  params.append('api_secret', process.env.VONAGE_API_SECRET);
  params.append('to', to);
  params.append('from', process.env.VONAGE_FROM_NUMBER || '+12029334212');
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

async function startVoiceCalls(recipients) {
  const baseUrl = 'https://noctua-panic-backend-production.up.railway.app';

  const results = [];
  for (const to of recipients) {
    const r = await vonageVoice.voice.createOutboundCall({
      to: [{ type: 'phone', number: to }],
      from: { type: 'phone', number: process.env.VONAGE_FROM_NUMBER },
      answer_url: [`${baseUrl}/webhooks/answer`],
      event_url:  [`${baseUrl}/webhooks/event`],
      event_method: 'POST'   // 👈 ΜΠΑΙΝΕΙ ΕΔΩ
    });
    results.push({ to, response: r });
  }
  return results;
}

// === ALERT ENDPOINT used by the WebApp ===
app.post('/alert', async (req, res) => {
  console.log('ALERT ENDPOINT HIT:', req.body);

  const { siteId, guardId, triggeredAt, source } = req.body || {};

  // Παίρνουμε τους παραλήπτες από το env
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

  const text =
    `NOCTUA PANIC ALERT\n` +
    `Site: ${siteId || 'N/A'}\n` +
    `Guard: ${guardId || 'N/A'}\n` +
    `Source: ${source || 'noctua-panic-webapp'}\n` +
    `Time: ${triggeredAt || new Date().toISOString()}`;

  try {
    // Στέλνουμε SMS σε όλους τους παραλήπτες παράλληλα
const results = await Promise.all(
  recipients.map(to => sendVonageSms(to, text))
);

// Ξεκινάμε και κλήσεις (χωρίς να επηρεάζει τα SMS αν αποτύχουν)
let callResults = [];
try {
  callResults = await startVoiceCalls(recipients);
} catch (callErr) {
  console.error('Voice call failed (non-blocking):', callErr);
}

return res.json({
  status: 'ok',
  message: 'Alert received & SMS sent',
  recipients,
  smsResults: results,
  callResults
});
  } catch (err) {
    console.error('Error sending panic SMS from /alert:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Alert received but SMS failed',
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

function eventHook(req, res) {
  console.log("VONAGE VOICE EVENT:", {
    method: req.method,
    query: req.query,
    body: req.body
  });
  return res.status(200).send('ok');
}

app.get('/webhooks/event', eventHook);
app.post('/webhooks/event', eventHook);


// ----------------------------------------------------------
// START SERVER
// ----------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});






