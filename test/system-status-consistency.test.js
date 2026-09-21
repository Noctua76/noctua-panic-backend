const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createSystemStatusService,
  incidentHealth,
  operationalHealth,
  tenantPushHealth,
} = require("../system-status");

test("historical SMS failure followed by newer success is operational without a current error", () => {
  const health = operationalHealth({
    lastFailure: "2026-09-21T18:00:00.000Z",
    lastSuccess: "2026-09-21T18:05:00.000Z",
    lastFailureReason: "Quota Exceeded",
  });

  assert.equal(health.status, "operational");
  assert.equal(health.current_error, null);
  assert.equal(health.last_failure_reason, "Quota Exceeded");
});

test("historical Voice 429 followed by newer success is operational without a current error", () => {
  const health = operationalHealth({
    lastFailure: "2026-09-21T18:00:00.000Z",
    lastSuccess: "2026-09-21T18:10:00.000Z",
    lastFailureReason: "HTTP 429",
  });

  assert.equal(health.status, "operational");
  assert.equal(health.current_error, null);
  assert.equal(health.last_failure_reason, "HTTP 429");
});

test("historical email failure followed by a sent email is operational without a current error", () => {
  const health = operationalHealth({
    lastFailure: "2026-09-21T18:00:00.000Z",
    lastSuccess: "2026-09-21T18:15:00.000Z",
    lastFailureReason: "No active supervisor email found for company 1",
  });

  assert.equal(health.status, "operational");
  assert.equal(health.current_error, null);
  assert.match(health.last_failure_reason, /No active supervisor email/);
});

test("zero active subscriptions keeps tenant push readiness unknown", () => {
  const health = tenantPushHealth({
    activeSubscriptions: 0,
    lastSuccess: "2026-09-21T18:15:00.000Z",
    lastFailure: null,
  });

  assert.equal(health.status, "unknown");
  assert.equal(health.current_error, null);
  assert.equal(health.status_message, "No active push subscriptions");
});

test("configured Platform Web Push may remain operational independently of tenant subscriptions", async () => {
  const pool = {
    async query(sql) {
      if (/SELECT NOW\(\) AS server_time/.test(sql)) {
        return { rows: [{ server_time: "2026-09-21T20:15:00.000Z" }] };
      }
      if (/FROM alert_events/.test(sql)) {
        return { rows: [{ last_success: null, last_failure: null, last_error: null }] };
      }
      if (/SELECT \* FROM system_health_state/.test(sql)) return { rows: [] };
      if (/INSERT INTO system_health_state/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const fetchImpl = async (url) => ({
    ok: true,
    text: async () => {
      if (String(url).includes("get-balance")) return JSON.stringify({ value: "10" });
      if (String(url).includes("postmarkapp")) return JSON.stringify({ Name: "Aegis" });
      return JSON.stringify({ status: "ok" });
    },
  });
  const statusService = createSystemStatusService({
    pool,
    fetchImpl,
    crypto: { createPrivateKey() {} },
    env: {
      VONAGE_API_KEY: "key",
      VONAGE_API_SECRET: "secret",
      VONAGE_SMS_FROM: "Aegis",
      VONAGE_APPLICATION_ID: "app",
      VONAGE_PRIVATE_KEY: "private-key",
      VONAGE_FROM_NUMBER: "100",
      POSTMARK_SERVER_TOKEN: "postmark",
      VAPID_SUBJECT: "mailto:ops@example.com",
      VAPID_PUBLIC_KEY: "public",
      VAPID_PRIVATE_KEY: "private",
    },
  });

  const result = await statusService.getPublicStatus();
  const platformPush = result.platform.find((item) => item.name === "push_notifications");
  assert.equal(platformPush.label, "Platform Web Push");
  assert.equal(platformPush.status, "operational");
});

test("tenant push uses delivery chronology when active subscriptions exist", () => {
  const degraded = tenantPushHealth({
    activeSubscriptions: 2,
    lastSuccess: "2026-09-21T18:00:00.000Z",
    lastFailure: "2026-09-21T18:05:00.000Z",
    lastFailureReason: "Push delivery failed",
  });
  const operational = tenantPushHealth({
    activeSubscriptions: 2,
    lastSuccess: "2026-09-21T18:10:00.000Z",
    lastFailure: "2026-09-21T18:05:00.000Z",
    lastFailureReason: "Push delivery failed",
  });

  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.current_error, "Push delivery failed");
  assert.equal(operational.status, "operational");
  assert.equal(operational.current_error, null);
});

test("incident activity without failure is operational", () => {
  const health = incidentHealth({ lastIncident: "2026-09-21T18:00:00.000Z" });
  assert.equal(health.status, "operational");
  assert.equal(health.current_error, null);
});

test("incident failure newer than successful activity is degraded", () => {
  const health = incidentHealth({
    lastResolved: "2026-09-21T18:00:00.000Z",
    lastFailure: "2026-09-21T18:05:00.000Z",
    lastFailureReason: "partial_failure",
  });
  assert.equal(health.status, "degraded");
  assert.equal(health.current_error, "partial_failure");
});

test("no incident history is unknown rather than offline", () => {
  const health = incidentHealth({});
  assert.equal(health.status, "unknown");
  assert.equal(health.status_message, "No incident activity recorded");
});

test("Shift Delay event instants use canonical NOW without Athens conversion", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const processStart = serverSource.indexOf("async function processPendingShiftDelayEmails");
  const processEnd = serverSource.indexOf("webpush.setVapidDetails", processStart);
  const detectStart = serverSource.indexOf("async function detectShiftDelayEvents");
  const detectEnd = serverSource.indexOf("function startShiftDelayMonitor", detectStart);
  const relevantSource = `${serverSource.slice(processStart, processEnd)}\n${serverSource.slice(detectStart, detectEnd)}`;

  assert.match(relevantSource, /email_sent_at = NOW\(\)/);
  assert.doesNotMatch(relevantSource, /email_sent_at\s*=\s*\(NOW\(\) AT TIME ZONE/);
  assert.doesNotMatch(relevantSource, /updated_at\s*=\s*\(NOW\(\) AT TIME ZONE/);
});

test("Supervisor role unavailable handling belongs only to temporary access creation", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const temporaryStart = serverSource.indexOf('app.post(\n  "/admin/temporary-access"');
  const temporaryEnd = serverSource.indexOf('app.post(\n  "/admin/temporary-access/:groupId/revoke"', temporaryStart);
  const guardsStart = serverSource.indexOf('app.post(\n  "/settings/guards"');
  const guardsEnd = serverSource.indexOf('app.put(\n  "/settings/guards/:id"', guardsStart);

  assert.match(serverSource.slice(temporaryStart, temporaryEnd), /SUPERVISOR_ROLE_UNAVAILABLE/);
  assert.doesNotMatch(serverSource.slice(guardsStart, guardsEnd), /SUPERVISOR_ROLE_UNAVAILABLE/);
});
