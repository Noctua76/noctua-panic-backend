const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const fromRoute = (start, end) => {
  const first = server.indexOf(start);
  const last = server.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `${start} route found`);
  return server.slice(first, last);
};

test("operational SQL cannot use a System Owner boolean to bypass a company filter", () => {
  const operational = server.slice(server.indexOf('app.post(\n  "/admin/scheduled-shifts/generate"'));
  assert.doesNotMatch(operational, /\$\d+::boolean\s*=\s*true\s*OR\s*(?:\w+\.)?company_id/gi);
  assert.doesNotMatch(operational, /\$\d+::boolean\s*=\s*true\s*OR\s*EXISTS/gi);
  const status = fromRoute('app.get("/system/status/tenant"', 'app.get("/system/status/global"');
  assert.match(status, /getTenantStatus\(req\.auth\.effective_company_id\)/);
});

test("home and selected tenant share one server-computed operational scope", () => {
  const routes = [
    ['app.get("/dashboard/metrics"', '// DASHBOARD INCIDENT TIMELINE'],
    ['app.get("/dashboard/incident-timeline"', '// GUARD SHIFT HISTORY'],
    ['app.get("/patrols/sites"', 'app.get("/patrols/sites/:siteId/details"'],
    ['"/analytics/summary"', '"/analytics/next"'],
  ];
  for (const [start, end] of routes) {
    const first = server.indexOf(start);
    assert.ok(first >= 0, `${start} exists`);
    const last = server.indexOf(end, first + start.length);
    const block = server.slice(first, last > first ? last : first + 14000);
    assert.match(block, /req\.auth\.effective_company_id/, `${start} uses the effective tenant`);
    assert.doesNotMatch(block, /req\.auth\.company_id/, `${start} does not use the actor company`);
  }
  const sessions = fromRoute('"/admin/sessions/history"', '"/admin/sessions/export"');
  assert.match(sessions, /req\.auth\.effective_company_id/);
  assert.match(sessions, /\$1::boolean IS FALSE\s*AND ads\.company_id = \$2/);
  const globalPresence = fromRoute('app.get("/admin/active"', 'app.post("/admin/heartbeat"');
  assert.match(globalPresence, /\$1::boolean = true\s*OR ads\.company_id = \$2/);
});

test("legacy aggregate status cannot expose unscoped operational counts", () => {
  const legacy = fromRoute('app.get("/system/status/legacy-internal"', 'app.use(\n  "/admin/patrol-corrections"');
  assert.match(legacy, /status\(410\)/);
  assert.doesNotMatch(legacy, /SELECT COUNT/);
});
