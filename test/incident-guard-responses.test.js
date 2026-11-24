const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const logSource = section("app.post('/incident-log'", '// ACTIVE ADMINS');
const panicSource = section("app.post('/alert'", '// Vonage delivery webhooks');
const responseSource = section('app.get(\n  "/incidents/:id/guard-responses"', 'app.get("/incidents/resolved"');
const reportSource = section('function formatDuration(', '// QR PATROL POINTS API');
const guard = { guard_id: 1, site_id: 1, session_id: 253, company_id: 1 };
const answers = { incident_type: 'Test incident', location: 'Main entrance', actions_taken: 'Contacted supervisor' };
function routes(pool, ai = async () => 'summary') {
  const handlers = {}, dispatches = [], diagnostics = [];
  let aiCalls = 0, pdfHtml = '';
  const requireGuardAuth = () => {}, requireAuth = () => {};
  const sandbox = {
    app: Object.fromEntries(['get','post'].map(method => [method, (route, auth, handler) => {
      assert.equal(auth, ['/alert','/incident-log'].includes(route) ? requireGuardAuth : requireAuth);
      handlers[`${method} ${route}`] = handler;
    }])), pool, requireGuardAuth, requireAuth,
    ensureIncidentGuardResponsesTable: async () => {},
    processIncidentLog: async text => { aiCalls++; return ai(text); },
    reverseGeocode: async () => 'Test address',
    alertDispatcher: { dispatchAlertNotifications: async args => { dispatches.push(args); return { notifications: { sms: [{ phone: 'test' }], voice: [{ phone: 'test' }] } }; } },
    console: { log() {}, error: (...a) => diagnostics.push(a), warn: (...a) => diagnostics.push(a) },
    getCompanyTimezone: async () => 'Europe/Athens',
    puppeteer: { launch: async () => ({ newPage: async () => ({ setContent: async html => { pdfHtml = html; }, pdf: async () => Buffer.from('%PDF-test') }), close: async () => {} }) },
    fetch: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer test-admin'); const res = await invoke('get /incidents/:id/report', { params: { id: sandbox.reportId }, auth: { effective_company_id: 1 } }); return { json: async () => res.body }; },
  };
  vm.runInNewContext(logSource + panicSource + responseSource + reportSource, sandbox);
  async function invoke(route, req) {
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader(k,v) { this.headers[k] = v; }, send(body) { this.body = body; return this; } };
    await handlers[route](req, res); return res;
  }
  return { invoke, dispatches, diagnostics, aiCalls: () => aiCalls, pdfHtml: () => pdfHtml, sandbox };
}

test('invalid correlation is rejected before any write connection; auth remains required', async () => {
  const r = routes({ connect: async () => assert.fail('must not acquire write connection') });
  for (const body of [{ message: 'followup', incidentAnswers: answers }, { message: 'followup', incidentAnswers: answers, incidentId: 40, sessionId: 999 }]) {
    const res = await r.invoke('post /incident-log', { guard, body });
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'INCIDENT_ASSOCIATION_REQUIRED');
  }
  assert.doesNotMatch(logSource, /ORDER BY trigger_time DESC|rows\[0\]\?\.id \|\| null/);
});

test('real PostgreSQL: association, atomic persistence, retries and report separation', {
  skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL is not configured',
}, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `incident_responses_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`
    CREATE TABLE companies (id integer PRIMARY KEY, timezone text);
    CREATE TABLE sites (id integer PRIMARY KEY, company_id integer, name text, location text);
    CREATE TABLE guards (id integer PRIMARY KEY, full_name text, username text);
    CREATE TABLE guard_sessions (id integer PRIMARY KEY, guard_id integer, site_id integer, login_time timestamp, logout_time timestamp);
    CREATE TABLE incidents (id bigserial PRIMARY KEY, incident_ref text, company_id integer, guard_ref bigint, site_id integer,
      status text, priority text, trigger_time timestamp, resolved_time timestamp, auto_reset_time timestamp, ai_summary text, needs_support boolean,
      incident_latitude numeric, incident_longitude numeric, incident_accuracy integer, incident_battery_level integer,
      incident_address text, incident_location_timestamp timestamp, created_at timestamp);
    CREATE TABLE incident_guard_responses (id serial PRIMARY KEY, incident_id integer REFERENCES incidents(id), guard_id integer,
      site_id integer, session_id integer, question_key text, question_text text, answer text, created_at timestamp);
    CREATE TABLE incident_resolution_actions (incident_id bigint, supervisor_notified boolean, supervisor_name text, supervisor_notes text,
      guard_contacted boolean, guard_contacted_name text, guard_notes text, residence_contacted boolean,
      residence_contacted_name text, residence_notes text, admin_notes text, approved_by text, approved_at timestamp);
    CREATE TABLE alert_events (id serial PRIMARY KEY, incident_id bigint, event_type text, source text, status text, sms_sent integer,
      sms_failed integer, voice_attempted integer, voice_status text, recipient_phone text, provider text, provider_call_uuid text, event_payload jsonb, created_at timestamp);
    INSERT INTO companies VALUES (1,'Europe/Athens'),(2,'Europe/Athens');
    INSERT INTO sites VALUES (1,1,'Test Site','Athens'),(2,2,'Other Tenant','Other Site');
    INSERT INTO guards VALUES (1,'Test Guard','test_guard'),(2,'Other Guard','other_guard');
    INSERT INTO guard_sessions VALUES
      (253,1,1,(NOW() AT TIME ZONE 'Europe/Athens') - INTERVAL '1 hour',NULL),
      (254,1,1,(NOW() AT TIME ZONE 'Europe/Athens') + INTERVAL '1 hour',NULL);
  `);
  const r = routes(pool);
  const panic = async () => {
    const res = await r.invoke('post /alert', { guard, body: { source: 'aegis-link-webapp', latitude: 38, longitude: 23, accuracy: 10, battery: 90 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body)); return Number(res.body.incident.id);
  };
  const submit = (id, extra = {}, instance = r, auth = guard) => instance.invoke('post /incident-log', {
    guard: auth, body: { message: 'Incident follow-up (3-question flow)', incidentId: id, sessionId: auth.session_id, incidentAnswers: answers, ...extra },
  });
  const count = async id => Number((await pool.query('SELECT count(*) FROM incident_guard_responses WHERE incident_id=$1', [id])).rows[0].count);
  let id;
  await t.test('normal panic preserves dispatch/GPS and saves exactly three responses', async () => {
    id = await panic(); const res = await submit(id);
    assert.equal(res.body.responsesSaved, true, JSON.stringify(res.body));
    assert.equal(res.body.incidentId, id); assert.equal(res.body.responseCount, 3);
    const { rows } = await pool.query('SELECT * FROM incident_guard_responses WHERE incident_id=$1 ORDER BY id', [id]);
    assert.equal(rows.length, 3); assert.ok(rows.every(row => Number(row.incident_id) === id && row.guard_id === 1 && row.session_id === 253));
    assert.deepEqual(rows.map(row => row.answer), Object.values(answers));
    assert.equal(Number(r.dispatches[0].incident_id), id); assert.equal(r.dispatches[0].companyId, 1);
    const incident = (await pool.query('SELECT * FROM incidents WHERE id=$1', [id])).rows[0];
    assert.equal(incident.status, 'active'); assert.equal(Number(incident.incident_latitude), 38); assert.equal(incident.incident_address, 'Test address');
  });
  await t.test('429 and indefinitely hung AI cannot block structured persistence', async () => {
    for (const ai of [async () => { throw Object.assign(new Error('quota'), { status: 429 }); }, () => new Promise(() => {})]) {
      const next = await panic(), instance = routes(pool, ai), res = await submit(next, {}, instance);
      assert.equal(res.statusCode, 200); assert.equal(instance.aiCalls(), 0); assert.equal(await count(next), 3);
    }
  });
  await t.test('concurrent retries are idempotent and cannot overwrite evidence', async () => {
    const results = await Promise.all([submit(id), submit(id)]);
    assert.ok(results.every(x => x.body.responsesSaved === true)); assert.equal(await count(id), 3);
    assert.equal((await submit(id, { incidentAnswers: { ...answers, location: 'replacement' } })).body.code, 'GUARD_RESPONSES_CONFLICT');
    assert.equal(await count(id), 3);
  });
  await t.test('two incidents for one guard/site attach only to the explicit target', async () => {
    const intended = await panic(), newer = await panic();
    assert.equal((await submit(intended)).statusCode, 200); assert.equal(await count(intended), 3); assert.equal(await count(newer), 0);
  });
  await t.test('wrong incident, tenant, guard or session produces no orphan responses', async () => {
    assert.equal((await submit(999999)).body.code, 'INCIDENT_ASSOCIATION_INVALID');
    for (const auth of [{ ...guard, company_id: 2 }, { ...guard, guard_id: 2 }, { ...guard, session_id: 254 }])
      assert.equal((await submit(id, {}, r, auth)).body.code, 'INCIDENT_ASSOCIATION_INVALID');
    assert.equal((await submit(id, { incidentId: null })).body.code, 'INCIDENT_ASSOCIATION_REQUIRED');
    assert.equal((await submit(id, { incidentAnswers: { incident_type: 'partial' } })).body.code, 'GUARD_RESPONSES_INVALID');
    assert.equal((await pool.query('SELECT count(*) FROM incident_guard_responses WHERE incident_id IS NULL')).rows[0].count, '0');
  });
  await t.test('database failure rolls back all three responses', async () => {
    const next = await panic();
    await pool.query(`CREATE FUNCTION reject_actions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.question_key='actions_taken' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_response BEFORE INSERT ON incident_guard_responses FOR EACH ROW EXECUTE FUNCTION reject_actions();`);
    try { assert.equal((await submit(next)).statusCode, 500); assert.equal(await count(next), 0); }
    finally { await pool.query('DROP TRIGGER fail_response ON incident_guard_responses'); }
  });
  await t.test('existing report, response reader and PDF consume exactly persisted answers', async () => {
    const req = { params: { id }, auth: { effective_company_id: 1 } };
    const res = await r.invoke('get /incidents/:id/report', req);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(Array.from(res.body.guard_responses, row => row.answer), Object.values(answers));
    const reader = await r.invoke('get /incidents/:id/guard-responses', req);
    assert.equal(reader.body.responses.length, 3);
    assert.equal((await r.invoke('get /incidents/:id/report', { ...req, auth: { effective_company_id: 2 } })).statusCode, 404);
    r.sandbox.reportId = id;
    const pdf = await r.invoke('get /incidents/:id/report/pdf', { params: { id }, headers: { authorization: 'Bearer test-admin' }, protocol: 'http', get: key => key === 'host' ? 'localhost' : null });
    assert.equal(pdf.statusCode, 200); assert.equal(pdf.headers['Content-Type'], 'application/pdf'); assert.ok(pdf.body.toString().startsWith('%PDF'));
    for (const answer of Object.values(answers)) assert.ok(r.pdfHtml().includes(answer));
  });
  await t.test('editing investigation notes leaves structured Guard Responses intact', async () => {
    const before = (await pool.query('SELECT * FROM incident_guard_responses WHERE incident_id=$1 ORDER BY id', [id])).rows;
    for (const guard_notes of ['Independent investigation note','Edited investigation note']) {
      const res = await r.invoke('post /incidents/:id/resolve', { params: { id }, auth: { effective_company_id: 1 }, body: { guard_notes, supervisor_notes: 'Supervisor', residence_notes: 'Residence', admin_notes: 'Admin' } });
      assert.equal(res.statusCode, 200);
    }
    assert.deepEqual((await pool.query('SELECT * FROM incident_guard_responses WHERE incident_id=$1 ORDER BY id', [id])).rows, before);
    const res = await r.invoke('get /incidents/:id/report', { params: { id }, auth: { effective_company_id: 1 } });
    assert.equal(res.body.investigation.guard_notes, 'Edited investigation note');
    assert.deepEqual(Array.from(res.body.guard_responses, row => row.answer), Object.values(answers));
  });
});
