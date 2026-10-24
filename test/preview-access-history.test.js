const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

function routeSource(start, end) {
  const startIndex = server.indexOf(start);
  const endIndex = server.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `${start} route exists`);
  return server.slice(startIndex, endIndex);
}

const history = routeSource('"/admin/sessions/history"', '"/admin/sessions/export"');
const exportRoute = routeSource('"/admin/sessions/export"', "app.post('/send-sms'");

for (const [name, source] of [["history", history], ["export", exportRoute]]) {
  test(`${name} combines Dashboard sessions with tenant-scoped Guard Preview sessions`, () => {
    assert.match(source, /CONCAT\('dashboard:', ads\.id\) AS session_key/);
    assert.match(source, /'dashboard' AS surface/);
    assert.match(source, /FROM admin_sessions ads/);
    assert.match(source, /CONCAT\('guard_web_app:', gs\.id\) AS session_key/);
    assert.match(source, /'guard_web_app' AS surface/);
    assert.match(source, /INNER JOIN guard_sessions gs|FROM guard_sessions gs/);
    assert.match(source, /INNER JOIN sites s ON s\.id = gs\.site_id/);
    assert.match(source, /WHERE s\.company_id = \$1\s+AND g\.access_mode = \$2/);
    assert.match(source, /req\.auth\.effective_company_id/);
    assert.doesNotMatch(source, /device_info|ip_address/);
  });
}

test("Guard Preview rows expose the canonical temporary access contract", () => {
  assert.match(history, /'guard' AS role/);
  assert.match(history, /true AS is_temporary/);
  assert.match(history, /g\.temporary_access_label/);
  assert.match(history, /g\.temporary_access_started_at/);
  assert.match(history, /g\.access_expires_at/);
  assert.match(history, /g\.temporary_access_revoked_at/);
  assert.match(history, /g\.active = true/);
  assert.match(history, /INTERVAL '90 seconds'/);
  assert.match(history, /g\.temporary_access_revoked_at IS NULL/);
  assert.match(history, /g\.access_expires_at > NOW\(\)/);
});

test("Guard Preview end reasons, stale status, and bounded duration are normalized", () => {
  for (const [guardStatus, canonical] of [
    ["logged_out", "logout"],
    ["temporary_access_expired", "temporary_access_expired"],
    ["temporary_access_revoked", "temporary_access_revoked"],
    ["auto_closed", "auto_closed"],
  ]) {
    assert.match(history, new RegExp(`WHEN gs\\.status = '${guardStatus}' THEN '${canonical}'`));
  }
  assert.match(history, /THEN 'stale'/);
  assert.match(history, /COALESCE\(gs\.logout_time, gs\.last_heartbeat, gs\.login_time\)\s+- gs\.login_time/);
  assert.match(history, /GREATEST\(\s*0,/);
  assert.doesNotMatch(history, /NOW\(\)\s*-\s*gs\.login_time/);
});

test("history filters both surfaces and returns newest sessions first", () => {
  assert.match(history, /g\.username = \$\$\{guardValues\.length\}/);
  assert.match(history, /COALESCE\(gs\.logout_time, gs\.last_heartbeat, gs\.login_time\)/);
  assert.match(history, /session\.is_currently_online === activeFilter/);
  assert.match(history, /new Date\(right\.login_time\).*new Date\(left\.login_time\)/s);
});

test("CSV includes surface and Guard Preview rows", () => {
  assert.match(exportRoute, /const sessions = \[\.\.\.result\.rows, \.\.\.guardResult\.rows\]/);
  assert.match(exportRoute, /const headers = \[\s*"surface"/);
  assert.match(exportRoute, /const csvRows = sessions\.map/);
});

test("operational active guards remain standard-only", () => {
  const activeGuards = routeSource('"/guards/active"', '"/guards/shifts/history"');
  assert.match(activeGuards, /g\.access_mode = 'standard'/);
  assert.doesNotMatch(activeGuards, /guard_web_app:/);
});
