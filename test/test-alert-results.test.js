const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTestAlertResultReader,
} = require("../notifications/alert-result-reader");

function createReader(rows) {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      const [testId, companyId] = params;
      const row = rows.find((item) =>
        item.id === testId && item.company_id === companyId
      );
      return { rows: row ? [row] : [] };
    },
  };
  const reader = createTestAlertResultReader({
    pool,
    hydrateTestAlertRows: async (stored) => stored.map((row) => ({
      ...row.event_payload.result,
      test_id: row.id,
    })),
  });
  return { reader, queries };
}

test("specific Test Alerts remain correlated when a newer test exists", async () => {
  const { reader } = createReader([
    { id: 501, company_id: 7, event_payload: { result: { status: "completed" } } },
    { id: 502, company_id: 7, event_payload: { result: { status: "failed" } } },
  ]);

  const testA = await reader.getById(7, 501);
  const testB = await reader.getById(7, 502);

  assert.deepEqual(testA, { status: "completed", test_id: 501 });
  assert.deepEqual(testB, { status: "failed", test_id: 502 });
});

test("a Test Alert ID from another company is not visible", async () => {
  const { reader, queries } = createReader([
    { id: 601, company_id: 31, event_payload: { result: { status: "completed" } } },
  ]);

  assert.equal(await reader.getById(32, 601), null);
  assert.deepEqual(queries[0].params, [601, 32]);
  assert.match(queries[0].sql, /company_id = \$2/);
  assert.match(queries[0].sql, /event_type = 'test_alert'/);
});
