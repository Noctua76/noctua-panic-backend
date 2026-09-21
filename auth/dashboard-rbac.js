const crypto = require("crypto");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,95}$/;

const LEGACY_GUARD_PERMISSIONS = new Set([
  "dashboard.view", "incidents.view", "incidents.manage",
  "shift_reports.view", "shift_reports.read", "shift_reports.acknowledge",
  "guards.view", "guards.manage", "guards.reset_password",
  "sites.view", "sites.manage", "patrols.view", "patrols.manage",
  "alerts.view", "alerts.manage", "analytics.view", "audit_logs.view",
  "users.view", "users.manage", "users.reset_password",
  "system_status.tenant", "exports.view",
]);

function normalizeCode(value) {
  return String(value || "")
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function routePermission(method, path) {
  const mutation = !SAFE_METHODS.has(method);

  if (path === "/admin/heartbeat" || path === "/admin/logout" || path === "/auth/change-password") return null;
  if (path.startsWith("/admin/temporary-access")) return "temporary_access.manage";
  if (path === "/admin/roles") return mutation ? "roles.manage" : ["users.view", "roles.view"];
  if (path.startsWith("/admin/roles")) return mutation ? "roles.manage" : "roles.view";
  if (path.startsWith("/admin/users")) {
    if (/\/reset-password$/.test(path)) return "users.reset_password";
    return mutation ? "users.manage" : "users.view";
  }
  if (path.startsWith("/admin/patrol-corrections")) return mutation ? "patrols.correct" : "patrols.view";
  if (path.startsWith("/admin/scheduled-shifts")) return "guards.manage";
  if (path.startsWith("/admin/sessions") || path === "/event-logs") return path.includes("export") ? "exports.view" : "audit_logs.view";
  if (path.startsWith("/dashboard/")) return "dashboard.view";
  if (path.startsWith("/analytics")) return "analytics.view";
  if (path === "/system/status/global") return "system_status.global";
  if (path.startsWith("/system/status")) return "system_status.tenant";
  if (path.startsWith("/shift-reports")) {
    if (/\/acknowledge$/.test(path)) return "shift_reports.acknowledge";
    if (/\/read$/.test(path)) return "shift_reports.read";
    if (/\/pdf$/.test(path) || path.includes("/attachments/")) return "exports.view";
    return "shift_reports.view";
  }
  if (path.startsWith("/incidents")) return mutation ? "incidents.manage" : (path.includes("/report") ? "exports.view" : "incidents.view");
  if (path === "/send-sms" || path === "/test-sms" || path.startsWith("/alerts/") || path.startsWith("/settings/alert")) return mutation ? "alerts.manage" : "alerts.view";
  if (path.startsWith("/settings/test-alert")) return "alerts.view";
  if (path.startsWith("/settings/guards") || path.startsWith("/guards")) {
    if (/\/reset-password$/.test(path)) return "guards.reset_password";
    return mutation ? "guards.manage" : "guards.view";
  }
  if (path.startsWith("/settings/sites") && (path.includes("patrol-") || path.includes("patrol_"))) return mutation ? "patrols.manage" : "patrols.view";
  if (path.startsWith("/settings/patrol") || path.startsWith("/patrols") || path.startsWith("/patrol-points")) return mutation ? "patrols.manage" : (path.includes("/pdf") ? "exports.view" : "patrols.view");
  if (path.startsWith("/settings/sites") || path === "/sites") return mutation ? "sites.manage" : "sites.view";
  if (path === "/settings/config") return "dashboard.view";
  if (path === "/admin/active" || path === "/auth/context") return "dashboard.view";
  return mutation ? "__unclassified_mutation__" : "dashboard.view";
}

function createDashboardRbac({ pool }) {
  const permissionCache = new Map();
  const CACHE_TTL_MS = 30_000;

  async function resolveAuthorization(auth) {
    const cached = permissionCache.get(auth.user_id);
    if (cached && cached.userVersion === auth.authorization_version && cached.expiresAt > Date.now()) return cached.value;

    const result = await pool.query(
      `SELECT r.id AS role_id, r.code AS role_code, r.name AS role_name,
              r.scope, r.is_system_role, r.authorization_version AS role_version,
              COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
       FROM user_dashboard_roles ur
       JOIN dashboard_roles r ON r.id = ur.role_id AND r.is_active = TRUE
       LEFT JOIN dashboard_role_permissions rp ON rp.role_id = r.id
       LEFT JOIN dashboard_permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = $1
       GROUP BY r.id`,
      [auth.user_id]
    );

    let value;
    if (result.rows.length) {
      const row = result.rows[0];
      value = {
        role_id: row.role_id,
        role_code: row.role_code,
        role_name: row.role_name,
        role_scope: row.scope,
        is_system_owner: row.role_code === "system_owner",
        permissions: row.permissions,
        legacy_role: null,
      };
    } else {
      const legacy = auth.role === "guard" ? [...LEGACY_GUARD_PERMISSIONS] : [];
      value = {
        role_id: null,
        role_code: auth.role,
        role_name: auth.role === "guard" ? "Legacy Dashboard Role" : auth.role,
        role_scope: auth.role === "system_owner" ? "platform" : "company",
        is_system_owner: auth.role === "system_owner",
        permissions: auth.role === "system_owner" ? ["*"] : legacy,
        legacy_role: auth.role || null,
      };
    }

    permissionCache.set(auth.user_id, { userVersion: auth.authorization_version, expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  function hasPermission(auth, code) {
    return Boolean(auth?.is_system_owner || auth?.permissions?.includes("*") || auth?.permissions?.includes(code));
  }

  function deny(res, code) {
    return res.status(403).json({ status: "error", code: "PERMISSION_DENIED", message: `Permission required: ${code}` });
  }

  function requirePermission(code) {
    return (req, res, next) => hasPermission(req.auth, code) ? next() : deny(res, code);
  }

  function requireAnyPermission(codes) {
    return (req, res, next) => codes.some((code) => hasPermission(req.auth, code)) ? next() : deny(res, codes.join(" or "));
  }

  function requireAllPermissions(codes) {
    return (req, res, next) => codes.every((code) => hasPermission(req.auth, code)) ? next() : deny(res, codes.join(" and "));
  }

  function requireSystemOwner(req, res, next) {
    return req.auth?.is_system_owner
      ? next()
      : res.status(403).json({
        status: "error",
        code: "SYSTEM_OWNER_REQUIRED",
        message: "System Owner access required",
      });
  }

  function enforceRequestPermission(req, res, next) {
    const code = routePermission(req.method, (req.originalUrl || req.path).split("?")[0]);
    if (!code) return next();
    if (Array.isArray(code)) {
      return code.some((item) => hasPermission(req.auth, item))
        ? next()
        : deny(res, code.join(" or "));
    }
    return hasPermission(req.auth, code) ? next() : deny(res, code);
  }

  function invalidateUser(userId) { permissionCache.delete(Number(userId)); }
  function invalidateAll() { permissionCache.clear(); }

  async function revokeAuthorizationSessions(client, userIds) {
    const ids = [...new Set(userIds.map(Number).filter(Number.isInteger))];
    if (!ids.length) return;
    await client.query(`UPDATE users SET authorization_version = authorization_version + 1 WHERE id = ANY($1::int[])`, [ids]);
    await client.query(
      `UPDATE admin_sessions SET is_active = FALSE, logout_time = COALESCE(logout_time, NOW()),
         session_end_reason = COALESCE(session_end_reason, 'authorization_changed')
       WHERE user_id = ANY($1::int[]) AND is_active = TRUE`,
      [ids]
    );
    ids.forEach(invalidateUser);
  }

  function createCustomRoleCode(name) {
    const base = normalizeCode(name).slice(0, 60) || "custom_role";
    return `${base}_${crypto.randomBytes(5).toString("hex")}`;
  }

  return {
    createCustomRoleCode,
    enforceRequestPermission,
    hasPermission,
    invalidateAll,
    invalidateUser,
    requireAllPermissions,
    requireAnyPermission,
    requirePermission,
    requireSystemOwner,
    resolveAuthorization,
    revokeAuthorizationSessions,
  };
}

module.exports = { createDashboardRbac, routePermission, LEGACY_GUARD_PERMISSIONS, ROLE_CODE_PATTERN };
