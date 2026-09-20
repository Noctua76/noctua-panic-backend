const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");

const {
  createSupabaseGuardReportsStorage,
} = require("../storage/supabase-storage");

test("Supabase report storage provides a WebSocket transport on Node 20", () => {
  let receivedOptions;
  const client = {
    storage: {
      from() {
        throw new Error("storage operations are not part of this test");
      },
    },
  };

  const storage = createSupabaseGuardReportsStorage({
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      SUPABASE_GUARD_REPORTS_BUCKET: "guard-reports",
    },
    createClientImpl(url, key, options) {
      assert.equal(url, "https://example.supabase.co");
      assert.equal(key, "service-role-key");
      receivedOptions = options;
      return client;
    },
  });

  assert.equal(storage.bucket, "guard-reports");
  assert.equal(receivedOptions.realtime.transport, WebSocket);
  assert.deepEqual(receivedOptions.auth, {
    persistSession: false,
    autoRefreshToken: false,
  });
});
