const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createPatrolCorrectionsRouter } = require("../patrol/corrections");

test("direct foreign site and occurrence IDs cannot cross the effective tenant", async () => {
  const queries = [];
  const pool = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes("SELECT id FROM sites WHERE id=$1 AND company_id=$2")) return { rows: [] };
    if (sql.includes("CONCAT('patrol-log-', pl.id) AS occurrence_key")) {
      return { rows: [{ occurrence_key: "patrol-log-43", company_id: 1, site_id: 7 }] };
    }
    throw new Error("A foreign tenant request must stop before this query");
  } };
  const app = express();
  app.use(express.json());
  app.use("/admin/patrol-corrections", createPatrolCorrectionsRouter({
    pool, requireAuth: (req, _res, next) => {
      req.auth = { effective_company_id: 8, user_id: 2, is_system_owner: true };
      next();
    }, requirePermission: () => (_req, _res, next) => next(),
  }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/admin/patrol-corrections`;
    const list = await fetch(`${base}/occurrences?site_id=7&from=2026-09-01&to=2026-09-02`);
    assert.equal(list.status, 404);
    assert.deepEqual(queries[0].values, [7, 8]);
    const write = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ occurrence_key: "patrol-log-43", field: "outcome", corrected_value: "MISSED",
        reason: "Testing tenant boundary" }) });
    assert.equal(write.status, 404);
    assert.equal(queries.some(q => q.sql.includes("INSERT INTO patrol_corrections")), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
