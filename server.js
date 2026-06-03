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

        gs.login_time,
        gs.login_time AS check_in_time,
        gs.last_heartbeat,
        gs.last_heartbeat AS last_seen,
        gs.status,

        (
  gs.logout_time IS NULL
) AS is_currently_online,

(
  gs.logout_time IS NULL
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

    res.json({
      activeIncidents: incidentsResult.rows[0]?.count || 0,
      alertsToday: alertsTodayResult.rows[0]?.count || 0,
      responseTime: "0s",
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
// Shows active incident, recently resolved incident, or normal state
// ----------------------------------------------------------
app.get("/dashboard/incident-timeline", async (req, res) => {
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

        s.name AS site_name,
        s.location AS site_location,

        COALESCE(g.full_name, g.username) AS guard_name

      FROM incidents i

      LEFT JOIN sites s
      ON s.id = i.site_id

      LEFT JOIN guards g
      ON g.id = i.guard_ref

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

    if (result.rows.length === 0) {
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
        duration: null
      });
    }

    const incident = result.rows[0];

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

    res.json({
      status: isResolved ? "resolved_recent" : "active",

      incidentRef: incident.incident_ref,
      location: incident.site_name || incident.site_location || "Unknown site",
      alertTime: incident.trigger_time,
      guardName: incident.guard_name || "Unknown guard",

      alertStatus: "triggered",
      callStatus: isResolved ? "completed" : "in_progress",
      smsStatus: isResolved ? "completed" : "in_progress",
      incidentStatus: isResolved ? "resolved" : "active",

      resolvedTime: incident.resolved_time,
      duration
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

        active_guard.full_name AS active_guard,

        (
          SELECT COUNT(*)
          FROM guards g2
          WHERE g2.site_id = s.id
            AND g2.active = true
        )::int AS guards_assigned,

        (
          SELECT COUNT(*)
          FROM guard_sessions gs3
          WHERE gs3.site_id = s.id
            AND gs3.logout_time IS NULL
        )::int AS on_duty

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

async function startVoiceCalls(recipients) {
  const baseUrl = 'https://noctua-panic-backend-production.up.railway.app';

  const results = [];
  for (const to of recipients) {
    const r = await vonageVoice.voice.createOutboundCall({
      to: [{ type: 'phone', number: to.replace("+", "") }],
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
        'Panic alert triggered from web app.'
      ]
    );

    const results = await Promise.all(
      recipients.map(to => sendVonageSms(to, text))
    );

    let callResults = [];

    try {
      callResults = await startVoiceCalls(recipients);
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
    recipients_count,
    sms_sent,
    sms_failed,
    voice_attempted,
    voice_status
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8
  )
  `,
  [
    "WEBAPP_ALERT",
    source || "webapp",
    "completed",
    recipients.length,
    results.length,
    0,
    recipients.length,
    "online"
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
        ae.status AS alert_event_status,
        ae.sms_sent,
        ae.sms_failed,
        ae.voice_attempted,
        ae.voice_status,

        CASE
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
  SELECT *
  FROM alert_events ae
  WHERE ae.event_type = 'WEBAPP_ALERT'
    AND ae.source = 'aegis-link-webapp'
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

      guard: row.guard_name || "Waiting for guard check-in",

      status: row.display_status || "normal",
      priority: row.priority || "Normal",

      incidentId: row.incident_ref || null,
      incidentDbId: row.incident_id || null,
      triggerTime: row.trigger_time || null,
      resolvedTime: row.resolved_time || null,

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
  ? row.voice_status === "online" || Number(row.voice_attempted) > 0
    ? "Completed"
    : "Dialing"
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

// ----------------------------------------------------------
// START SERVER
// ----------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});






