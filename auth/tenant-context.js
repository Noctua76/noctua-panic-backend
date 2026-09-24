const crypto = require("node:crypto");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_ONLY_CONTROL_PATHS = new Set([
  "/admin/heartbeat", "/admin/logout",
  "/admin/tenant-context/enter", "/admin/tenant-context/elevate",
  "/admin/tenant-context/exit",
]);

function resolveTenantContext(auth) {
  const active = auth.role === "system_owner" && Boolean(auth.tenant_context_company_id);
  // A deleted or invalid context must fail closed; it must not become home access.
  if (active && !auth.tenant_context_company_name) {
    const error = new Error("Tenant context company is unavailable");
    error.status = 403;
    throw error;
  }
  const until = auth.tenant_context_elevated_until;
  const canMutate = active && auth.tenant_context_mode === "administrative" &&
    Boolean(until) && new Date(until).getTime() > Date.now() &&
    ["active", "pilot"].includes(auth.tenant_context_company_status);
  return {
    actor_company_id: auth.company_id,
    actor_company_name: auth.company_name,
    tenant_context_active: active,
    tenant_context_company_id: active ? auth.tenant_context_company_id : null,
    tenant_context_company_name: active ? auth.tenant_context_company_name : null,
    tenant_context_company_status: active ? auth.tenant_context_company_status : null,
    tenant_context_mode: active ? (canMutate ? "administrative" : "read_only") : null,
    tenant_context_started_at: active ? auth.tenant_context_started_at : null,
    tenant_context_elevated_until: canMutate ? until : null,
    tenant_context_can_mutate: canMutate,
    effective_company_id: active ? auth.tenant_context_company_id : auth.company_id,
    effective_company_name: active ? auth.tenant_context_company_name : auth.company_name,
  };
}

function canMutateTenantRequest(auth, method, path) {
  if (!auth.tenant_context_active || auth.tenant_context_can_mutate) return true;
  return SAFE_METHODS.has(method) || READ_ONLY_CONTROL_PATHS.has(path);
}

async function recordTenantAudit(queryable, auth, eventType, targetCompanyId, method, path, status, mode = null, reason = null, requestId = null) {
  await queryable.query(
    `INSERT INTO system_owner_tenant_access_audit
       (session_id, actor_user_id, actor_username, actor_home_company_id,
        target_company_id, event_type, mode, reason, request_method, request_path, response_status, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [auth.session_id, auth.user_id, auth.username, auth.actor_company_id,
      targetCompanyId, eventType, mode ?? auth.tenant_context_mode,
      reason ?? auth.tenant_context_reason, method, path, status, requestId]
  );
}

async function enforceTenantContextBoundary(req, res, pool, requestPath) {
  const auth = req.auth;
  if (!auth.tenant_context_active) return false;

  if (requestPath.startsWith("/admin/companies") ||
      requestPath.startsWith("/admin/roles") ||
      requestPath.startsWith("/admin/temporary-access") ||
      requestPath === "/system/status/global" ||
      requestPath === "/send-sms" || requestPath === "/test-sms") {
    res.status(403).json({ status: "error", code: "PLATFORM_CONTROL_UNAVAILABLE_IN_TENANT" });
    return true;
  }
  if (!auth.tenant_context_can_mutate &&
      /^\/patrol-points\/[^/]+\/qr\/?$/.test(requestPath)) {
    res.status(403).json({ status: "error", code: "TENANT_CONTEXT_READ_ONLY" });
    return true;
  }
  if (!canMutateTenantRequest(auth, req.method, requestPath)) {
    res.status(403).json({ status: "error", code: "TENANT_CONTEXT_READ_ONLY" });
    return true;
  }

  if (auth.tenant_context_can_mutate && MUTATION_METHODS.has(req.method) &&
      !requestPath.startsWith("/admin/tenant-context/") &&
      requestPath !== "/admin/heartbeat" && requestPath !== "/admin/logout") {
    const requestId = crypto.randomUUID();
    // Await a committed insert before any operational route can run.
    try {
      await recordTenantAudit(pool, auth, "TENANT_MUTATION_ATTEMPT", auth.effective_company_id,
        req.method, requestPath, null, "administrative", auth.tenant_context_reason, requestId);
    } catch (error) {
      console.error("CRITICAL Tenant mutation attempt audit unavailable", requestId, error);
      res.status(503).json({ status: "error", code: "TENANT_AUDIT_UNAVAILABLE" });
      return true;
    }

    // Capture the actor and context now; the response may finish after other middleware runs.
    const auditAuth = { ...auth };
    res.once("finish", () => {
      recordTenantAudit(pool, auditAuth, "TENANT_MUTATION_RESULT", auditAuth.effective_company_id,
        req.method, requestPath, res.statusCode, "administrative", auditAuth.tenant_context_reason, requestId)
        .catch(error => console.error("CRITICAL Tenant mutation result audit failed", requestId, error));
    });
  }
  return false;
}

function createTenantContextRouter({ pool, requireAuth }) {
  const express = require("express");
  const router = express.Router();
  router.use("/admin/tenant-context", requireAuth, (req, res, next) =>
    req.auth.is_system_owner ? next() : res.status(403).json({ status: "error", code: "SYSTEM_OWNER_REQUIRED" }));

  router.post("/admin/tenant-context/enter", async (req, res) => {
    if (req.auth.tenant_context_active) {
      return res.status(409).json({ status: "error", code: "EXIT_TENANT_CONTEXT_FIRST" });
    }
    const companyId = Number(req.body?.company_id);
    if (!Number.isSafeInteger(companyId) || companyId <= 0 || req.body?.company_id === null) {
      return res.status(400).json({ status: "error", code: "INVALID_COMPANY_ID" });
    }
    if (companyId === Number(req.auth.actor_company_id)) {
      return res.status(400).json({ status: "error", code: "HOME_COMPANY_CONTEXT" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT id FROM companies WHERE id=$1 FOR SHARE", [companyId]);
      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ status: "error", code: "COMPANY_NOT_FOUND" });
      }
      const updated = await client.query(
        `UPDATE admin_sessions SET tenant_context_company_id=$1,
         tenant_context_mode='read_only', tenant_context_started_at=NOW(),
         tenant_context_elevated_at=NULL, tenant_context_elevated_until=NULL,
         tenant_context_reason=NULL
         WHERE id=$2 AND user_id=$3 AND is_active=TRUE
         RETURNING id`,
        [companyId, req.auth.session_id, req.auth.user_id]
      );
      if (!updated.rows.length) {
        await client.query("ROLLBACK");
        return res.status(401).json({ status: "error", code: "AUTH_SESSION_INVALID" });
      }
      await recordTenantAudit(client, req.auth, "TENANT_CONTEXT_ENTERED", companyId,
        req.method, req.path, 200, "read_only", null);
      await client.query("COMMIT");
      return res.json({ status: "ok" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return res.status(500).json({ status: "error", message: "Could not enter tenant" });
    } finally { client.release(); }
  });

  router.post("/admin/tenant-context/elevate", async (req, res) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason || reason.length > 1000) return res.status(400).json({ status: "error", code: "REASON_REQUIRED" });
    if (!req.auth.tenant_context_active) return res.status(409).json({ status: "error", code: "TENANT_CONTEXT_REQUIRED" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE admin_sessions ads SET tenant_context_mode='administrative',
           tenant_context_elevated_at=NOW(), tenant_context_elevated_until=NOW()+INTERVAL '30 minutes',
           tenant_context_reason=$3
         FROM companies c WHERE ads.id=$1 AND ads.user_id=$2 AND ads.is_active=TRUE
           AND c.id=ads.tenant_context_company_id AND c.status IN ('active','pilot')
         RETURNING ads.tenant_context_company_id`,
        [req.auth.session_id, req.auth.user_id, reason]
      );
      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ status: "error", code: "COMPANY_INACTIVE" });
      }
      await recordTenantAudit(client, req.auth, "TENANT_ADMIN_ACCESS_ENABLED",
        result.rows[0].tenant_context_company_id, req.method, req.path, 200, "administrative", reason);
      await client.query("COMMIT");
      return res.json({ status: "ok" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return res.status(500).json({ status: "error", message: "Could not enable access" });
    } finally { client.release(); }
  });

  router.post("/admin/tenant-context/exit", async (req, res) => {
    if (!req.auth.tenant_context_active) return res.json({ status: "ok" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE admin_sessions SET tenant_context_company_id=NULL, tenant_context_mode=NULL,
           tenant_context_started_at=NULL, tenant_context_elevated_at=NULL,
           tenant_context_elevated_until=NULL, tenant_context_reason=NULL
         WHERE id=$1 AND user_id=$2 AND is_active=TRUE
         RETURNING id`,
        [req.auth.session_id, req.auth.user_id]
      );
      if (!updated.rows.length) {
        await client.query("ROLLBACK");
        return res.status(401).json({ status: "error", code: "AUTH_SESSION_INVALID" });
      }
      await recordTenantAudit(client, req.auth, "TENANT_CONTEXT_EXITED",
        req.auth.tenant_context_company_id, req.method, req.path, 200);
      await client.query("COMMIT");
      return res.json({ status: "ok" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return res.status(500).json({ status: "error", message: "Could not exit tenant" });
    } finally { client.release(); }
  });
  return router;
}

module.exports = { resolveTenantContext, canMutateTenantRequest, recordTenantAudit, enforceTenantContextBoundary, createTenantContextRouter };
