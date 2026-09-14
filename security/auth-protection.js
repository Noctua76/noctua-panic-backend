const ACCOUNT_WINDOW_MINUTES = 10;
const IP_WINDOW_MINUTES = 10;

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().slice(0, 160);
}

function normalizeIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 64);
}

function accountAction(failedAttempts) {
  if (failedAttempts >= 8) return { seconds: 1800, action: "cooldown_30m", securityEvent: true };
  if (failedAttempts >= 6) return { seconds: 300, action: "cooldown_5m", securityEvent: false };
  if (failedAttempts >= 4) return { seconds: 45, action: "delay_45s", securityEvent: false };
  return null;
}

function ipAction(failedAttempts, distinctUsernames) {
  if (failedAttempts >= 10 && distinctUsernames >= 5) {
    return { seconds: 1800, action: "cooldown_30m", securityEvent: true };
  }
  if (failedAttempts >= 8 && distinctUsernames >= 4) {
    return { seconds: 300, action: "cooldown_5m", securityEvent: false };
  }
  if (failedAttempts >= 6 && distinctUsernames >= 3) {
    return { seconds: 45, action: "delay_45s", securityEvent: false };
  }
  return null;
}

function createAuthProtection({ pool }) {
  async function getThrottle(req, surface, username) {
    const usernameNormalized = normalizeUsername(username);
    const sourceIp = normalizeIp(req);
    const accountKey = `${surface}:${usernameNormalized}`;

    const result = await pool.query(
      `
      SELECT scope_type, blocked_until, action,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (blocked_until - NOW()))))::int
          AS retry_after_seconds
      FROM auth_throttle_state
      WHERE blocked_until > NOW()
        AND (
          (scope_type = 'account' AND scope_key = $1)
          OR (scope_type = 'ip' AND scope_key = $2)
        )
      ORDER BY blocked_until DESC
      LIMIT 1
      `,
      [accountKey, sourceIp]
    );

    return result.rows[0] || null;
  }

  async function upsertThrottle(queryable, scopeType, scopeKey, action) {
    await queryable.query(
      `
      INSERT INTO auth_throttle_state (
        scope_type, scope_key, blocked_until, action, updated_at
      )
      VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 second'), $4, NOW())
      ON CONFLICT (scope_type, scope_key)
      DO UPDATE SET
        blocked_until = GREATEST(
          auth_throttle_state.blocked_until,
          EXCLUDED.blocked_until
        ),
        action = EXCLUDED.action,
        updated_at = NOW()
      `,
      [scopeType, scopeKey, action.seconds, action.action]
    );
  }

  async function recordFailure(req, surface, username, accountId = null) {
    const usernameNormalized = normalizeUsername(username);
    const sourceIp = normalizeIp(req);
    const accountKey = `${surface}:${usernameNormalized}`;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const lockKeys = [`auth-account:${accountKey}`, `auth-ip:${sourceIp}`].sort();
      for (const lockKey of lockKeys) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
      }

      await client.query(
      `
      INSERT INTO auth_login_attempts (
        surface, username_normalized, account_id, source_ip, succeeded
      )
      VALUES ($1, $2, $3, $4, false)
      `,
      [surface, usernameNormalized, accountId, sourceIp]
    );

      const accountResult = await client.query(
        `
        SELECT COUNT(*)::int AS failed_attempts
        FROM auth_login_attempts attempts
        WHERE attempts.surface = $1
          AND attempts.username_normalized = $2
          AND attempts.succeeded = false
          AND attempts.attempted_at >= NOW() - ($3::int * INTERVAL '1 minute')
          AND attempts.attempted_at > COALESCE(
            (
              SELECT MAX(success.attempted_at)
              FROM auth_login_attempts success
              WHERE success.surface = $1
                AND success.username_normalized = $2
                AND success.succeeded = true
            ),
            '-infinity'::timestamptz
          )
        `,
        [surface, usernameNormalized, ACCOUNT_WINDOW_MINUTES]
      );
      const ipResult = await client.query(
        `
        SELECT
          COUNT(*)::int AS failed_attempts,
          COUNT(DISTINCT username_normalized)::int AS distinct_usernames
        FROM auth_login_attempts
        WHERE source_ip = $1
          AND succeeded = false
          AND attempted_at >= NOW() - ($2::int * INTERVAL '1 minute')
        `,
        [sourceIp, IP_WINDOW_MINUTES]
      );

    const failedAttempts = Number(accountResult.rows[0]?.failed_attempts || 0);
    const ipFailedAttempts = Number(ipResult.rows[0]?.failed_attempts || 0);
    const distinctUsernames = Number(ipResult.rows[0]?.distinct_usernames || 0);
    const accountThrottle = accountAction(failedAttempts);
    const ipThrottle = ipAction(ipFailedAttempts, distinctUsernames);

    if (accountThrottle) {
      await upsertThrottle(
        client,
        "account",
        accountKey,
        accountThrottle
      );
    }

    if (ipThrottle) {
      await upsertThrottle(client, "ip", sourceIp, ipThrottle);
    }

    const securityEvents = [];

    if (accountThrottle?.securityEvent) {
      securityEvents.push({
        eventType: "AUTH_ACCOUNT_BRUTE_FORCE",
        failedAttemptCount: failedAttempts,
        distinctUsernameCount: null,
        action: accountThrottle.action,
      });
    }

    if (ipThrottle?.securityEvent) {
      securityEvents.push({
        eventType: "AUTH_MULTI_ACCOUNT_IP_ATTACK",
        failedAttemptCount: ipFailedAttempts,
        distinctUsernameCount: distinctUsernames,
        action: ipThrottle.action,
      });
    }

    for (const event of securityEvents) {
      await client.query(
        `
        INSERT INTO security_events (
          event_type,
          surface,
          username_normalized,
          account_id,
          source_ip,
          failed_attempt_count,
          distinct_username_count,
          action,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        `,
        [
          event.eventType,
          surface,
          usernameNormalized || null,
          accountId,
          sourceIp,
          event.failedAttemptCount,
          event.distinctUsernameCount,
          event.action,
          JSON.stringify({ window_minutes: 10 }),
        ]
      );
    }

    const strongest = [accountThrottle, ipThrottle]
      .filter(Boolean)
      .sort((a, b) => b.seconds - a.seconds)[0] || null;

      await client.query("COMMIT");

      return {
        throttled: Boolean(strongest),
        retryAfterSeconds: strongest?.seconds || 0,
        action: strongest?.action || null,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordSuccess(req, surface, username, accountId) {
    const usernameNormalized = normalizeUsername(username);
    const sourceIp = normalizeIp(req);

    await pool.query(
      `
      INSERT INTO auth_login_attempts (
        surface, username_normalized, account_id, source_ip, succeeded
      )
      VALUES ($1, $2, $3, $4, true)
      `,
      [surface, usernameNormalized, accountId, sourceIp]
    );

    await pool.query(
      `
      DELETE FROM auth_throttle_state
      WHERE scope_type = 'account'
        AND scope_key = $1
      `,
      [`${surface}:${usernameNormalized}`]
    );
  }

  return { getThrottle, recordFailure, recordSuccess };
}

module.exports = {
  accountAction,
  createAuthProtection,
  ipAction,
  normalizeIp,
  normalizeUsername,
};
