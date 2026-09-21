const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcrypt");
const {
  PASSWORD_CHANGE_REQUIRED_CODE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
  enforceDashboardPasswordChange,
} = require("../auth/dashboard-password-gate");
const {
  changeDashboardPassword,
} = require("../auth/dashboard-password-change");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

for (const endpoint of ["/dashboard/metrics", "/admin/users"]) {
  test(`temporary Dashboard session blocks GET ${endpoint}`, () => {
    const res = responseRecorder();
    const blocked = enforceDashboardPasswordChange({
      method: "GET",
      path: endpoint,
      auth: { must_change_password: true, is_system_owner: true, permissions: ["*"] },
    }, res);

    assert.equal(blocked, true);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      status: "error",
      code: PASSWORD_CHANGE_REQUIRED_CODE,
      message: PASSWORD_CHANGE_REQUIRED_MESSAGE,
    });
  });
}

for (const endpoint of ["/auth/change-password", "/admin/logout"]) {
  test(`temporary Dashboard session allows POST ${endpoint}`, () => {
    const res = responseRecorder();
    const blocked = enforceDashboardPasswordChange({
      method: "POST",
      path: endpoint,
      auth: { must_change_password: true },
    }, res);
    assert.equal(blocked, false);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);
  });
}

test("temporary Dashboard login creates a session and returns the password-change state", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const loginRoute = source.slice(
    source.indexOf('app.post("/auth/login"'),
    source.indexOf("function resolveAdminUsersCompanyScope")
  );
  assert.match(loginRoute, /u\.must_change_password/);
  assert.match(loginRoute, /INSERT INTO admin_sessions/);
  assert.match(loginRoute, /must_change_password: user\.must_change_password/);
});

test("requireAuth reads the password flag and enforces it before RBAC", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const middleware = source.slice(
    source.indexOf("async function requireAuth"),
    source.indexOf("async function requireGuardAuth")
  );
  assert.match(middleware, /u\.must_change_password/);
  assert.match(middleware, /must_change_password: auth\.must_change_password/);
  assert.ok(
    middleware.indexOf("enforceDashboardPasswordChange") <
      middleware.indexOf("dashboardRbac.resolveAuthorization")
  );
});

test("successful change clears the flag, preserves session eligibility and invalidates old password", async () => {
  const temporaryPassword = "Temporary-Password-1";
  const newPassword = "Permanent-Password-2";
  const state = {
    password_hash: await bcrypt.hash(temporaryPassword, 4),
    must_change_password: true,
  };
  const invalidated = [];
  const pool = {
    async query(sql, params) {
      if (sql.startsWith("SELECT id")) {
        return { rows: [{
          id: 17,
          full_name: "Test User",
          username: "test_user",
          role: "viewer",
          status: "active",
          password_hash: state.password_hash,
          must_change_password: state.must_change_password,
        }] };
      }
      if (sql.startsWith("UPDATE users")) {
        state.password_hash = params[0];
        state.must_change_password = false;
        return { rows: [{
          id: 17,
          username: "test_user",
          role: "viewer",
          status: "active",
          must_change_password: false,
        }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const user = await changeDashboardPassword({
    pool,
    bcrypt,
    userId: 17,
    currentPassword: temporaryPassword,
    newPassword,
    invalidateUser: (userId) => invalidated.push(userId),
  });

  assert.equal(user.must_change_password, false);
  assert.deepEqual(invalidated, [17]);
  assert.equal(await bcrypt.compare(temporaryPassword, state.password_hash), false);
  assert.equal(await bcrypt.compare(newPassword, state.password_hash), true);

  const sameSessionResponse = responseRecorder();
  assert.equal(enforceDashboardPasswordChange({
    method: "GET",
    path: "/dashboard/metrics",
    auth: { must_change_password: state.must_change_password },
  }, sameSessionResponse), false);
});

test("wrong temporary password is rejected and does not clear the flag", async () => {
  const hash = await bcrypt.hash("Temporary-Password-1", 4);
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT id")) {
        return { rows: [{ id: 17, status: "active", password_hash: hash, must_change_password: true }] };
      }
      throw new Error("Password update must not run");
    },
  };

  await assert.rejects(
    changeDashboardPassword({
      pool,
      bcrypt,
      userId: 17,
      currentPassword: "Wrong-Temporary-Password",
      newPassword: "Permanent-Password-2",
    }),
    (error) => error.statusCode === 401 && error.message === "Current password is incorrect"
  );
});
