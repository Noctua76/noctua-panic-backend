const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  MAX_ATTACHMENTS,
  MAX_FILE_SIZE,
  detectImageType,
  validateReportInput,
  buildAdminFilters,
  reportNumber,
  pdfDisposition,
  removeStorageWithRetry,
  createShiftReportsRouter,
} = require("../reports/shift-reports");

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = Buffer.from("RIFF0000WEBP", "ascii");

function file(buffer, mimetype, extra = {}) {
  return { buffer, mimetype, size: buffer.length, originalname: "photo", ...extra };
}

test("detects a genuine JPEG signature", () => {
  assert.deepEqual(detectImageType(jpeg), { mimeType: "image/jpeg", extension: "jpg" });
});

test("detects a genuine PNG signature", () => {
  assert.deepEqual(detectImageType(png), { mimeType: "image/png", extension: "png" });
});

test("detects a genuine WEBP signature", () => {
  assert.deepEqual(detectImageType(webp), { mimeType: "image/webp", extension: "webp" });
});

test("rejects unsupported file contents", () => {
  assert.equal(detectImageType(Buffer.from("not an image")), null);
});

test("rejects a MIME/signature mismatch", () => {
  assert.throws(
    () => validateReportInput({ category: "OTHER", message: "Note" }, [file(jpeg, "image/png")]),
    /genuine JPEG, PNG and WEBP/
  );
});

test("accepts up to five valid attachments", () => {
  const files = Array.from({ length: MAX_ATTACHMENTS }, () => file(jpeg, "image/jpeg"));
  assert.equal(validateReportInput({ category: "OBSERVATION", message: "Note" }, files).files.length, 5);
});

test("rejects more than five attachments", () => {
  const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => file(jpeg, "image/jpeg"));
  assert.throws(() => validateReportInput({ category: "OTHER", message: "Note" }, files), /maximum of 5/);
});

test("rejects an image larger than ten MB", () => {
  assert.throws(
    () => validateReportInput({ category: "OTHER", message: "Note" }, [file(jpeg, "image/jpeg", { size: MAX_FILE_SIZE + 1 })]),
    /10 MB/
  );
});

test("rejects an empty operational note", () => {
  assert.throws(() => validateReportInput({ category: "OTHER", message: "   " }, []), /between 1 and 5000/);
});

test("rejects a note over 5000 characters", () => {
  assert.throws(() => validateReportInput({ category: "OTHER", message: "a".repeat(5001) }, []), /between 1 and 5000/);
});

test("normalizes valid category and priority values", () => {
  const value = validateReportInput({ category: "security_concern", priority: "important", message: "  Door open  " }, []);
  assert.deepEqual({ category: value.category, priority: value.priority, message: value.message }, { category: "SECURITY_CONCERN", priority: "IMPORTANT", message: "Door open" });
});

test("rejects unknown category and priority values", () => {
  assert.throws(() => validateReportInput({ category: "INCIDENT", message: "Note" }, []), /category/);
  assert.throws(() => validateReportInput({ category: "OTHER", priority: "URGENT", message: "Note" }, []), /priority/);
});

test("formats stable human-readable report numbers", () => {
  assert.equal(reportNumber("2026-09-20", 184), "SR-20260920-000184");
});

test("regular admin filters are always tenant scoped", () => {
  const result = buildAdminFilters({}, { role: "admin", company_id: 42 });
  assert.match(result.where, /r\.company_id = \$1/);
  assert.deepEqual(result.values, [42]);
});

test("system owner may explicitly filter a company", () => {
  const result = buildAdminFilters({ company_id: "8" }, { role: "system_owner", company_id: 1 });
  assert.match(result.where, /r\.company_id = \$1/);
  assert.deepEqual(result.values, [8]);
});

test("site, guard and lifecycle filters are parameterized", () => {
  const result = buildAdminFilters(
    { site_id: "2", guard_id: "3", category: "OTHER", priority: "NORMAL", status: "NEW" },
    { role: "admin", company_id: 7 }
  );
  assert.equal(result.values.length, 6);
  assert.doesNotMatch(result.where, /OTHER|NORMAL|NEW/);
});

test("invalid numeric filters are rejected", () => {
  assert.throws(() => buildAdminFilters({ site_id: "1 OR 1=1" }, { role: "admin", company_id: 7 }), /Invalid site_id/);
});

test("date filters use each company's canonical timezone boundaries", () => {
  const result = buildAdminFilters(
    { from: "2026-09-19", to: "2026-09-20" },
    { role: "admin", company_id: 7 }
  );
  assert.match(result.where, /AT TIME ZONE COALESCE\(c\.timezone/);
  assert.match(result.where, /\?::date \+ 1|\$3::date \+ 1/);
  assert.deepEqual(result.values, [7, "2026-09-19", "2026-09-20"]);
});

test("invalid calendar dates are rejected before reaching PostgreSQL", () => {
  assert.throws(
    () => buildAdminFilters({ from: "2026-02-31" }, { role: "admin", company_id: 7 }),
    /Invalid from date/
  );
});

test("PDF disposition explicitly supports inline preview", () => {
  assert.equal(pdfDisposition("inline"), "inline");
  assert.equal(pdfDisposition("attachment"), "attachment");
  assert.equal(pdfDisposition("anything-else"), "attachment");
});

test("migration enforces immutable content and lifecycle statuses", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../database/2026-09-20-shift-reports.sql"), "utf8");
  assert.match(sql, /operational content is immutable/);
  assert.match(sql, /OLD\.status = 'NEW' AND NEW\.status = 'READ'/);
  assert.match(sql, /OLD\.status = 'READ' AND NEW\.status = 'ACKNOWLEDGED'/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
});

test("migration creates immutable audit records", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../database/2026-09-20-shift-reports.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS guard_shift_report_events/);
  assert.match(sql, /SHIFT_REPORT_CREATED/);
  assert.match(sql, /SHIFT_REPORT_READ/);
  assert.match(sql, /SHIFT_REPORT_ACKNOWLEDGED/);
});

test("router owns identity from authenticated guard and enforces active shift end", () => {
  const source = fs.readFileSync(path.join(__dirname, "../reports/shift-reports.js"), "utf8");
  assert.match(source, /const guard = req\.guard/);
  assert.doesNotMatch(source, /req\.body\.(company_id|site_id|guard_id|session_id)/);
  assert.match(source, /gs\.scheduled_shift_end > \(NOW\(\) AT TIME ZONE/);
});

test("storage rollback and short-lived tenant-checked signed URLs are present", () => {
  const source = fs.readFileSync(path.join(__dirname, "../reports/shift-reports.js"), "utf8");
  assert.match(source, /removeStorageWithRetry\(storage, uploadedPaths\)/);
  assert.match(source, /const row = await scopedReport\(req, req\.params\.id\)/);
  assert.match(source, /const expires_in = 300/);
});

test("unread badge uses a dedicated tenant-scoped count endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "../reports/shift-reports.js"), "utf8");
  assert.match(source, /\/shift-reports\/unread-count/);
  assert.match(source, /status='NEW'/);
  assert.match(source, /company_id=\$1/);
});

async function withRouter({ pool, storage, guard, admin, puppeteer }, callback) {
  const app = express();
  const requireGuardAuth = (req, _res, next) => { req.guard = guard; next(); };
  const requireAuth = (req, _res, next) => { req.auth = admin; next(); };
  app.use(createShiftReportsRouter({
    pool,
    storage,
    requireGuardAuth,
    requireAuth,
    puppeteer: puppeteer || { launch: async () => { throw new Error("PDF not used in this test"); } },
  }));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createPostFixture({ active = true, uploadFailureAt = 0 } = {}) {
  const statements = [];
  let uploads = 0;
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes("FROM guard_sessions gs")) return { rows: active ? [{ scheduled_shift_start: "2026-09-19 23:00", scheduled_shift_end: "2026-09-20 07:00", local_date: "2026-09-20" }] : [] };
      if (sql.includes("nextval")) return { rows: [{ id: "184" }] };
      if (sql.includes("INSERT INTO guard_shift_reports")) return { rows: [{ id: "184", report_number: "SR-20260920-000184" }] };
      return { rows: [] };
    },
    release() {},
  };
  const removed = [];
  return {
    statements,
    removed,
    pool: { connect: async () => client, query: (...args) => client.query(...args) },
    storage: {
      async upload() { uploads += 1; if (uploadFailureAt === uploads) throw new Error("upload failed"); },
      async remove(paths) { removed.push(...paths); },
      async createSignedUrl() { return "signed"; },
      async download() { return Buffer.from(""); },
    },
  };
}

const guardContext = { company_id: 9, site_id: 8, guard_id: 7, session_id: 6 };
const adminContext = { company_id: 9, user_id: 5, role: "admin" };

test("HTTP create ignores forged ownership fields and uses authenticated guard context", async () => {
  const fixture = createPostFixture();
  await withRouter({ ...fixture, guard: guardContext, admin: adminContext }, async (base) => {
    const form = new FormData();
    form.set("category", "OTHER"); form.set("priority", "NORMAL"); form.set("message", "Cross-midnight note");
    form.set("company_id", "999"); form.set("site_id", "999"); form.set("guard_id", "999"); form.set("session_id", "999");
    const response = await fetch(`${base}/guard/shift-reports`, { method: "POST", body: form });
    assert.equal(response.status, 201);
  });
  const insert = fixture.statements.find(({ sql }) => sql.includes("INSERT INTO guard_shift_reports"));
  assert.deepEqual(insert.values.slice(2, 6), [9, 8, 7, 6]);
});

test("HTTP create rejects a guard session after its scheduled shift end", async () => {
  const fixture = createPostFixture({ active: false });
  await withRouter({ ...fixture, guard: guardContext, admin: adminContext }, async (base) => {
    const form = new FormData(); form.set("category", "OTHER"); form.set("message", "Too late");
    const response = await fetch(`${base}/guard/shift-reports`, { method: "POST", body: form });
    assert.equal(response.status, 409);
  });
  assert.ok(fixture.statements.some(({ sql }) => sql === "ROLLBACK"));
});

test("HTTP create removes earlier private uploads when a later upload fails", async () => {
  const fixture = createPostFixture({ uploadFailureAt: 2 });
  await withRouter({ ...fixture, guard: guardContext, admin: adminContext }, async (base) => {
    const form = new FormData(); form.set("category", "OTHER"); form.set("message", "Two photos");
    form.append("attachments", new Blob([jpeg], { type: "image/jpeg" }), "one.jpg");
    form.append("attachments", new Blob([jpeg], { type: "image/jpeg" }), "two.jpg");
    const response = await fetch(`${base}/guard/shift-reports`, { method: "POST", body: form });
    assert.equal(response.status, 500);
  });
  assert.equal(fixture.removed.length, 1);
  assert.ok(fixture.statements.some(({ sql }) => sql === "ROLLBACK"));
});

test("storage cleanup retries transient Supabase removal failures", async () => {
  let attempts = 0;
  await removeStorageWithRetry({
    async remove() {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary cleanup failure");
    },
  }, ["company-9/site-8/report-184/one.jpg"]);
  assert.equal(attempts, 3);
});

test("HTTP image submission uploads and records a genuine attachment", async () => {
  const fixture = createPostFixture();
  await withRouter({ ...fixture, guard: guardContext, admin: adminContext }, async (base) => {
    const form = new FormData(); form.set("category", "OBSERVATION"); form.set("message", "Photo evidence");
    form.append("attachments", new Blob([jpeg], { type: "image/jpeg" }), "evidence.jpg");
    const response = await fetch(`${base}/guard/shift-reports`, { method: "POST", body: form });
    assert.equal(response.status, 201);
  });
  assert.ok(fixture.statements.some(({ sql }) => sql.includes("INSERT INTO guard_shift_report_attachments")));
  assert.ok(fixture.statements.some(({ sql }) => sql === "COMMIT"));
});

test("HTTP signed URL returns 404 before storage access for another tenant", async () => {
  let signedUrlCalls = 0;
  const pool = { query: async () => ({ rows: [] }) };
  const storage = { createSignedUrl: async () => { signedUrlCalls += 1; return "signed"; } };
  await withRouter({ pool, storage, guard: guardContext, admin: adminContext }, async (base) => {
    const response = await fetch(`${base}/shift-reports/22/attachments/31/url`);
    assert.equal(response.status, 404);
  });
  assert.equal(signedUrlCalls, 0);
});

test("HTTP acknowledge rejects an invalid NEW to ACKNOWLEDGED jump", async () => {
  const row = { id: 22, company_id: 9, status: "NEW", report_number: "SR-1" };
  const statements = [];
  const client = { query: async (sql) => { statements.push(sql); return sql.includes("SELECT") ? { rows: [row] } : { rows: [] }; }, release() {} };
  const pool = { connect: async () => client, query: (...args) => client.query(...args) };
  const storage = { createSignedUrl: async () => "signed" };
  await withRouter({ pool, storage, guard: guardContext, admin: adminContext }, async (base) => {
    const response = await fetch(`${base}/shift-reports/22/acknowledge`, { method: "PATCH" });
    assert.equal(response.status, 409);
  });
  assert.ok(statements.includes("ROLLBACK"));
  assert.ok(!statements.some((sql) => sql.includes("SET status='ACKNOWLEDGED'")));
});

test("HTTP READ transition succeeds once and writes an immutable audit event", async () => {
  const row = { id: 22, company_id: 9, status: "NEW", report_number: "SR-1" };
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes("SELECT") && sql.includes("guard_shift_reports")) return { rows: [row] };
      if (sql.includes("UPDATE guard_shift_reports")) return { rows: [{ ...row, status: "READ", read_at: new Date().toISOString(), read_by_admin_id: 5 }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: (...args) => client.query(...args) };
  const storage = { createSignedUrl: async () => "signed" };
  await withRouter({ pool, storage, guard: guardContext, admin: adminContext }, async (base) => {
    const response = await fetch(`${base}/shift-reports/22/read`, { method: "PATCH" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).report.status, "READ");
  });
  assert.ok(statements.some(({ sql, values }) => sql.includes("guard_shift_report_events") && values.includes("SHIFT_REPORT_READ")));
  assert.ok(statements.some(({ sql }) => sql === "COMMIT"));
});

test("bulk PDF supports inline preview, shift metadata and private photographic appendix", async () => {
  let renderedHtml = "";
  const report = {
    id: 22, report_number: "SR-20260920-000022", company_id: 9,
    company_name: "Noctua", company_timezone: "Europe/Athens",
    site_id: 8, site_name: "Ekali", guard_id: 7, guard_name: "Guard",
    session_id: 6, scheduled_shift_start: "2026-09-19T20:00:00Z",
    scheduled_shift_end: "2026-09-20T04:00:00Z", category: "OBSERVATION",
    priority: "NORMAL", status: "READ", message: "Secure photo", created_at: "2026-09-19T21:00:00Z",
  };
  const pool = {
    async query(sql) {
      if (sql.includes("FROM guard_shift_report_attachments") && sql.includes("ANY")) {
        return { rows: [{ report_id: 22, storage_path: "private/photo.jpg", mime_type: "image/jpeg", original_filename: "photo.jpg" }] };
      }
      return { rows: [report] };
    },
  };
  const storage = { async download() { return jpeg; } };
  const puppeteer = {
    async launch() {
      return {
        async newPage() { return { async setContent(html) { renderedHtml = html; }, async pdf() { return Buffer.from("%PDF-test"); } }; },
        async close() {},
      };
    },
  };
  await withRouter({ pool, storage, guard: guardContext, admin: { ...adminContext, full_name: "Admin Name" }, puppeteer }, async (base) => {
    const response = await fetch(`${base}/shift-reports/report/pdf?disposition=inline&status=READ`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), /^inline;/);
    assert.match(response.headers.get("content-type"), /application\/pdf/);
  });
  assert.match(renderedHtml, /Applied Filters/);
  assert.match(renderedHtml, /Generated By/);
  assert.match(renderedHtml, /Admin Name/);
  assert.match(renderedHtml, /Photographic Appendix/);
  assert.match(renderedHtml, /data:image\/jpeg;base64/);
  assert.match(renderedHtml, /Session/);
  assert.match(renderedHtml, /Shift/);
});

test("individual PDF contains complete audit metadata and descriptive filename", async () => {
  let renderedHtml = "";
  const report = {
    id: 22, report_number: "SR-20260920-000022", company_id: 9,
    company_name: "Noctua", company_timezone: "Europe/Athens",
    site_id: 8, site_name: "Ekali", guard_id: 7, guard_name: "Guard",
    session_id: 6, scheduled_shift_start: "2026-09-19T20:00:00Z",
    scheduled_shift_end: "2026-09-20T04:00:00Z", category: "OBSERVATION",
    priority: "IMPORTANT", status: "ACKNOWLEDGED", message: "Handover",
    created_at: "2026-09-19T21:00:00Z", read_at: "2026-09-19T21:10:00Z",
    read_by_admin_name: "Reader", acknowledged_at: "2026-09-19T21:15:00Z",
    acknowledged_by_admin_name: "Acknowledger",
  };
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT") && sql.includes("guard_shift_reports r")) return { rows: [report] };
      if (sql.includes("guard_shift_report_attachments")) return { rows: [] };
      return { rows: [] };
    },
  };
  const storage = { async download() { return jpeg; } };
  const puppeteer = {
    async launch() {
      return {
        async newPage() { return { async setContent(html) { renderedHtml = html; }, async pdf() { return Buffer.from("%PDF-test"); } }; },
        async close() {},
      };
    },
  };
  await withRouter({ pool, storage, guard: guardContext, admin: { ...adminContext, full_name: "Generator" }, puppeteer }, async (base) => {
    const response = await fetch(`${base}/shift-reports/22/report/pdf`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), /attachment; filename="Aegis-Link-Shift-Report-SR-20260920-000022\.pdf"/);
  });
  for (const value of ["Company", "Session ID", "Reader", "Acknowledger", "Generated At", "Generator"]) {
    assert.match(renderedHtml, new RegExp(value));
  }
});

test("production guard auth remains the mutation gate for read-only Shift Reports", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const reportSource = fs.readFileSync(path.join(__dirname, "../reports/shift-reports.js"), "utf8");
  assert.match(serverSource, /blockReadOnlyMutation\([\s\S]*req\.guard\.access_mode[\s\S]*READ_ONLY_GUARD_MUTATION_ALLOWLIST/);
  assert.match(reportSource, /router\.post\("\/guard\/shift-reports", requireGuardAuth/);
});
