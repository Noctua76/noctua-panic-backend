function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function changeDashboardPassword({
  pool,
  bcrypt,
  userId,
  currentPassword,
  newPassword,
  invalidateUser = () => {},
}) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw createHttpError(401, "Invalid authenticated session");
  }
  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    !currentPassword ||
    !newPassword
  ) {
    throw createHttpError(
      400,
      "current_password and new_password are required"
    );
  }
  if (newPassword.length < 8) {
    throw createHttpError(
      400,
      "New password must be at least 8 characters long"
    );
  }
  if (currentPassword === newPassword) {
    throw createHttpError(
      400,
      "New password must be different from the current password"
    );
  }

  const userResult = await pool.query(
    `SELECT id, full_name, username, email, phone, role, status,
            password_hash, must_change_password
     FROM users
     WHERE id = $1 AND status = 'active'`,
    [userId]
  );

  if (!userResult.rows.length) {
    throw createHttpError(401, "Authenticated user not found or inactive");
  }

  const validPassword = await bcrypt.compare(
    currentPassword,
    userResult.rows[0].password_hash
  );
  if (!validPassword) {
    throw createHttpError(401, "Current password is incorrect");
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  const updateResult = await pool.query(
    `UPDATE users
     SET password_hash = $1,
         must_change_password = FALSE,
         updated_at = NOW()
     WHERE id = $2 AND status = 'active'
     RETURNING id, full_name, username, email, phone, role, status,
               must_change_password, updated_at`,
    [newPasswordHash, userId]
  );

  if (!updateResult.rows.length) {
    throw createHttpError(401, "Password change could not be completed");
  }

  invalidateUser(userId);
  return updateResult.rows[0];
}

module.exports = { changeDashboardPassword };
