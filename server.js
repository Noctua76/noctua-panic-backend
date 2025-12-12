require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Vonage } = require('@vonage/server-sdk');

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

// --- Health check για το webapp (NORMAL) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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
      event_url: [`${baseUrl}/webhooks/event`]
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

app.post('/webhooks/event', (req, res) => {
  console.log("VONAGE VOICE EVENT:", req.body);
  return res.status(200).send('ok');
});


// ----------------------------------------------------------
// START SERVER
// ----------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});




