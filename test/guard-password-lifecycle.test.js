const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_TEMP_PASSWORD_TTL_HOURS,
  PASSWORD_SETUP_TOKEN_TTL_MINUTES,
  createPasswordSetupToken,
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
});

test("guard authentication blocks accounts pending password change", () => {
  assert.match(serverSource, /COALESCE\(g\.must_change_password, FALSE\) = FALSE/);
});

test("required password audit events are present", () => {
  for (const event of [
    "GUARD_TEMP_PASSWORD_ISSUED", "GUARD_PASSWORD_CHANGED", "GUARD_PASSWORD_RESET",
  ]) assert.match(serverSource + migrationSource, new RegExp(event));
});
