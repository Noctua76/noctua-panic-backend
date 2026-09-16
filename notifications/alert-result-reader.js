function createTestAlertResultReader({ pool, hydrateTestAlertRows }) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("Database pool is required");
  }
  if (typeof hydrateTestAlertRows !== "function") {
    throw new Error("Test alert hydrator is required");
  }

  async function getById(companyId, testId) {
    const stored = await pool.query(
      `
      SELECT id, created_at, event_payload
      FROM alert_events
      WHERE id = $1
        AND company_id = $2
        AND event_type = 'test_alert'
      LIMIT 1
      `,
      [testId, companyId]
    );

    const [result = null] = await hydrateTestAlertRows(stored.rows);
    return result;
  }

  return { getById };
}

module.exports = { createTestAlertResultReader };
