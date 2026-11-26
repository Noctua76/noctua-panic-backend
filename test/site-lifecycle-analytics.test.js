const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(
  require.resolve("../server.js"), "utf8"
).replace(/\r\n/g, "\n");

function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

const lifecycle = section(
  "async function handleSiteLifecycle(",
  "// SETTINGS - GUARDS MANAGEMENT"
);

const profile = section(
  'app.put("/settings/sites/:id",',
  "registerSiteSopRoutes({"
);

const analytics = section(
  'app.get(\n  "/analytics/summary",',
  "// DASHBOARD TEST ALERT"
);

test("Archived sites cannot be toggled directly", () => {
  assert.match(lifecycle,
    /status IN \('active', 'inactive'\)/);
  assert.match(lifecycle,
    /res\.status\(409\)/);
});

test("Restore returns archived sites to inactive", () => {
  assert.match(lifecycle,
    /WHEN \$3::text = 'restore' THEN 'inactive'/);
  assert.match(lifecycle,
    /AND status = 'archived'/);
});

test("Lifecycle mutations remain tenant scoped", () => {
  assert.match(lifecycle, /AND company_id = \$2/);
  assert.match(lifecycle, /req\.auth\.effective_company_id/);
});

test("Profile editing cannot change lifecycle status", () => {
  assert.doesNotMatch(profile,
    /status = COALESCE/);
  assert.match(profile,
    /status IN \('active', 'inactive'\)/);
  assert.match(profile,
    /status::text = \$4::text/);
});

test("Analytics excludes non-active sites and their guards", () => {
  assert.match(analytics, /AND status = 'active'/);
  assert.match(analytics, /AND s\.status = 'active'/);
});

test("Zero assigned guards produces Low readiness", async () => {
  let handler;
  let call = 0;

  const results = [
    { rows: [{ total_sites: 3, required_shifts: 10 }] },
    { rows: [{ alerts_count: 0 }] },
    { rows: [{ assigned_guards: 0 }] }
  ];

  vm.runInNewContext(analytics, {
    app: {
      get: (_path, _auth, fn) => { handler = fn; }
    },
    requireAuth() {},
    pool: {
      query: async () => results[call++]
    },
    console
  });

  const res = {
    json(data) { this.body = data; },
    status(code) { this.code = code; return this; }
  };

  await handler({
    auth: { effective_company_id: 1 }
  }, res);

  assert.equal(res.body.company.total_sites, 3);
  assert.equal(res.body.readiness.required_shifts, 10);
  assert.equal(res.body.readiness.ratio, 0);
  assert.equal(res.body.readiness.level, "Low");
});

test("Site lifecycle and analytics PostgreSQL integration", {
  skip: process.env.GITHUB_ACTIONS !== "true" ||
        !process.env.TEST_DATABASE_URL
}, async () => {
  assert.equal(
    process.env.TEST_DATABASE_URL,
    "postgresql://postgres:postgres@localhost:5432/aegis_test"
  );

  const { Client } = require("pg");
  const db = new Client({
    connectionString: process.env.TEST_DATABASE_URL
  });

  await db.connect();

  try {
    await db.query(`
      CREATE TEMP TABLE sites (
        id integer PRIMARY KEY,
        company_id integer NOT NULL,
        status text NOT NULL,
        required_shifts integer,
        active_changed_at timestamptz,
        active_changed_by integer
      );

      CREATE TEMP TABLE guards (
        site_id integer,
        active boolean,
        access_mode text
      );

      CREATE TEMP TABLE alert_events (
        site_id integer
      );

      INSERT INTO sites VALUES
        (1, 1, 'active', 3, NULL, NULL),
        (2, 1, 'inactive', 2, NULL, NULL),
        (3, 1, 'archived', 5, NULL, NULL),
        (4, 2, 'active', 99, NULL, NULL),
        (5, 1, 'active', 7, NULL, NULL);

      INSERT INTO guards VALUES
        (1, true, 'standard'),
        (2, true, 'standard'),
        (3, true, 'standard'),
        (4, true, 'standard');
    `);

    const routes = new Map();

    vm.runInNewContext(
      lifecycle + "\n" + analytics,
      {
        app: {
          put: (url, auth, fn) => routes.set(url, fn),
          get: (url, auth, fn) => routes.set(url, fn)
        },
        requireAuth() {},
        pool: db,
        console
      }
    );

    async function call(url, id, company = 1) {
      const res = {
        code: 200,
        status(code) {
          this.code = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        }
      };

      await routes.get(url)({
        params: { id },
        auth: {
          effective_company_id: company,
          user_id: 1
        }
      }, res);

      return res;
    }

    const toggle = "/settings/sites/:id/toggle-active";
    const archive = "/settings/sites/:id/archive";
    const restore = "/settings/sites/:id/restore";

    const summary = await call("/analytics/summary", 1);

    assert.equal(summary.code, 200);
    assert.equal(summary.body.company.total_sites, 2);
    assert.equal(summary.body.readiness.required_shifts, 10);
    assert.equal(summary.body.readiness.assigned_guards, 1);

    assert.equal((await call(toggle, 1)).body.site.status, "inactive");
    assert.equal((await call(toggle, 1)).body.site.status, "active");
    assert.equal((await call(archive, 1)).body.site.status, "archived");
    assert.equal((await call(toggle, 1)).code, 409);
    assert.equal((await call(restore, 1)).body.site.status, "inactive");
    assert.equal((await call(toggle, 1)).body.site.status, "active");

    assert.equal((await call(archive, 2)).body.site.status, "archived");
    assert.equal((await call(toggle, 3)).code, 409);
    assert.equal((await call(restore, 4)).code, 404);
    assert.equal((await call(toggle, 4)).code, 404);
    assert.equal((await call(restore, 1)).code, 409);

  } finally {
    await db.end();
  }
});
