const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createSiteWithOperationalId } = require("../sites/operational-id");

test("operational site migration and transactional allocation preserve tenant identity", {
  skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not configured",
}, async () => {
  const schema = `operational_${crypto.randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let scoped;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    scoped = new Pool({ connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`, max: 5 });
    await scoped.query(`CREATE TABLE companies (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT, timezone TEXT
    )`);
    await scoped.query(`CREATE TABLE sites (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL, location TEXT, status TEXT, required_shifts INTEGER,
      created_at TIMESTAMPTZ
    )`);
    await scoped.query(`INSERT INTO companies (id,name) VALUES
      (1,'Defensor Civitatis Security'),(2,'Another Security Company'),
      (3,'Another Security Company'),(4,'Defensor Civitatis Security')`);
    await scoped.query(`INSERT INTO sites (id,company_id,name,location) VALUES
      (10,1,'Old First','Athens'),(12,1,'Old Second','North'),(11,2,'Other','Patras')`);
    await scoped.query(`SELECT setval(pg_get_serial_sequence('sites','id'), 12)`);
    const migration = fs.readFileSync(path.join(__dirname,
      "../database/2026-10-01-operational-site-id.sql"), "utf8");
    await scoped.query(migration);
    const companies = (await scoped.query(`SELECT id,site_prefix,next_site_number FROM companies ORDER BY id`)).rows;
    assert.deepEqual(companies.map(c => c.site_prefix), ["DEF", "ASC", "ASC1", "DEF1"]);
    assert.deepEqual(companies.map(c => c.next_site_number), [3, 2, 1, 1]);
    const old = (await scoped.query(`SELECT site_code FROM sites ORDER BY company_id,id`)).rows;
    assert.deepEqual(old.map(s => s.site_code), ["DEF-001", "DEF-002", "ASC-001"]);

    const allocate = (companyId, name = "New") => createSiteWithOperationalId({
      pool: scoped, companyId, name, location: "Athens", requiredShifts: 1,
    });
    const [first, second] = await Promise.all([allocate(1), allocate(1)]);
    assert.deepEqual([first.site_code, second.site_code].sort(), ["DEF-003", "DEF-004"]);
    assert.equal((await allocate(3)).site_code, "ASC1-001");
    assert.equal((await scoped.query(`SELECT next_site_number FROM companies WHERE id=1`)).rows[0].next_site_number, 5);
    await assert.rejects(allocate(1, null), { code: "23502" });
    assert.equal((await scoped.query(`SELECT next_site_number FROM companies WHERE id=1`)).rows[0].next_site_number, 5);
    await scoped.query(`DELETE FROM sites WHERE site_code='DEF-004'`);
    assert.equal((await allocate(1)).site_code, "DEF-005");

    await scoped.query(`UPDATE companies SET name='Renamed' WHERE id=1`);
    await scoped.query(`UPDATE sites SET name='Headquarters',location='Athens North' WHERE site_code='DEF-001'`);
    assert.deepEqual((await scoped.query(`SELECT site_code,location FROM sites WHERE id=10`)).rows[0],
      { site_code: "DEF-001", location: "Athens North" });
    await assert.rejects(scoped.query(`UPDATE companies SET site_prefix='XYZ' WHERE id=1`), /locked/);
    await assert.rejects(scoped.query(`UPDATE sites SET site_code='DEF-999' WHERE id=10`), /cannot be changed/);
    await assert.rejects(scoped.query(`UPDATE sites SET company_id=2 WHERE id=10`), /cannot be changed/);
    await assert.rejects(scoped.query(`INSERT INTO companies (id,name,site_prefix) VALUES (5,'Duplicate','DEF')`), { code: "23505" });
  } finally {
    if (scoped) await scoped.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
