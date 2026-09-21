const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED";
const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  "Password change is required before accessing the Dashboard.";

const ALLOWED_RESTRICTED_ROUTES = new Set([
  "POST /auth/change-password",
  "POST /admin/logout",
]);

function normalizeRequestPath(req) {
  return String(req.path || req.originalUrl || req.url || "")
    .split("?")[0];
}

function isRestrictedRouteAllowed(req) {
  const method = String(req.method || "GET").toUpperCase();
  return ALLOWED_RESTRICTED_ROUTES.has(
    `${method} ${normalizeRequestPath(req)}`
  );
}

function enforceDashboardPasswordChange(req, res) {
  if (req.auth?.must_change_password !== true) return false;
  if (isRestrictedRouteAllowed(req)) return false;

  res.status(403).json({
    status: "error",
    code: PASSWORD_CHANGE_REQUIRED_CODE,
    message: PASSWORD_CHANGE_REQUIRED_MESSAGE,
  });
  return true;
}

module.exports = {
  ALLOWED_RESTRICTED_ROUTES,
  PASSWORD_CHANGE_REQUIRED_CODE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
  enforceDashboardPasswordChange,
  isRestrictedRouteAllowed,
};
