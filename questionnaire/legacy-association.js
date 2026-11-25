'use strict';
// Accepted fail-closed legacy temporal proof, copied without timezone reinterpretation.
module.exports = { LEGACY_ASSOCIATION_SQL: `
          SELECT i.id, i.status
          FROM incidents i
          JOIN sites s ON s.id = i.site_id
          JOIN companies c ON c.id = s.company_id
          JOIN guard_sessions gs ON gs.id = $4
            AND gs.guard_id = i.guard_ref AND gs.site_id = i.site_id
          WHERE i.questionnaire_binding IS NULL AND i.id = $1 AND i.guard_ref = $2 AND i.site_id = $3
            AND i.company_id = $5 AND s.company_id = $5
            AND gs.logout_time IS NULL
            AND (i.trigger_time AT TIME ZONE current_setting('TimeZone')) >=
              (gs.login_time AT TIME ZONE 'Europe/Athens')
            -- The incident's implicit timestamptz-to-timestamp cast must also have a unique instant.
            AND ((i.trigger_time AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE current_setting('TimeZone')) = i.trigger_time
            AND NOT EXISTS (
              SELECT 1 FROM generate_series(-1, 1) AS h(delta)
              WHERE h.delta <> 0 AND
                (((i.trigger_time AT TIME ZONE current_setting('TimeZone')) + h.delta * INTERVAL '1 hour')
                  AT TIME ZONE current_setting('TimeZone')) = i.trigger_time
            )
            -- A missing/ambiguous local login instant cannot prove session ownership.
            AND ((gs.login_time AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'Europe/Athens') = gs.login_time
            AND NOT EXISTS (
              SELECT 1 FROM generate_series(-1, 1) AS h(delta)
              WHERE h.delta <> 0 AND
                (((gs.login_time AT TIME ZONE 'Europe/Athens') + h.delta * INTERVAL '1 hour')
                  AT TIME ZONE 'Europe/Athens') = gs.login_time
            )
            -- Reject every other session that could have owned this incident instant.
            -- Auto-close/temporary expiry use NOW() in DB session time; explicit logout and shift/password/company close use Athens time.
            AND NOT EXISTS (
              SELECT 1 FROM guard_sessions other
              CROSS JOIN generate_series(-1, 1) AS h(delta)
              WHERE other.guard_id = gs.guard_id AND other.id <> gs.id
                AND (((other.login_time AT TIME ZONE 'Europe/Athens') + h.delta * INTERVAL '1 hour')
                  AT TIME ZONE 'Europe/Athens') = other.login_time
                AND (other.login_time AT TIME ZONE 'Europe/Athens') + h.delta * INTERVAL '1 hour'
                  <= (i.trigger_time AT TIME ZONE current_setting('TimeZone'))
                AND (other.logout_time IS NULL OR
                  CASE
                    WHEN other.status IN ('auto_closed', 'temporary_access_expired', 'temporary_access_revoked')
                      THEN other.logout_time AT TIME ZONE current_setting('TimeZone')
                    WHEN other.status IN ('logged_out', 'shift_boundary_timeout', 'password_reset', 'company_inactive')
                      THEN other.logout_time AT TIME ZONE 'Europe/Athens'
                    ELSE GREATEST(other.logout_time AT TIME ZONE current_setting('TimeZone'), other.logout_time AT TIME ZONE 'Europe/Athens')
                  END >= (i.trigger_time AT TIME ZONE current_setting('TimeZone')))
            )
          FOR UPDATE OF i
` };
