const test = require("node:test");
const assert = require("node:assert/strict");
const { registerSiteSopRoutes } = require("../site-sop");

function setup(companyId = 1) {
  const routes = {};
  let downloads = 0;
  const app = {
    get(path, ...handlers) { routes[`GET ${path}`] = handlers.at(-1); },
    post(path, ...handlers) { routes[`POST ${path}`] = handlers.at(-1); },
  };
  const pool = { async query(_sql, [id, tenant]) {
    return { rows: id === 17 && tenant === 1 ? [{ id: 17, company_id: 1, sop_storage_path: "private.pdf" }] : [] };
  } };
  const storage = {
    async getBucket() { return { data: { public: false } }; },
    from() { return {
      async download() { downloads += 1; return { data: new Blob(["%PDF-private"], { type: "application/pdf" }) }; },
    }; },
  };
  registerSiteSopRoutes({ app, pool, supabase: { storage }, requireAuth() {}, upload: { single() { return () => {}; } } });
  const req = { params: { id: "17" }, auth: { effective_company_id: companyId } };
  const res = {
    code: 200, headers: {},
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    send(value) { this.body = value; return this; },
  };
  return { route: routes["GET /settings/sites/:id/sop/file"], req, res, downloads: () => downloads };
}

test("private SOP download succeeds only in owning tenant", async () => {
  const allowed = setup(1);
  await allowed.route(allowed.req, allowed.res);
  assert.equal(allowed.res.code, 200);
  assert.equal(allowed.res.body.toString(), "%PDF-private");
  assert.equal(allowed.res.headers["Cache-Control"], "private, no-store");

  const denied = setup(2);
  await denied.route(denied.req, denied.res);
  assert.equal(denied.res.code, 404);
  assert.equal(denied.downloads(), 0);
});
