const SITE_PREFIX_PATTERN = /^[A-Z0-9]{2,8}$/;

function suggestSitePrefix(name) {
  const words = String(name || "").toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (/^DEFENSOR CIVITATIS SECURITY$/i.test(String(name || "").trim())) return "DEF";
  const initials = words.slice(0, 3).map(word => word[0]).join("");
  const candidate = initials.length >= 2 ? initials : (words[0] || "").slice(0, 3);
  return candidate.length >= 2 ? candidate : "CO";
}

function formatSiteCode(prefix, number) {
  if (!SITE_PREFIX_PATTERN.test(prefix) || !Number.isSafeInteger(number) ||
      number < 1 || number >= 2147483647) {
    throw new Error("Invalid operational site allocation");
  }
  return `${prefix}-${String(number).padStart(3, "0")}`;
}

async function createSiteWithOperationalId({ pool, companyId, name, location, requiredShifts }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const company = await client.query(
      `SELECT site_prefix, next_site_number FROM companies WHERE id = $1 FOR UPDATE`,
      [companyId]
    );
    if (!company.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const number = Number(company.rows[0].next_site_number);
    const code = formatSiteCode(company.rows[0].site_prefix, number);
    const result = await client.query(
      `INSERT INTO sites (company_id, name, location, status, required_shifts,
                           site_number, site_code, created_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, NOW()) RETURNING *`,
      [companyId, name, location, requiredShifts, number, code]
    );
    await client.query(
      `UPDATE companies SET next_site_number = $2 WHERE id = $1`,
      [companyId, number + 1]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { SITE_PREFIX_PATTERN, suggestSitePrefix, formatSiteCode, createSiteWithOperationalId };
