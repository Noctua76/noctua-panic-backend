const crypto = require("crypto");

const DEFAULT_TEMP_PASSWORD_TTL_HOURS = 168;
const PASSWORD_SETUP_TOKEN_TTL_MINUTES = 15;

function getTempPasswordTtlHours(value = process.env.GUARD_TEMP_PASSWORD_TTL_HOURS) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TEMP_PASSWORD_TTL_HOURS;
}

function validateGuardPassword(password) {
  const errors = [];
  if (typeof password !== "string" || password.length < 12) {
    errors.push("at least 12 characters");
  }
  if (!/[a-z]/.test(password || "")) errors.push("a lowercase letter");
  if (!/[A-Z]/.test(password || "")) errors.push("an uppercase letter");
  if (!/[0-9]/.test(password || "")) errors.push("a number");
  if (!/[^A-Za-z0-9]/.test(password || "")) errors.push("a symbol");

  return {
    valid: errors.length === 0,
    errors,
    message: errors.length
      ? `Password must contain ${errors.join(", ")}.`
      : "",
  };
}

function generateTemporaryPassword() {
  const required = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%*-_+"];
  const all = required.join("");
  const chars = required.map((group) => group[crypto.randomInt(group.length)]);
  while (chars.length < 16) chars.push(all[crypto.randomInt(all.length)]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
  }
  return chars.join("");
}

function createPasswordSetupToken(guardId) {
  const secret = crypto.randomBytes(32).toString("base64url");
  return {
    token: `${guardId}.${secret}`,
    hash: hashPasswordSetupToken(secret),
  };
}

function parsePasswordSetupToken(token) {
  if (typeof token !== "string") return null;
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const guardId = Number(token.slice(0, separator));
  const secret = token.slice(separator + 1);
  if (!Number.isInteger(guardId) || guardId <= 0 || secret.length < 32) return null;
  return { guardId, secret };
}

function hashPasswordSetupToken(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function setupTokenMatches(secret, storedHash) {
  if (typeof storedHash !== "string" || !/^[a-f0-9]{64}$/i.test(storedHash)) return false;
  const actual = Buffer.from(hashPasswordSetupToken(secret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function evaluatePasswordChangeCredential(guard, secret, now = Date.now()) {
  if (!guard || guard.active !== true || guard.access_mode !== "standard" ||
      guard.must_change_password !== true) {
    return { valid: false, code: "PASSWORD_SETUP_TOKEN_EXPIRED" };
  }

  const temporaryPasswordExpiresAt = new Date(guard.temporary_password_expires_at).getTime();
  if (!Number.isFinite(temporaryPasswordExpiresAt) || temporaryPasswordExpiresAt <= now) {
    return { valid: false, code: "TEMP_PASSWORD_EXPIRED" };
  }

  const setupTokenExpiresAt = new Date(guard.password_setup_token_expires_at).getTime();
  if (!Number.isFinite(setupTokenExpiresAt) || setupTokenExpiresAt <= now ||
      !setupTokenMatches(secret, guard.password_setup_token_hash)) {
    return { valid: false, code: "PASSWORD_SETUP_TOKEN_EXPIRED" };
  }

  return { valid: true, code: null };
}

async function commitGuardPasswordReset({
  client,
  closedSessionIds,
  syncScheduledShiftsForSession,
}) {
  for (const sessionId of closedSessionIds) {
    await syncScheduledShiftsForSession(sessionId, client);
  }
  await client.query("COMMIT");
}

module.exports = {
  DEFAULT_TEMP_PASSWORD_TTL_HOURS,
  PASSWORD_SETUP_TOKEN_TTL_MINUTES,
  createPasswordSetupToken,
  commitGuardPasswordReset,
  evaluatePasswordChangeCredential,
  generateTemporaryPassword,
  getTempPasswordTtlHours,
  parsePasswordSetupToken,
  setupTokenMatches,
  validateGuardPassword,
};
