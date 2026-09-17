const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateRandomPatrolsForCurrentLocalDay,
  getAuthorizedSite,
} = require("../patrol/random-patrols");

test("tenant site authorization derives company scope from authenticated context", async () => {
  let captured;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await getAuthorizedSite(pool, { role: "supervisor", company_id: 88 }, 77);
  assert.match(captured.sql, /s\.company_id = \$3/);
  assert.deepEqual(captured.params, [77, false, 88]);
});

test("random generation is idempotent and preserves tenant/site/point scope", async () => {
  const days = new Set();
  const occurrences = [];
  const configuration = {
    configuration_id: 9,
    company_id: 41,
    site_id: 52,
    patrol_point_id: 63,
    patrols_per_day: 3,
    timezone: "Europe/Athens",
    local_date: "2026-09-17",
  };

  const client = {
    async query(sql, params = []) {
      if (/INSERT INTO random_patrol_days/.test(sql)) {
        const key = params.slice(0, 4).join(":");
        if (days.has(key)) return { rows: [] };
        days.add(key);
        return { rows: [{ id: 700 }] };
      }
      if (/INSERT INTO random_patrol_occurrences/.test(sql)) {
        occurrences.push(params);
      }
      return { rows: [] };
    },
    release() {},
  };

  const pool = {
    async query() { return { rows: [configuration] }; },
    async connect() { return client; },
  };

  const first = await generateRandomPatrolsForCurrentLocalDay(pool);
  const second = await generateRandomPatrolsForCurrentLocalDay(pool);

  assert.equal(first.generated_days, 1);
  assert.equal(second.generated_days, 0);
  assert.equal(occurrences.length, 3);
  for (const params of occurrences) {
    assert.equal(params[1], configuration.company_id);
    assert.equal(params[2], configuration.site_id);
    assert.equal(params[3], configuration.patrol_point_id);
  }
});
