const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_TEMP_PASSWORD_TTL_HOURS,
  PASSWORD_SETUP_TOKEN_TTL_MINUTES,
  commitGuardPasswordReset,
  createPasswordSetupToken,
  evaluatePasswordChangeCredential,
  generateTemporaryPassword,
  getTempPasswordTtlHours,
  parsePasswordSetupToken,
  setupTokenMatches,
  validateGuardPassword,
} = require("../auth/guard-password-lifecycle");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const migrationSource = fs.readFileSync(
  path.join(__dirname, "..", "database", "2026-09-21-guard-password-lifecycle.sql"),
  "utf8"
);

test("temporary password TTL defaults to seven days", () => {
  assert.equal(DEFAULT_TEMP_PASSWORD_TTL_HOURS, 168);
  assert.equal(getTempPasswordTtlHours(undefined), 168);
});

test("temporary password TTL accepts a positive configured value", () => {
  assert.equal(getTempPasswordTtlHours("72"), 72);
});

test("temporary password TTL rejects invalid configured values", () => {
  assert.equal(getTempPasswordTtlHours("0"), 168);
  assert.equal(getTempPasswordTtlHours("invalid"), 168);
});

test("generated temporary password satisfies the policy", () => {
  const password = generateTemporaryPassword();
  assert.equal(password.length, 16);
  assert.equal(validateGuardPassword(password).valid, true);
});

test("generated temporary passwords are not deterministic", () => {
  assert.notEqual(generateTemporaryPassword(), generateTemporaryPassword());
});

test("password policy requires at least twelve characters", () => {
  assert.equal(validateGuardPassword("Aa1!short").valid, false);
});

test("password policy requires lowercase", () => {
  assert.equal(validateGuardPassword("UPPERCASE123!").valid, false);
});

test("password policy requires uppercase", () => {
  assert.equal(validateGuardPassword("lowercase123!").valid, false);
});

test("password policy requires a number", () => {
  assert.equal(validateGuardPassword("NoNumbersHere!").valid, false);
});

test("password policy requires a symbol", () => {
  assert.equal(validateGuardPassword("NoSymbols1234").valid, false);
});

test("password setup token uses the configured fifteen-minute lifecycle", () => {
  assert.equal(PASSWORD_SETUP_TOKEN_TTL_MINUTES, 15);
});

test("password setup token identifies its guard without storing its secret", () => {
  const setup = createPasswordSetupToken(42);
  const parsed = parsePasswordSetupToken(setup.token);
  assert.equal(parsed.guardId, 42);
  assert.equal(setupTokenMatches(parsed.secret, setup.hash), true);
  assert.equal(setup.hash.includes(parsed.secret), false);
});

test("tampered password setup token is rejected", () => {
  const setup = createPasswordSetupToken(7);
  assert.equal(setupTokenMatches("tampered-secret-that-is-long-enough", setup.hash), false);
});

test("malformed password setup tokens are rejected", () => {
  assert.equal(parsePasswordSetupToken("invalid"), null);
  assert.equal(parsePasswordSetupToken("x.secret"), null);
});

function buildPasswordChangeGuard(setup, overrides = {}) {
  return {
    active: true,
    access_mode: "standard",
    must_change_password: true,
    temporary_password_expires_at: "2026-09-22T12:00:00.000Z",
    password_setup_token_expires_at: "2026-09-22T10:15:00.000Z",
    password_setup_token_hash: setup.hash,
    ...overrides,
  };
}

test("valid temporary credential and setup token allow password change", () => {
  const setup = createPasswordSetupToken(9);
  const parsed = parsePasswordSetupToken(setup.token);
  const state = evaluatePasswordChangeCredential(
    buildPasswordChangeGuard(setup),
    parsed.secret,
    Date.parse("2026-09-22T10:05:00.000Z")
  );
  assert.deepEqual(state, { valid: true, code: null });
});

test("expired temporary password blocks change despite a valid setup token", () => {
  const setup = createPasswordSetupToken(9);
  const parsed = parsePasswordSetupToken(setup.token);
  const state = evaluatePasswordChangeCredential(
    buildPasswordChangeGuard(setup, {
      temporary_password_expires_at: "2026-09-22T10:00:00.000Z",
    }),
    parsed.secret,
    Date.parse("2026-09-22T10:01:00.000Z")
  );
  assert.deepEqual(state, { valid: false, code: "TEMP_PASSWORD_EXPIRED" });
});

test("expired setup token blocks change while temporary password remains valid", () => {
  const setup = createPasswordSetupToken(9);
  const parsed = parsePasswordSetupToken(setup.token);
  const state = evaluatePasswordChangeCredential(
    buildPasswordChangeGuard(setup, {
      password_setup_token_expires_at: "2026-09-22T10:00:00.000Z",
    }),
    parsed.secret,
    Date.parse("2026-09-22T10:01:00.000Z")
  );
  assert.deepEqual(state, { valid: false, code: "PASSWORD_SETUP_TOKEN_EXPIRED" });
});

test("reset shift synchronization completes before commit", async () => {
  const operations = [];
  const client = { query: async (sql) => operations.push(sql) };
  await commitGuardPasswordReset({
    client,
    closedSessionIds: [11, 12],
    syncScheduledShiftsForSession: async (id, queryable) => {
      assert.equal(queryable, client);
      operations.push(`sync:${id}`);
    },
  });
  assert.deepEqual(operations, ["sync:11", "sync:12", "COMMIT"]);
});

test("reset synchronization failure prevents commit", async () => {
  const operations = [];
  const client = { query: async (sql) => operations.push(sql) };
  await assert.rejects(
    commitGuardPasswordReset({
      client,
      closedSessionIds: [11],
      syncScheduledShiftsForSession: async () => {
        operations.push("sync:11");
        throw new Error("sync failed");
      },
    }),
    /sync failed/
  );
  assert.deepEqual(operations, ["sync:11"]);
});

test("migration adds all guard password lifecycle columns", () => {
  for (const column of [
    "must_change_password", "temporary_password_created_at",
    "temporary_password_expires_at", "password_changed_at",
    "password_setup_token_hash", "password_setup_token_expires_at",
  ]) assert.match(migrationSource, new RegExp(column));
});

test("existing guards remain usable by default", () => {
  assert.match(migrationSource, /must_change_password BOOLEAN NOT NULL DEFAULT FALSE/i);
});

test("password audit events are immutable and contain no secret columns", () => {
  assert.match(migrationSource, /BEFORE UPDATE OR DELETE ON guard_password_audit_events/i);
  assert.doesNotMatch(migrationSource, /temporary_password\s+(TEXT|VARCHAR)/i);
  assert.doesNotMatch(migrationSource, /token\s+(TEXT|VARCHAR)/i);
});

test("guard login returns password change requirement before session creation", () => {
  const branch = serverSource.indexOf('code: "GUARD_PASSWORD_CHANGE_REQUIRED"');
  const sessionInsert = serverSource.indexOf("INSERT INTO guard_sessions", branch);
  assert.ok(branch > 0 && sessionInsert > branch);
});

test("guard login uses bcrypt and a dummy comparison without a plaintext fallback", () => {
  const start = serverSource.indexOf('app.post("/guard/login"');
  const end = serverSource.indexOf('app.post("/guard/change-password"', start);
  assert.ok(start >= 0 && end > start);
  const route = serverSource.slice(start, end);

  assert.doesNotMatch(route, /\bpassword\s*={2,3}\s*guard\.password_hash\b/);
  assert.doesNotMatch(route, /\bguard\.password_hash\s*={2,3}\s*password\b/);
  assert.match(route, /if\s*\(guard\.password_hash\s*&&\s*guard\.password_hash\.startsWith\("\$2"\)\)\s*\{\s*validPassword\s*=\s*await bcrypt\.compare\(password, guard\.password_hash\);\s*\}\s*else\s*\{\s*await bcrypt\.compare\(password, INVALID_ACCOUNT_PASSWORD_HASH\);\s*\}/);
});

test("guard login verification accepts valid bcrypt and rejects legacy or malformed credentials", async () => {
  const bcrypt = require("bcrypt");
  const routeStart = serverSource.indexOf('app.post("/guard/login"');
  const start = serverSource.indexOf("let validPassword = false;", routeStart);
  const end = serverSource.indexOf("if (!validPassword)", start);
  assert.ok(routeStart >= 0 && start > routeStart && end > start);
  const dummyHash = serverSource.match(/const INVALID_ACCOUNT_PASSWORD_HASH\s*=\s*"([^"]+)";/)[1];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const verify = new AsyncFunction(
    "bcrypt", "password", "guard", "INVALID_ACCOUNT_PASSWORD_HASH",
    `${serverSource.slice(start, end)}\nreturn validPassword;`
  );
  const password = "Guard-Test-Password-1!";
  const hash = await bcrypt.hash(password, 4);
  const calls = [];
  const trackedBcrypt = {
    async compare(supplied, stored) {
      calls.push([supplied, stored]);
      return bcrypt.compare(supplied, stored);
    },
  };

  assert.equal(await verify(trackedBcrypt, password, { password_hash: hash }, dummyHash), true);
  assert.deepEqual(calls.pop(), [password, hash]);
  assert.equal(await verify(trackedBcrypt, "Wrong-Password-1!", { password_hash: hash }, dummyHash), false);
  assert.deepEqual(calls.pop(), ["Wrong-Password-1!", hash]);

  for (const stored of [password, "malformed-hash", "", null]) {
    assert.equal(await verify(trackedBcrypt, password, { password_hash: stored }, dummyHash), false);
    assert.deepEqual(calls.pop(), [password, dummyHash]);
  }
  for (const stored of ["$2", "$2b$10$malformed"]) {
    assert.equal(await verify(trackedBcrypt, password, { password_hash: stored }, dummyHash), false);
    assert.deepEqual(calls.pop(), [password, stored]);
  }
  assert.equal(calls.length, 0);
});

test("expired temporary password has a dedicated error code", () => {
  assert.match(serverSource, /code: "TEMP_PASSWORD_EXPIRED"/);
});

test("change-password clears temporary state and does not create a session", () => {
  const start = serverSource.indexOf('app.post("/guard/change-password"');
  const end = serverSource.indexOf('app.post(\n  "/admin/scheduled-shifts/generate"', start);
  const route = serverSource.slice(start, end);
  assert.match(route, /must_change_password = FALSE/);
  assert.match(route, /password_setup_token_hash = NULL/);
  assert.doesNotMatch(route, /INSERT INTO guard_sessions/);
});

test("guard reset is tenant-scoped and revokes sessions and push", () => {
  assert.match(serverSource, /app\.post\("\/settings\/guards\/:id\/reset-password"/);
  assert.match(serverSource, /s\.company_id = \$5/);
  assert.match(serverSource, /status = 'password_reset'/);
  assert.match(serverSource, /UPDATE push_subscriptions/);
  assert.match(serverSource, /logout_time = \(NOW\(\) AT TIME ZONE 'Europe\/Athens'\)/);
  assert.match(serverSource, /commitGuardPasswordReset/);
});

test("guard authentication blocks accounts pending password change", () => {
  assert.match(serverSource, /COALESCE\(g\.must_change_password, FALSE\) = FALSE/);
});

test("required password audit events are present", () => {
  for (const event of [
    "GUARD_TEMP_PASSWORD_ISSUED", "GUARD_PASSWORD_CHANGED", "GUARD_PASSWORD_RESET",
  ]) assert.match(serverSource + migrationSource, new RegExp(event));
});
