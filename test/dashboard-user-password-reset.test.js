const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resetDashboardUserPassword } = require("../auth/dashboard-user-password-reset");

function createResetPool({ failSessionRevocation = false, targetCompanyId = 7 } = {}) {
  const queries = [];
  const sessions = [
    { id: 1, token: "old-token-1", active: true },
    { id: 2, token: "old-token-2", active: true },
  ];
  let released = false;

  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT u.id")) {
        return params[1] === targetCompanyId
          ? { rows: [{ id: params[0], role_code: "viewer" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("UPDATE users")) {
        return { rows: [{ id: params[1], company_id: params[2], must_change_password: true }], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE admin_sessions")) {
        if (failSessionRevocation) throw new Error("session revocation failed");
        sessions.forEach((session) => { session.active = false; });
        return { rows: sessions.map(({ id }) => ({ id })), rowCount: sessions.length };
      }
      if (normalized.startsWith("INSERT INTO dashboard_rbac_audit_events")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release() { released = true; },
  };

  return {
    pool: { connect: async () => client },
    queries,
    sessions,
    wasReleased: () => released,
  };
}

test("Dashboard password reset revokes every active target-user session and rejects old tokens", async () => {
  const mock = createResetPool();
  const invalidated = [];
  const result = await resetDashboardUserPassword({
    pool: mock.pool,
    userId: 12,
    companyId: 7,
    actorUserId: 3,
    actorIsSystemOwner: false,
    passwordHash: "new-hash",
    invalidateUser: (id) => invalidated.push(id),
  });

  assert.equal(result.revokedSessionCount, 2);
  assert.deepEqual(invalidated, [12]);
  assert.equal(mock.sessions.some((session) => session.active), false);
  assert.equal(mock.sessions.find((session) => session.token === "old-token-1" && session.active), undefined);
  const sessionQuery = mock.queries.find((query) => query.sql.startsWith("UPDATE admin_sessions"));
  assert.deepEqual(sessionQuery.params, [12]);
  assert.match(sessionQuery.sql, /logout_time = NOW\(\)/);
  assert.match(sessionQuery.sql, /EXTRACT\(EPOCH FROM \(NOW\(\) - login_time\)\)::int/);
  assert.match(sessionQuery.sql, /session_end_reason = 'password_reset'/);
  assert.ok(mock.queries.some((query) => query.sql === "COMMIT"));
  assert.equal(mock.wasReleased(), true);
});

test("password-reset migration permits the session reason and immutable audit event", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../database/2026-09-24-dashboard-password-reset-sessions.sql"),
    "utf8"
  );
  assert.match(migration, /session_end_reason[\s\S]*'password_reset'/);
  assert.match(migration, /'USER_PASSWORD_RESET'/);
});

test("Dashboard password reset audit identifies actor, target and revoked count without secrets", async () => {
  const mock = createResetPool();
  await resetDashboardUserPassword({
    pool: mock.pool,
    userId: 12,
    companyId: 7,
    actorUserId: 3,
    actorIsSystemOwner: false,
    passwordHash: "secret-hash",
  });
  const audit = mock.queries.find((query) => query.sql.startsWith("INSERT INTO dashboard_rbac_audit_events"));
  assert.deepEqual(audit.params.slice(0, 3), [3, 12, 7]);
  assert.deepEqual(JSON.parse(audit.params[3]), { revoked_session_count: 2 });
  assert.equal(audit.params.join(" ").includes("secret-hash"), false);
});

test("Dashboard password reset rolls back when session revocation fails", async () => {
  const mock = createResetPool({ failSessionRevocation: true });
  await assert.rejects(
    resetDashboardUserPassword({
      pool: mock.pool,
      userId: 12,
      companyId: 7,
      actorUserId: 3,
      actorIsSystemOwner: false,
      passwordHash: "new-hash",
    }),
    /session revocation failed/
  );
  assert.ok(mock.queries.some((query) => query.sql === "ROLLBACK"));
  assert.equal(mock.queries.some((query) => query.sql === "COMMIT"), false);
  assert.equal(mock.queries.some((query) => query.sql.startsWith("INSERT INTO dashboard_rbac_audit_events")), false);
});

test("Dashboard password reset remains tenant scoped", async () => {
  const mock = createResetPool({ targetCompanyId: 8 });
  await assert.rejects(
    resetDashboardUserPassword({
      pool: mock.pool,
      userId: 12,
      companyId: 7,
      actorUserId: 3,
      actorIsSystemOwner: false,
      passwordHash: "new-hash",
    }),
    (error) => error.statusCode === 404
  );
  const lookup = mock.queries.find((query) => query.sql.startsWith("SELECT u.id"));
  assert.deepEqual(lookup.params, [12, 7]);
  assert.equal(mock.queries.some((query) => query.sql.startsWith("UPDATE users")), false);
  assert.ok(mock.queries.some((query) => query.sql === "ROLLBACK"));
});
