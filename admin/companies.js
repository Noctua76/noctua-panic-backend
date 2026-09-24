const express = require("express");
const { SITE_PREFIX_PATTERN, suggestSitePrefix } = require("../sites/operational-id");

const COMPANY_STATUSES = new Set(["active", "pilot", "inactive"]);
const REQUIRED_COMPANY_COLUMNS = ["id", "name", "status", "timezone", "site_prefix"];

class CompanyOnboardingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "CompanyOnboardingError";
    this.code = code;
    this.status = status;
  }
}

function normalizeOptionalText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function isValidIanaTimezone(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) return false;
  if (/^(?:GMT|UTC)[+-]/i.test(value.trim())) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}

function validateCompanyOnboardingInput(body = {}) {
  const company = body.company || {};
  const administrator = body.administrator || {};
  const name = normalizeOptionalText(company.name);
  const timezone = normalizeOptionalText(company.timezone) || "Europe/Athens";
  const status = normalizeOptionalText(company.status) || "active";
  const sitePrefix = company.site_prefix === undefined
    ? suggestSitePrefix(name)
    : String(company.site_prefix).trim().toUpperCase();
  const fullName = normalizeOptionalText(administrator.full_name);
  const username = normalizeOptionalText(administrator.username);

  if (!name) throw new CompanyOnboardingError("COMPANY_NAME_REQUIRED", "Company name is required");
  if (name.length > 180) throw new CompanyOnboardingError("COMPANY_NAME_INVALID", "Company name is too long");
  if (!isValidIanaTimezone(timezone)) {
    throw new CompanyOnboardingError("COMPANY_TIMEZONE_INVALID", "A valid IANA timezone is required");
  }
  if (!COMPANY_STATUSES.has(status)) {
    throw new CompanyOnboardingError("COMPANY_STATUS_INVALID", "Invalid company status");
  }
  if (!SITE_PREFIX_PATTERN.test(sitePrefix)) {
    throw new CompanyOnboardingError("SITE_PREFIX_INVALID", "Operational Site Prefix must be 2–8 uppercase letters or digits");
  }
  if (!fullName) throw new CompanyOnboardingError("ADMIN_NAME_REQUIRED", "Administrator full name is required");
  if (!username) throw new CompanyOnboardingError("ADMIN_USERNAME_REQUIRED", "Administrator username is required");
  if (fullName.length > 180 || username.length > 120) {
    throw new CompanyOnboardingError("ADMIN_IDENTITY_INVALID", "Administrator name or username is too long");
  }

  return {
    company: { name, timezone, status, site_prefix: sitePrefix },
    administrator: {
      full_name: fullName,
      username,
      email: normalizeOptionalText(administrator.email),
      phone: normalizeOptionalText(administrator.phone),
    },
  };
}

async function inspectCompaniesSchema(queryable) {
  const result = await queryable.query(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'companies'`
  );
  const columns = new Map(result.rows.map((row) => [row.column_name, row]));
  const missing = REQUIRED_COMPANY_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length) {
    throw new CompanyOnboardingError(
      "COMPANIES_SCHEMA_UNAVAILABLE",
      `Companies schema is missing required columns: ${missing.join(", ")}`,
      503
    );
  }
  return { columns, hasCreatedAt: columns.has("created_at") };
}

async function listCompanies(pool) {
  const schema = await inspectCompaniesSchema(pool);
  const createdAtExpression = schema.hasCreatedAt ? "c.created_at" : "NULL::timestamptz";
  const result = await pool.query(
    `SELECT c.id, c.name, c.status, c.timezone, c.site_prefix,
            ${createdAtExpression} AS created_at,
            (SELECT COUNT(*)::int FROM sites s WHERE s.company_id = c.id) AS sites_count,
            (SELECT COUNT(*)::int
               FROM guards g
               JOIN sites gs ON gs.id = g.site_id
              WHERE gs.company_id = c.id
                AND COALESCE(g.access_mode, 'standard') = 'standard') AS guards_count,
            (SELECT COUNT(*)::int
               FROM users u
              WHERE u.company_id = c.id
                AND COALESCE(u.access_mode, 'standard') = 'standard') AS dashboard_users_count
       FROM companies c
      ORDER BY c.name ASC, c.id ASC`
  );
  return result.rows;
}

async function createCompanyWithAdministrator({
  pool,
  actorUserId,
  body,
  hashPassword,
  generateTemporaryPassword,
}) {
  const input = validateCompanyOnboardingInput(body);
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const schema = await inspectCompaniesSchema(client);
    const returningCreatedAt = schema.hasCreatedAt ? ", created_at" : "";

    const companyResult = await client.query(
      `INSERT INTO companies (name, status, timezone, site_prefix)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, status, timezone, site_prefix${returningCreatedAt}`,
      [input.company.name, input.company.status, input.company.timezone, input.company.site_prefix]
    );
    const company = {
      ...companyResult.rows[0],
      created_at: companyResult.rows[0].created_at || null,
    };

    if (company.status === "inactive") {
      await client.query(
        `INSERT INTO company_inactive_intervals
           (company_id, started_at, started_by)
         VALUES ($1, NOW(), $2)`,
        [company.id, actorUserId]
      );
    }

    const roleResult = await client.query(
      `SELECT id, code, name
         FROM dashboard_roles
        WHERE code = 'company_administrator'
          AND scope = 'company'
          AND is_active = TRUE
        LIMIT 1
        FOR SHARE`
    );
    const role = roleResult.rows[0];
    if (!role) {
      throw new CompanyOnboardingError(
        "COMPANY_ADMIN_ROLE_UNAVAILABLE",
        "Company onboarding is unavailable because the Company Administrator role is unavailable",
        503
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword, 10);
    const userResult = await client.query(
      `INSERT INTO users (
         full_name, username, email, phone, role, status, company_id,
         password_hash, must_change_password, access_mode, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, TRUE, 'standard', NOW())
       RETURNING id, full_name, username, email, phone, role, status,
                 company_id, must_change_password, access_mode, created_at`,
      [
        input.administrator.full_name,
        input.administrator.username,
        input.administrator.email,
        input.administrator.phone,
        role.code,
        company.id,
        passwordHash,
      ]
    );
    const administrator = userResult.rows[0];

    await client.query(
      `INSERT INTO user_dashboard_roles (user_id, role_id, assigned_by)
       VALUES ($1, $2, $3)`,
      [administrator.id, role.id, actorUserId]
    );
    await client.query(
      `INSERT INTO dashboard_rbac_audit_events
         (event_type, actor_user_id, target_user_id, role_id, company_id, before_state, after_state)
       VALUES ('USER_ROLE_ASSIGNED', $1, $2, $3, $4, NULL, $5::jsonb)`,
      [
        actorUserId,
        administrator.id,
        role.id,
        company.id,
        JSON.stringify({
          source: "company_onboarding",
          company_name: company.name,
          role_code: role.code,
          must_change_password: true,
          access_mode: "standard",
        }),
      ]
    );

    await client.query("COMMIT");
    return {
      company,
      administrator: { ...administrator, role_id: role.id, role_code: role.code, role_name: role.name },
      credentials: { username: administrator.username, temporary_password: temporaryPassword },
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function changeCompanyStatus({
  pool,
  companyId,
  newStatus,
  actorUserId,
  syncScheduledShiftsForSession,
}) {
  const parsedCompanyId = Number(companyId);
  if (!Number.isInteger(parsedCompanyId) || parsedCompanyId <= 0) {
    throw new CompanyOnboardingError("COMPANY_ID_INVALID", "Invalid company id");
  }
  if (!COMPANY_STATUSES.has(newStatus)) {
    throw new CompanyOnboardingError("COMPANY_STATUS_INVALID", "Invalid company status");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      `SELECT id, name, status, timezone
         FROM companies
        WHERE id = $1
        FOR UPDATE`,
      [parsedCompanyId]
    );
    const company = currentResult.rows[0];
    if (!company) {
      throw new CompanyOnboardingError("COMPANY_NOT_FOUND", "Company not found", 404);
    }

    if (company.status === newStatus) {
      await client.query("COMMIT");
      return {
        company,
        previous_status: company.status,
        new_status: newStatus,
        changed: false,
        shutdown: { dashboard_sessions: 0, guard_sessions: 0, push_subscriptions: 0 },
      };
    }

    const transitionResult = await client.query("SELECT NOW() AS transition_at");
    const transitionAt = transitionResult.rows[0].transition_at;

    const updatedResult = await client.query(
      `UPDATE companies
          SET status = $1
        WHERE id = $2
        RETURNING id, name, status, timezone`,
      [newStatus, parsedCompanyId]
    );
    const shutdown = { dashboard_sessions: 0, guard_sessions: 0, push_subscriptions: 0 };

    if (newStatus === "inactive") {
      await client.query(
        `INSERT INTO company_inactive_intervals
           (company_id, started_at, started_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id) WHERE ended_at IS NULL DO NOTHING`,
        [parsedCompanyId, transitionAt, actorUserId]
      );

      const dashboardSessions = await client.query(
        `UPDATE admin_sessions ads
            SET is_active = FALSE,
                logout_time = COALESCE(ads.logout_time, NOW()),
                session_duration_seconds = COALESCE(
                  ads.session_duration_seconds,
                  GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ads.login_time))::int)
                ),
                session_end_reason = COALESCE(ads.session_end_reason, 'company_inactive')
           FROM users u
          WHERE u.id = ads.user_id
            AND u.company_id = $1
            AND u.role <> 'system_owner'
            AND ads.is_active = TRUE
          RETURNING ads.id`,
        [parsedCompanyId]
      );
      shutdown.dashboard_sessions = dashboardSessions.rowCount;

      const guardSessions = await client.query(
        `UPDATE guard_sessions gs
            SET logout_time = COALESCE(gs.logout_time, NOW() AT TIME ZONE 'Europe/Athens'),
                last_heartbeat = NOW() AT TIME ZONE 'Europe/Athens',
                status = 'company_inactive'
           FROM guards g, sites s
          WHERE g.id = gs.guard_id
            AND s.id = gs.site_id
            AND s.company_id = $1
            AND gs.logout_time IS NULL
          RETURNING gs.id`,
        [parsedCompanyId]
      );
      shutdown.guard_sessions = guardSessions.rowCount;

      if (typeof syncScheduledShiftsForSession !== "function") {
        throw new CompanyOnboardingError(
          "SHIFT_COVERAGE_SYNC_UNAVAILABLE",
          "Company inactivity cannot safely close guard sessions",
          503
        );
      }
      for (const session of guardSessions.rows) {
        await syncScheduledShiftsForSession(session.id, client);
      }

      const pushSubscriptions = await client.query(
        `UPDATE push_subscriptions ps
            SET active = FALSE, last_seen = NOW()
           FROM sites s
          WHERE s.id = ps.site_id
            AND s.company_id = $1
            AND ps.active = TRUE
          RETURNING ps.id`,
        [parsedCompanyId]
      );
      shutdown.push_subscriptions = pushSubscriptions.rowCount;
    } else if (company.status === "inactive") {
      await client.query(
        `UPDATE company_inactive_intervals
            SET ended_at = $2,
                ended_by = $3
          WHERE company_id = $1
            AND ended_at IS NULL`,
        [parsedCompanyId, transitionAt, actorUserId]
      );
    }

    await client.query(
      `INSERT INTO company_status_audit_events
         (company_id, previous_status, new_status, changed_by, changed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [parsedCompanyId, company.status, newStatus, actorUserId, transitionAt]
    );
    await client.query("COMMIT");

    return {
      company: updatedResult.rows[0],
      previous_status: company.status,
      new_status: newStatus,
      changed: true,
      shutdown,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createCompaniesRouter({
  pool,
  hashPassword,
  generateTemporaryPassword,
  syncScheduledShiftsForSession,
}) {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    try {
      return res.json({ status: "ok", companies: await listCompanies(pool) });
    } catch (error) {
      console.error("List companies error:", error);
      return res.status(error.status || 500).json({
        status: "error",
        code: error.code || "COMPANIES_LIST_FAILED",
        message: error.message,
      });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const result = await createCompanyWithAdministrator({
        pool,
        actorUserId: req.auth.user_id,
        body: req.body,
        hashPassword,
        generateTemporaryPassword,
      });
      return res.status(201).json({ status: "ok", ...result });
    } catch (error) {
      console.error("Create company error:", error);
      if (error.code === "23505") {
        if (error.constraint === "companies_site_prefix_unique") {
          return res.status(409).json({ status: "error", code: "SITE_PREFIX_EXISTS", message: "Operational Site Prefix is already assigned to another company" });
        }
        return res.status(409).json({ status: "error", code: "COMPANY_OR_USERNAME_EXISTS", message: "Company name or username already exists" });
      }
      return res.status(error.status || 500).json({
        status: "error",
        code: error.code || "COMPANY_ONBOARDING_FAILED",
        message: error.message,
      });
    }
  });

  router.put("/:id/status", async (req, res) => {
    try {
      const result = await changeCompanyStatus({
        pool,
        companyId: req.params.id,
        newStatus: req.body?.status,
        actorUserId: req.auth.user_id,
        syncScheduledShiftsForSession,
      });
      return res.json({ status: "ok", ...result });
    } catch (error) {
      console.error("Change company status error:", error);
      return res.status(error.status || 500).json({
        status: "error",
        code: error.code || "COMPANY_STATUS_CHANGE_FAILED",
        message: error.message,
      });
    }
  });

  return router;
}

module.exports = {
  COMPANY_STATUSES,
  CompanyOnboardingError,
  changeCompanyStatus,
  createCompaniesRouter,
  createCompanyWithAdministrator,
  inspectCompaniesSchema,
  isValidIanaTimezone,
  listCompanies,
  validateCompanyOnboardingInput,
};
