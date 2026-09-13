const fs = require("fs");
const path = require("path");

const ALLOWED_STATUSES = new Set([
  "operational",
  "degraded",
  "offline",
  "unknown",
  "not_configured",
]);

const SERVICE_SEVERITY = {
  backend_api: "critical",
  database: "critical",
  guard_web_app: "critical",
  incident_flow: "critical",
  sms_gateway: "high",
  voice_calls: "high",
  patrol_scheduler: "high",
  push_notifications: "high",
  email_delivery: "medium",
  dashboard: "medium",
};

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function errorMessage(error) {
  return String(error?.message || error || "Unknown error").slice(0, 1000);
}

function service(name, label, status, extra = {}) {
  return {
    name,
    label,
    status: ALLOWED_STATUSES.has(status) ? status : "unknown",
    severity: SERVICE_SEVERITY[name] || "medium",
    ...extra,
  };
}

function summarize(services) {
  const relevant = services.filter(
    (item) => !item.excluded_from_overall && !["unknown", "not_configured"].includes(item.status)
  );
  const criticalIssue = relevant.some(
    (item) => item.severity === "critical" && item.status === "offline"
  );
  const unhealthy = relevant.some((item) => ["degraded", "offline"].includes(item.status));
  return {
    overall_status: criticalIssue ? "offline" : unhealthy ? "degraded" : "operational",
    critical_issue: criticalIssue,
    counts: services.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {}),
  };
}

function createSystemStatusService({ pool, env = process.env, fetchImpl = fetch, crypto }) {
  const cache = new Map();
  let monitorTimer = null;

  async function initialize() {
    const migration = fs.readFileSync(
      path.join(__dirname, "database", "2026-09-13-system-health-monitoring.sql"),
      "utf8"
    );
    await pool.query(migration);
  }

  async function saveState({ scope, companyId = 0, name, status, error = null, responseTimeMs = null, metadata = {} }) {
    const normalizedStatus = ALLOWED_STATUSES.has(status) ? status : "unknown";
    await pool.query(
      `
      INSERT INTO system_health_state (
        scope, company_id, service, status, last_checked_at,
        last_success_at, last_failure_at, last_error, response_time_ms, metadata, updated_at
      ) VALUES (
        $1, $2, $3, $4, NOW(),
        CASE WHEN $4 = 'operational' THEN NOW() ELSE NULL END,
        CASE WHEN $4 IN ('degraded', 'offline') THEN NOW() ELSE NULL END,
        $5, $6, $7::jsonb, NOW()
      )
      ON CONFLICT (scope, company_id, service) DO UPDATE SET
        status = EXCLUDED.status,
        last_checked_at = EXCLUDED.last_checked_at,
        last_success_at = CASE
          WHEN EXCLUDED.status = 'operational' THEN EXCLUDED.last_checked_at
          ELSE system_health_state.last_success_at
        END,
        last_failure_at = CASE
          WHEN EXCLUDED.status IN ('degraded', 'offline') THEN EXCLUDED.last_checked_at
          ELSE system_health_state.last_failure_at
        END,
        last_error = CASE
          WHEN EXCLUDED.status = 'operational' THEN NULL
          WHEN EXCLUDED.last_error IS NOT NULL THEN EXCLUDED.last_error
          ELSE system_health_state.last_error
        END,
        response_time_ms = EXCLUDED.response_time_ms,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      `,
      [scope, Number(companyId || 0), name, normalizedStatus, error, responseTimeMs, JSON.stringify(metadata)]
    );
  }

  async function stateRows(scope, companyId = 0) {
    const result = await pool.query(
      `SELECT * FROM system_health_state WHERE scope = $1 AND company_id = $2`,
      [scope, Number(companyId || 0)]
    );
    return Object.fromEntries(result.rows.map((row) => [row.service, row]));
  }

  function stateFields(row) {
    if (!row) return {};
    return {
      last_checked_at: iso(row.last_checked_at),
      last_success_at: iso(row.last_success_at),
      last_failure_at: iso(row.last_failure_at),
      last_error: row.last_error || null,
      response_time_ms: row.response_time_ms,
      metadata: row.metadata || {},
    };
  }

  async function timedCheck(name, check, { ttlMs = 30000, configured = true, metadata = {} } = {}) {
    if (!configured) {
      const result = { name, status: "not_configured", configured: false, ...metadata };
      await saveState({ scope: "platform", name, status: result.status, metadata: result });
      return result;
    }
    const cached = cache.get(name);
    if (cached && Date.now() - cached.cachedAt < ttlMs) return cached.value;
    const started = Date.now();
    let value;
    try {
      const detail = (await check()) || {};
      value = {
        name,
        status: detail.status || "operational",
        configured: true,
        response_time_ms: Date.now() - started,
        ...metadata,
        ...detail,
      };
    } catch (error) {
      value = {
        name,
        status: "offline",
        configured: true,
        response_time_ms: Date.now() - started,
        last_error: errorMessage(error),
        ...metadata,
      };
    }
    cache.set(name, { cachedAt: Date.now(), value });
    await saveState({
      scope: "platform",
      name,
      status: value.status,
      error: value.last_error || null,
      responseTimeMs: value.response_time_ms,
      metadata: value,
    });
    return value;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      ...options,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { body: text.slice(0, 300) }; }
  }

  async function checkPlatform() {
    const smsConfigured = Boolean(env.VONAGE_API_KEY && env.VONAGE_API_SECRET && env.VONAGE_SMS_FROM);
    const voiceConfigured = Boolean(env.VONAGE_APPLICATION_ID && env.VONAGE_PRIVATE_KEY && env.VONAGE_FROM_NUMBER);
    const postmarkConfigured = Boolean(env.POSTMARK_SERVER_TOKEN);
    const pushConfigured = Boolean(env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

    const checks = await Promise.all([
      timedCheck("backend_api", async () => ({ status: "operational" })),
      timedCheck("database", async () => {
        const result = await pool.query("SELECT NOW() AS server_time");
        return { status: "operational", server_time: iso(result.rows[0].server_time) };
      }),
      timedCheck("guard_web_app", async () => {
        const data = await fetchJson(env.GUARD_WEBAPP_HEALTH_URL || "https://guard.aegislink.noctuacore.ai/health.json");
        if (data.status && data.status !== "ok") throw new Error(`Health status: ${data.status}`);
        return { status: "operational", version: data.version || data.build || null };
      }),
      timedCheck("dashboard", async () => {
        const data = await fetchJson(env.DASHBOARD_HEALTH_URL || "https://dashboard.aegislink.noctuacore.ai/health.json");
        if (data.status && data.status !== "ok") throw new Error(`Health status: ${data.status}`);
        return { status: "operational", version: data.version || data.build || null };
      }),
      timedCheck("sms_gateway", async () => {
        const query = new URLSearchParams({ api_key: env.VONAGE_API_KEY, api_secret: env.VONAGE_API_SECRET });
        const data = await fetchJson(`https://rest.nexmo.com/account/get-balance?${query.toString()}`);
        if (data.value === undefined) throw new Error("Vonage account response was invalid");
        return { status: "operational", provider: "Vonage", account_reachable: true };
      }, { ttlMs: 180000, configured: smsConfigured }),
      timedCheck("voice_calls", async () => {
        crypto.createPrivateKey((env.VONAGE_PRIVATE_KEY || "").replace(/\\n/g, "\n"));
        const query = new URLSearchParams({ api_key: env.VONAGE_API_KEY || "", api_secret: env.VONAGE_API_SECRET || "" });
        if (env.VONAGE_API_KEY && env.VONAGE_API_SECRET) {
          await fetchJson(`https://rest.nexmo.com/account/get-balance?${query.toString()}`);
        }
        return { status: "operational", provider: "Vonage", private_key_valid: true };
      }, { ttlMs: 180000, configured: voiceConfigured }),
      timedCheck("email_delivery", async () => {
        const data = await fetchJson("https://api.postmarkapp.com/server", {
          headers: { Accept: "application/json", "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN },
        });
        return { status: "operational", provider: "Postmark", server_name: data.Name || null };
      }, { ttlMs: 180000, configured: postmarkConfigured }),
      timedCheck("push_notifications", async () => ({ status: "operational", provider: "Web Push", vapid_configured: true }), {
        configured: pushConfigured,
      }),
    ]);

    const rows = await stateRows("platform", 0);
    return checks.map((item) => service(item.name, {
      backend_api: "Backend API",
      database: "Database",
      guard_web_app: "Guard Web App",
      dashboard: "Dashboard",
      sms_gateway: "Vonage SMS",
      voice_calls: "Vonage Voice",
      email_delivery: "Postmark Email",
      push_notifications: "Web Push",
    }[item.name], item.status, { ...stateFields(rows[item.name]), ...item }));
  }

  async function recordPatrolSchedulerRun({ status, error = null, metadata = {} }) {
    await saveState({
      scope: "platform",
      name: "patrol_scheduler",
      status,
      error: error ? errorMessage(error) : null,
      metadata,
    });
  }

  async function recordTenantPush(companyId, { sentCount, failedCount, error = null }) {
    if (!companyId) return;
    await saveState({
      scope: "tenant",
      companyId,
      name: "push_notifications",
      status: failedCount > 0 ? "degraded" : sentCount > 0 ? "operational" : "unknown",
      error: error ? errorMessage(error) : null,
      metadata: { sent_count: sentCount, failed_count: failedCount },
    });
  }

  async function getTenantServices(companyId) {
    const [sms, voice, email, push, patrol, patrolMissed, incidents, tenantState, platformState] = await Promise.all([
      pool.query(`
        SELECT
          MAX(ae.created_at) FILTER (WHERE COALESCE(ae.sms_sent, 0) > 0) AS last_success,
          MAX(ae.created_at) FILTER (WHERE COALESCE(ae.sms_failed, 0) > 0 OR ae.status = 'failed') AS last_failure,
          (ARRAY_AGG(COALESCE(ae.event_payload->>'error', ae.status) ORDER BY ae.created_at DESC)
            FILTER (WHERE COALESCE(ae.sms_failed, 0) > 0 OR ae.status = 'failed'))[1] AS last_error
        FROM alert_events ae
        JOIN sites s ON s.id = ae.site_id
        WHERE s.company_id = $1
      `, [companyId]),
      pool.query(`
        SELECT
          MAX(ae.created_at) FILTER (WHERE ae.status IN ('submitted','answered','completed')) AS last_success,
          MAX(ae.created_at) FILTER (WHERE ae.status IN ('failed','rejected','busy','unanswered','cancelled','timeout')) AS last_failure,
          (ARRAY_AGG(COALESCE(ae.event_payload->>'error', ae.status) ORDER BY ae.created_at DESC)
            FILTER (WHERE ae.status IN ('failed','rejected','busy','unanswered','cancelled','timeout')))[1] AS last_error
        FROM alert_events ae
        JOIN sites s ON s.id = ae.site_id
        WHERE s.company_id = $1 AND (ae.provider_call_uuid IS NOT NULL OR ae.event_type LIKE 'VOICE%')
      `, [companyId]),
      pool.query(`
        SELECT
          MAX(oe.email_sent_at) FILTER (WHERE oe.email_status = 'sent') AS last_success,
          MAX(oe.updated_at) FILTER (WHERE oe.email_status = 'failed') AS last_failure,
          (ARRAY_AGG(oe.email_error ORDER BY oe.updated_at DESC) FILTER (WHERE oe.email_status = 'failed'))[1] AS last_error
        FROM operational_events oe JOIN sites s ON s.id = oe.site_id WHERE s.company_id = $1
      `, [companyId]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE ps.active = TRUE)::int AS active_subscriptions,
          COUNT(DISTINCT ps.guard_id) FILTER (WHERE ps.active = TRUE)::int AS subscribed_guards,
          MAX(ps.last_seen) FILTER (WHERE ps.active = TRUE) AS last_subscription_seen,
          (SELECT MAX(ppn.sent_at) FROM patrol_push_notifications ppn JOIN sites sx ON sx.id = ppn.site_id WHERE sx.company_id = $1) AS last_success
        FROM push_subscriptions ps JOIN sites s ON s.id = ps.site_id WHERE s.company_id = $1
      `, [companyId]),
      pool.query(`
        SELECT
          COUNT(DISTINCT ps.id) FILTER (WHERE ps.active = TRUE)::int AS active_schedules,
          MAX(pl.patrol_time) AS last_scan,
          MAX(pl.patrol_time) FILTER (WHERE pl.completion_status IN ('completed','completed_late','on_time','late')) AS last_completion
        FROM sites s
        LEFT JOIN patrol_schedules ps ON ps.site_id = s.id
        LEFT JOIN patrol_logs pl ON pl.site_id = s.id
        WHERE s.company_id = $1
      `, [companyId]),
      pool.query(`
        WITH recurring_missed AS (
          SELECT slots.expected_at AS scheduled_at
          FROM patrol_schedules ps
          JOIN sites s ON s.id = ps.site_id
          JOIN companies c ON c.id = s.company_id
          CROSS JOIN LATERAL (
            SELECT ((ps.created_at AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date + ps.start_time) AS anchor_at,
                   (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')) AS local_now
          ) clock
          CROSS JOIN LATERAL generate_series(
            GREATEST(clock.anchor_at, clock.local_now - INTERVAL '30 days'),
            clock.local_now,
            (ps.interval_hours || ' hours')::interval
          ) slots(expected_at)
          WHERE s.company_id = $1
            AND ps.schedule_type = 'recurring' AND ps.active = TRUE
            AND ps.start_time IS NOT NULL AND ps.interval_hours IS NOT NULL
            AND slots.expected_at + INTERVAL '16 minutes' <= clock.local_now
            AND NOT EXISTS (
              SELECT 1 FROM patrol_logs pl
              WHERE pl.schedule_id = ps.id
                AND COALESCE(pl.schedule_type, 'recurring') = 'recurring'
                AND pl.scheduled_at = slots.expected_at
            )
        ),
        manual_missed AS (
          SELECT (ps.scheduled_date + ps.scheduled_time) AS scheduled_at
          FROM patrol_schedules ps
          JOIN sites s ON s.id = ps.site_id
          JOIN companies c ON c.id = s.company_id
          WHERE s.company_id = $1 AND ps.schedule_type = 'manual'
            AND ps.scheduled_date + ps.scheduled_time + INTERVAL '16 minutes'
              <= (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))
            AND NOT EXISTS (
              SELECT 1 FROM patrol_logs pl
              WHERE pl.schedule_id = ps.id
                AND COALESCE(pl.schedule_type, 'manual') = 'manual'
            )
        )
        SELECT MAX(scheduled_at) AS last_missed_at, COUNT(*)::int AS missed_last_30_days
        FROM (
          SELECT scheduled_at FROM recurring_missed
          UNION ALL
          SELECT scheduled_at FROM manual_missed
        ) missed
      `, [companyId]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE i.status IN ('active','in_progress'))::int AS active_incidents,
          MAX(i.created_at) AS last_incident,
          MAX(i.resolved_time) AS last_resolved,
          MAX(ae.created_at) FILTER (WHERE ae.status = 'failed') AS last_failure,
          (ARRAY_AGG(COALESCE(ae.event_payload->>'error', ae.status) ORDER BY ae.created_at DESC)
            FILTER (WHERE ae.status = 'failed'))[1] AS last_error
        FROM incidents i LEFT JOIN alert_events ae ON ae.incident_id = i.id WHERE i.company_id = $1
      `, [companyId]),
      stateRows("tenant", companyId),
      stateRows("platform", 0),
    ]);

    const operationStatus = (row) => {
      if (!row.last_success && !row.last_failure) return "unknown";
      if (row.last_failure && (!row.last_success || new Date(row.last_failure) >= new Date(row.last_success))) return "degraded";
      return "operational";
    };
    const smsRow = sms.rows[0];
    const voiceRow = voice.rows[0];
    const emailRow = email.rows[0];
    const pushRow = push.rows[0];
    const patrolRow = patrol.rows[0];
    const patrolMissedRow = patrolMissed.rows[0];
    const incidentRow = incidents.rows[0];
    const scheduler = platformState.patrol_scheduler;
    const schedulerFresh = scheduler?.last_success_at && Date.now() - new Date(scheduler.last_success_at).getTime() < 180000;
    const pushRecorded = tenantState.push_notifications;

    return [
      service("sms_gateway", "SMS Delivery", operationStatus(smsRow), {
        last_success_at: iso(smsRow.last_success), last_failure_at: iso(smsRow.last_failure), last_error: smsRow.last_error || null,
      }),
      service("voice_calls", "Voice Calls", operationStatus(voiceRow), {
        last_success_at: iso(voiceRow.last_success), last_failure_at: iso(voiceRow.last_failure), last_error: voiceRow.last_error || null,
      }),
      service("email_delivery", "Email Delivery", operationStatus(emailRow), {
        last_success_at: iso(emailRow.last_success), last_failure_at: iso(emailRow.last_failure), last_error: emailRow.last_error || null,
      }),
      service("push_notifications", "Push Notifications", pushRecorded?.status || (pushRow.active_subscriptions > 0 ? "operational" : "unknown"), {
        ...stateFields(pushRecorded), active_subscriptions: pushRow.active_subscriptions, subscribed_guards: pushRow.subscribed_guards,
        last_subscription_seen: iso(pushRow.last_subscription_seen), last_success_at: iso(pushRow.last_success) || iso(pushRecorded?.last_success_at),
      }),
      service("patrol_scheduler", "Patrol Scheduler", schedulerFresh ? "operational" : scheduler ? "degraded" : "unknown", {
        ...stateFields(scheduler), active_schedules: patrolRow.active_schedules, last_scan_at: iso(patrolRow.last_scan),
        last_completion_at: iso(patrolRow.last_completion), last_missed_patrol_at: iso(patrolMissedRow.last_missed_at),
        missed_last_30_days: patrolMissedRow.missed_last_30_days, scheduler_fresh: Boolean(schedulerFresh),
      }),
      service("incident_flow", "Incident Flow", operationStatus(incidentRow), {
        active_incidents: incidentRow.active_incidents, last_incident_at: iso(incidentRow.last_incident),
        last_resolved_at: iso(incidentRow.last_resolved), last_failure_at: iso(incidentRow.last_failure), last_error: incidentRow.last_error || null,
      }),
    ];
  }

  async function tenantOverview(companyId) {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM sites WHERE company_id = $1) AS total_sites,
        (
          SELECT COUNT(*)::int
          FROM guard_sessions gs
          JOIN guards g ON g.id = gs.guard_id
          JOIN sites s ON s.id = gs.site_id
          WHERE s.company_id = $1 AND gs.logout_time IS NULL AND g.access_mode = 'standard'
            AND (gs.scheduled_shift_end IS NULL OR gs.scheduled_shift_end + INTERVAL '15 minutes' > (NOW() AT TIME ZONE COALESCE((SELECT timezone FROM companies WHERE id = $1), 'Europe/Athens')))
            AND gs.last_heartbeat > NOW() - INTERVAL '90 seconds'
        ) AS active_guards
    `, [companyId]);
    return result.rows[0];
  }

  function legacyServices(platform, tenant = [], overview = {}) {
    const platformByName = Object.fromEntries(platform.map((item) => [item.name, item]));
    const tenantByName = Object.fromEntries(tenant.map((item) => [item.name, item]));
    return {
      web_app: platformByName.guard_web_app,
      backend_api: { ...platformByName.backend_api, message: "Backend responding" },
      database: platformByName.database,
      guard_sessions: { label: "Guard Sessions", status: "operational", active_guards: overview.active_guards || 0 },
      sites_api: { label: "Sites", status: "operational", total_sites: overview.total_sites || 0 },
      heartbeat: { label: "Heartbeat", status: "operational" },
      incidents: tenantByName.incident_flow,
      sms_gateway: { ...platformByName.sms_gateway, tenant_operation: tenantByName.sms_gateway },
      voice_calls: { ...platformByName.voice_calls, tenant_operation: tenantByName.voice_calls },
      email_delivery: { ...platformByName.email_delivery, tenant_operation: tenantByName.email_delivery },
      push_notifications: { ...platformByName.push_notifications, tenant_operation: tenantByName.push_notifications },
      patrol_scheduler: tenantByName.patrol_scheduler || platformByName.patrol_scheduler,
      ai_intake: service("ai_intake", "AI Intake", env.OPENAI_API_KEY ? "operational" : "offline", {
        configured: Boolean(env.OPENAI_API_KEY), excluded_from_overall: true,
      }),
    };
  }

  async function getPublicStatus() {
    const platform = await checkPlatform();
    const summary = summarize(platform);
    return {
      ...summary,
      scope: "platform",
      checked_at: new Date().toISOString(),
      platform,
      services: legacyServices(platform),
      ai_intake: { status: env.OPENAI_API_KEY ? "operational" : "offline", excluded_from_overall: true },
    };
  }

  async function getTenantStatus(companyId) {
    const [platform, tenant, overview] = await Promise.all([
      checkPlatform(), getTenantServices(companyId), tenantOverview(companyId),
    ]);
    const summary = summarize([...platform, ...tenant]);
    return {
      ...summary,
      scope: "tenant",
      company_id: Number(companyId),
      checked_at: new Date().toISOString(),
      platform,
      tenant,
      active_guards: overview.active_guards,
      total_sites: overview.total_sites,
      services: legacyServices(platform, tenant, overview),
      ai_intake: { status: env.OPENAI_API_KEY ? "operational" : "offline", excluded_from_overall: true },
    };
  }

  async function getGlobalStatus() {
    const companies = await pool.query(`SELECT id, name, status FROM companies ORDER BY name ASC`);
    const platform = await checkPlatform();
    const tenants = [];
    for (const company of companies.rows) {
      const services = await getTenantServices(company.id);
      tenants.push({
        company_id: company.id,
        company_name: company.name,
        company_status: company.status,
        ...summarize(services),
        services,
      });
    }
    return {
      ...summarize([...platform, ...tenants.flatMap((tenant) => tenant.services)]),
      scope: "global",
      checked_at: new Date().toISOString(),
      platform,
      tenants,
    };
  }

  async function runMonitor() {
    try { await checkPlatform(); } catch (error) { console.error("Platform health monitor error:", error); }
  }

  function startMonitor() {
    if (monitorTimer) return;
    runMonitor();
    monitorTimer = setInterval(runMonitor, 60000);
  }

  return {
    initialize,
    startMonitor,
    getPublicStatus,
    getTenantStatus,
    getGlobalStatus,
    recordPatrolSchedulerRun,
    recordTenantPush,
  };
}

module.exports = { createSystemStatusService, summarize };
