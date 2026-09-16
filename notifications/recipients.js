function normalizePhone(value) {
  return String(value || "").trim();
}

function deduplicateRecipients(recipients) {
  const unique = new Map();

  for (const recipient of recipients) {
    const phone = normalizePhone(recipient.phone);
    if (!phone || unique.has(phone)) continue;

    unique.set(phone, {
      ...recipient,
      phone,
      sms_enabled: Boolean(recipient.sms_enabled),
      voice_enabled: Boolean(recipient.voice_enabled),
    });
  }

  return Array.from(unique.values());
}

function createAlertRecipientResolver({ pool }) {
  async function getDatabaseRecipients(companyId) {
    const result = await pool.query(
      `
      SELECT
        id,
        company_id,
        full_name,
        phone,
        sms_enabled,
        voice_enabled,
        active,
        'database'::text AS source
      FROM alert_recipients
      WHERE company_id = $1
        AND active = TRUE
      ORDER BY id ASC
      `,
      [companyId]
    );

    return deduplicateRecipients(result.rows);
  }

  async function getAlertRecipientsForCompany(companyId) {
    if (!companyId) {
      throw new Error("Authenticated company context is required");
    }

    const database = await getDatabaseRecipients(companyId);
    if (database.length > 0) {
      return {
        recipients: database,
        source: "database",
        fallback_used: false,
      };
    }

    return {
      recipients: [],
      source: "none",
      fallback_used: false,
    };
  }

  return {
    getAlertRecipientsForCompany,
    getDatabaseRecipients,
  };
}

module.exports = {
  createAlertRecipientResolver,
  deduplicateRecipients,
  normalizePhone,
};
