const test = require("node:test");
const assert = require("node:assert/strict");
const {
  channelSummary,
  createAlertDispatcher,
  overallStatus,
} = require("../notifications/alert-dispatch");
const { createVonageProvider, parseSmsProviderResponse } = require("../notifications/vonage");

function mockPool(recipients = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM alert_recipients")) {
        return { rows: recipients };
      }
      return { rows: [] };
    },
  };
}

test("SMS success requires Vonage provider status zero", () => {
  const success = parseSmsProviderResponse("+301", {
    messages: [{ status: "0", "message-id": "message-1" }],
  });
  const providerFailure = parseSmsProviderResponse("+302", {
    messages: [{ status: "4", "error-text": "Invalid credentials" }],
  });

  assert.equal(success.status, "submitted");
  assert.equal(success.provider_message_id, "message-1");
  assert.equal(providerFailure.status, "failed");
  assert.equal(providerFailure.provider_status_code, "4");
});

test("SMS requests include the public delivery receipt callback", async () => {
  let requestBody = "";
  const provider = createVonageProvider({
    env: {
      PUBLIC_BACKEND_URL: "https://backend.example/",
      VONAGE_API_KEY: "key",
      VONAGE_API_SECRET: "secret",
      VONAGE_SMS_FROM: "AegisLink",
    },
    fetchImpl: async (_url, options) => {
      requestBody = options.body;
      return {
        ok: true,
        async json() {
          return { messages: [{ status: "0", "message-id": "message-1" }] };
        },
      };
    },
    voiceClient: { voice: {} },
  });

  await provider.sendSms("+301", "test");
  const params = new URLSearchParams(requestBody);
  assert.equal(params.get("callback"), "https://backend.example/webhooks/sms-delivery");
});

test("disabled channel is not counted as a failure", () => {
  const sms = channelSummary([{ status: "submitted" }]);
  const voice = channelSummary([]);

  assert.deepEqual(voice, {
    attempted: 0,
    submitted: 0,
    failed: 0,
    status: "not_attempted",
  });
  assert.equal(overallStatus(sms, voice), "completed");
});

test("voice-only success completes without an SMS attempt", () => {
  const sms = channelSummary([]);
  const voice = channelSummary([{ status: "submitted" }]);

  assert.equal(sms.status, "not_attempted");
  assert.equal(voice.status, "completed");
  assert.equal(overallStatus(sms, voice), "completed");
});

test("dispatcher uses database recipients and reports provider partial failure", async () => {
  const pool = mockPool([
    {
      id: 1,
      company_id: 7,
      full_name: "One",
      phone: "+301",
      sms_enabled: true,
      voice_enabled: true,
      active: true,
      source: "database",
    },
    {
      id: 2,
      company_id: 7,
      full_name: "Two",
      phone: "+302",
      sms_enabled: true,
      voice_enabled: false,
      active: true,
      source: "database",
    },
  ]);
  let smsRequest = 0;
  const dispatcher = createAlertDispatcher({
    pool,
    env: {
      ALERT_RECIPIENTS: "+399",
      VONAGE_API_KEY: "key",
      VONAGE_API_SECRET: "secret",
      VONAGE_FROM_NUMBER: "+300",
    },
    fetchImpl: async () => {
      smsRequest += 1;
      const requestNumber = smsRequest;
      return {
        ok: true,
        async json() {
          return {
            messages: [{
              status: requestNumber === 1 ? "0" : "4",
              "message-id": requestNumber === 1 ? "sms-1" : undefined,
              "error-text": requestNumber === 1 ? undefined : "Rejected",
            }],
          };
        },
      };
    },
    voiceClient: {
      voice: {
        async createOutboundCall() {
          return { uuid: "call-1" };
        },
      },
    },
  });

  const result = await dispatcher.dispatchAlertNotifications({
    mode: "test",
    source: "Dashboard Settings",
    companyId: 7,
    message: "test",
  });

  assert.equal(result.recipient_source, "database");
  assert.equal(result.fallback_used, false);
  assert.equal(result.recipients_count, 2);
  assert.deepEqual(result.sms, {
    attempted: 2,
    submitted: 1,
    failed: 1,
    status: "partial_failure",
  });
  assert.deepEqual(result.voice, {
    attempted: 1,
    submitted: 1,
    failed: 0,
    status: "completed",
  });
  assert.equal(result.status, "partial_failure");
  assert.equal(result.notifications.sms.some((item) => item.phone === "+399"), false);
  const recipientQuery = pool.queries.find((item) => item.sql.includes("FROM alert_recipients"));
  assert.deepEqual(recipientQuery.params, [7]);
});

test("environment recipients are used only when the company has no database rows", async () => {
  const pool = mockPool([]);
  const dispatcher = createAlertDispatcher({
    pool,
    env: {
      ALERT_RECIPIENTS: "+301,+301,+302",
      VONAGE_API_KEY: "key",
      VONAGE_API_SECRET: "secret",
      VONAGE_FROM_NUMBER: "+300",
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { messages: [{ status: "0", "message-id": "ok" }] };
      },
    }),
    voiceClient: {
      voice: {
        async createOutboundCall(payload) {
          return { uuid: `call-${payload.to[0].number}` };
        },
      },
    },
  });

  const result = await dispatcher.dispatchAlertNotifications({
    mode: "test",
    source: "Dashboard Settings",
    companyId: 8,
    message: "test",
  });

  assert.equal(result.recipient_source, "env_fallback");
  assert.equal(result.fallback_used, true);
  assert.equal(result.recipients_count, 2);
  assert.equal(result.status, "completed");
});

test("voice response without UUID is a provider failure", async () => {
  const pool = mockPool([{
    id: 1,
    company_id: 9,
    full_name: "Voice",
    phone: "+301",
    sms_enabled: false,
    voice_enabled: true,
    active: true,
    source: "database",
  }]);
  const dispatcher = createAlertDispatcher({
    pool,
    env: { VONAGE_FROM_NUMBER: "+300" },
    fetchImpl: async () => { throw new Error("SMS must not be called"); },
    voiceClient: {
      voice: { async createOutboundCall() { return { status: "error" }; } },
    },
  });

  const result = await dispatcher.dispatchAlertNotifications({
    mode: "test",
    source: "Dashboard Settings",
    companyId: 9,
    message: "test",
  });

  assert.equal(result.sms.status, "not_attempted");
  assert.equal(result.voice.status, "failed");
  assert.equal(result.status, "failed");
  assert.equal(result.notifications.voice[0].provider_call_uuid, null);
});
