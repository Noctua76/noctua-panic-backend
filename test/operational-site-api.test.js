const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

test("guard login returns stored site identity without changing session site id", () => {
  const login = source.slice(source.indexOf('app.post("/guard/login"'), source.indexOf('app.post("/guard/logout"'));
  assert.match(login, /s\.site_code, s\.location AS site_location/);
  assert.match(login, /site_id: guard\.site_id/);
  assert.match(login, /site_code: guard\.site_code/);
  assert.match(login, /site_location: guard\.site_location/);
  assert.doesNotMatch(login, /company_status: guard\.company_status/);
});

test("site creation uses authenticated effective company and stored transaction allocation", () => {
  const create = source.slice(source.indexOf('app.post("/settings/sites"'), source.indexOf('app.put("/settings/sites/', source.indexOf('app.post("/settings/sites"')));
  assert.match(create, /req\.auth\.effective_company_id/);
  assert.match(create, /createSiteWithOperationalId/);
  assert.doesNotMatch(create, /req\.body\.company_id/);
  assert.match(source, /WITH site_summary AS \([\s\S]*?s\.site_code/);
});
