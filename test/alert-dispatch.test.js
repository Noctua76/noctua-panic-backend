const test = require("node:test");
const assert = require("node:assert/strict");
const {
  channelSummary,
  createAlertDispatcher,
  NO_ACTIVE_RECIPIENTS_REASON,
  overallStatus,
} = require("../notifications/alert-dispatch");
const { createVonageProvider, parseSmsProviderResponse } = require("../notifications/vonage");

function mockPool(recipients = [], summaryId = 1001) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM alert_recipients")) {
        return { rows: recipients };
      }
      if (sql.includes("recipients_count") && sql.includes("RETURNING id")) {
        return { rows: [{ id: summaryId }] };
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
  assert.equal(result.test_id, 1001);
  assert.equal(result.notifications.sms.some((item) => item.phone === "+399"), false);
  const recipientQuery = pool.queries.find((item) => item.sql.includes("FROM alert_recipients"));
  assert.deepEqual(recipientQuery.params, [7]);
});

test("a company without database recipients cannot use global environment numbers", async () => {
  const pool = mockPool([]);
  let providerCalls = 0;
  const dispatcher = createAlertDispatcher({
    pool,
    env: {
      ALERT_RECIPIENTS: "+301,+301,+302",
      VONAGE_API_KEY: "key",
      VONAGE_API_SECRET: "secret",
      VONAGE_FROM_NUMBER: "+300",
    },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Provider must not be called without company recipients");
    },
    voiceClient: {
      voice: {
        async createOutboundCall() {
          providerCalls += 1;
          throw new Error("Provider must not be called without company recipients");
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

  assert.equal(result.recipient_source, "none");
  assert.equal(result.fallback_used, false);
  assert.equal(result.recipients_count, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, NO_ACTIVE_RECIPIENTS_REASON);
  assert.equal(result.test_id, 1001);
  assert.equal(providerCalls, 0);
});

test("recipient lookup remains scoped to the authenticated company", async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM alert_recipients")) {
        const rowsByCompany = {
          21: [{
            id: 1,
            company_id: 21,
            full_name: "Company A",
            phone: "+301",
            sms_enabled: true,
            voice_enabled: false,
            active: true,
            source: "database",
          }],
          22: [],
        };
        return { rows: rowsByCompany[params[0]] || [] };
      }
      if (sql.includes("recipients_count") && sql.includes("RETURNING id")) {
        return { rows: [{ id: 2002 }] };
      }
      return { rows: [] };
    },
  };
  const dispatcher = createAlertDispatcher({
    pool,
    env: {
      ALERT_RECIPIENTS: "+399",
      VONAGE_API_KEY: "key",
      VONAGE_API_SECRET: "secret",
      VONAGE_FROM_NUMBER: "+300",
    },
    fetchImpl: async () => {
      throw new Error("Company B must not dispatch to Company A or environment recipients");
    },
    voiceClient: { voice: {} },
  });

  const result = await dispatcher.dispatchAlertNotifications({
    mode: "test",
    source: "Dashboard Settings",
    companyId: 22,
    message: "test",
  });

  assert.equal(result.recipients_count, 0);
  assert.equal(result.recipient_source, "none");
  assert.deepEqual(
    queries.find((item) => item.sql.includes("FROM alert_recipients")).params,
    [22]
  );
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
