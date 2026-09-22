const express = require("express");
const puppeteer = require("puppeteer");
const {
  generateRandomMinuteOffsets,
  generatePartialDayMinuteOffsets,
} = require("./lifecycle");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resolveConfigurationActivation({ enabled, previousEnabled, today, tomorrow }) {
  const isActivation = enabled && previousEnabled !== true;
  return {
    isActivation,
    effectiveFromDate: isActivation || !enabled ? today : tomorrow,
  };
}

async function createRandomPatrolDay(client, configuration, minuteOffsets, generationType) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [`random-patrol:${configuration.company_id}:${configuration.site_id}:${configuration.patrol_point_id}:${configuration.local_date}`]
  );
  const day = await client.query(
    `
    INSERT INTO random_patrol_days (
      company_id, site_id, patrol_point_id, local_date,
      timezone, configured_count, generation_type, generated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (company_id, site_id, patrol_point_id, local_date)
    DO NOTHING
    RETURNING id
    `,
    [
      configuration.company_id,
      configuration.site_id,
      configuration.patrol_point_id,
      configuration.local_date,
      configuration.timezone,
      configuration.patrols_per_day,
      generationType,
    ]
  );
  if (day.rows.length === 0) {
    return { created: false, generatedCount: 0 };
  }

  for (let index = 0; index < minuteOffsets.length; index += 1) {
    await client.query(
      `
      INSERT INTO random_patrol_occurrences (
        random_patrol_day_id, company_id, site_id, patrol_point_id,
        sequence_number, scheduled_at, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6::date + ($7::int * INTERVAL '1 minute'),
        NOW()
      )
      `,
      [
        day.rows[0].id,
        configuration.company_id,
        configuration.site_id,
        configuration.patrol_point_id,
        index + 1,
        configuration.local_date,
        minuteOffsets[index],
      ]
    );
  }
  return { created: true, generatedCount: minuteOffsets.length, dayId: day.rows[0].id };
}

async function generateRandomPatrolsForCurrentLocalDay(pool) {
  const due = await pool.query(`
    SELECT
      rpc.id AS configuration_id,
      rpc.company_id,
      rpc.site_id,
      rpc.patrol_point_id,
      rpc.patrols_per_day,
      COALESCE(c.timezone, 'Europe/Athens') AS timezone,
      (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date AS local_date,
      CASE
        WHEN resumed.changed_at IS NOT NULL
         AND (resumed.changed_at AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
             = (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
        THEN (
          EXTRACT(HOUR FROM (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')))::int * 60
          + EXTRACT(MINUTE FROM (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')))::int
        )::int
        ELSE NULL
      END AS reactivation_current_minute,
      EXTRACT(SECOND FROM (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')))::int AS current_second
    FROM random_patrol_configurations rpc
    INNER JOIN companies c ON c.id = rpc.company_id
    LEFT JOIN LATERAL (
      SELECT csa.changed_at
      FROM company_status_audit_events csa
      WHERE csa.company_id = c.id
        AND csa.previous_status = 'inactive'
        AND csa.new_status IN ('active', 'pilot')
      ORDER BY csa.changed_at DESC
      LIMIT 1
    ) resumed ON TRUE
    INNER JOIN sites s
      ON s.id = rpc.site_id
      AND s.company_id = rpc.company_id
    INNER JOIN patrol_points pp
      ON pp.id = rpc.patrol_point_id
      AND pp.site_id = rpc.site_id
      AND pp.active = TRUE
    WHERE rpc.enabled = TRUE
      AND c.status IN ('active', 'pilot')
      AND rpc.effective_from_date <=
        (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
      AND (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::time
        >= TIME '00:01'
  `);

  let generatedDays = 0;
  for (const configuration of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const isSameDayReactivation =
        configuration.reactivation_current_minute !== null &&
        configuration.reactivation_current_minute !== undefined;
      const minuteOffsets = isSameDayReactivation
        ? generatePartialDayMinuteOffsets({
          currentMinute: Number(configuration.reactivation_current_minute),
          currentSecond: Number(configuration.current_second),
          maxCount: configuration.patrols_per_day,
        })
        : generateRandomMinuteOffsets(configuration.patrols_per_day);
      const generated = await createRandomPatrolDay(
        client,
        configuration,
        minuteOffsets,
        isSameDayReactivation ? "partial_reactivation" : "full_day"
      );
      await client.query("COMMIT");
      if (generated.created) generatedDays += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return { configurations_checked: due.rows.length, generated_days: generatedDays };
}

async function getAuthorizedSite(pool, auth, siteId) {
  const isSystemOwner = auth.is_system_owner === true || auth.role === "system_owner";
  const result = await pool.query(
    `
    SELECT s.id, s.company_id, s.name, COALESCE(c.timezone, 'Europe/Athens') AS timezone,
           c.name AS company_name
    FROM sites s
    INNER JOIN companies c ON c.id = s.company_id
    WHERE s.id = $1 AND ($2::boolean = TRUE OR s.company_id = $3)
    `,
    [siteId, isSystemOwner, auth.company_id]
  );
  return result.rows[0] || null;
}

function createRandomPatrolRouter({ pool, requireAuth, requirePermission, requireAllPermissions }) {
  const router = express.Router();

  async function loadSchedule(req, siteId, localDate) {
    const site = await getAuthorizedSite(pool, req.auth, siteId);
    if (!site) return null;
    const daysResult = await pool.query(
      `
      SELECT
        rpd.id AS day_id,
        rpd.local_date,
        rpd.generated_at,
        rpd.configured_count,
        rpd.generation_type,
        rpd.timezone,
        rpd.patrol_point_id,
        pp.point_name,
        COUNT(rpo.id)::int AS generated_count
      FROM random_patrol_days rpd
      INNER JOIN patrol_points pp
        ON pp.id = rpd.patrol_point_id AND pp.site_id = rpd.site_id
      LEFT JOIN random_patrol_occurrences rpo
        ON rpo.random_patrol_day_id = rpd.id
      WHERE rpd.company_id = $1
        AND rpd.site_id = $2
        AND rpd.local_date = $3::date
      GROUP BY rpd.id, pp.point_name
      ORDER BY pp.point_name ASC, rpd.patrol_point_id ASC
      `,
      [site.company_id, siteId, localDate]
    );
    const result = await pool.query(
      `
      SELECT
        rpd.id AS day_id,
        rpo.id AS occurrence_id,
        rpd.local_date,
        rpo.patrol_point_id,
        pp.point_name,
        rpo.sequence_number,
        to_char(rpo.scheduled_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS scheduled_at,
        pl.patrol_time AS completed_at,
        pl.delay_minutes,
        pl.completion_status,
        g.full_name AS guard_name,
        CASE
          WHEN pl.id IS NOT NULL THEN COALESCE(pl.completion_status, 'completed')
          WHEN (NOW() AT TIME ZONE rpd.timezone) >= rpo.scheduled_at + INTERVAL '2 hours' THEN 'missed'
          WHEN (NOW() AT TIME ZONE rpd.timezone) >= rpo.scheduled_at - INTERVAL '5 minutes' THEN 'active'
          ELSE 'scheduled'
        END AS status
      FROM random_patrol_days rpd
      INNER JOIN random_patrol_occurrences rpo
        ON rpo.random_patrol_day_id = rpd.id
      INNER JOIN patrol_points pp
        ON pp.id = rpo.patrol_point_id AND pp.site_id = rpo.site_id
      LEFT JOIN patrol_logs pl ON pl.random_occurrence_id = rpo.id
      LEFT JOIN guards g ON g.id = pl.guard_id
      WHERE rpd.company_id = $1
        AND rpd.site_id = $2
        AND rpd.local_date = $3::date
      ORDER BY pp.point_name ASC, rpo.scheduled_at ASC
      `,
      [site.company_id, siteId, localDate]
    );
    const days = daysResult.rows;
    return {
      site,
      days,
      generated_count: days.reduce((total, day) => total + Number(day.generated_count || 0), 0),
      configured_daily_patrols: days.reduce((total, day) => total + Number(day.configured_count || 0), 0),
      schedule_type: days.some((day) => day.generation_type === "partial_first_day")
        ? "partial_first_day"
        : days.length > 0 ? "full_day" : null,
      occurrences: result.rows,
    };
  }

  router.get("/settings/sites/:siteId/random-patrol-config", requireAuth, requirePermission("patrols.view"), async (req, res) => {
    try {
      const siteId = Number(req.params.siteId);
      const site = await getAuthorizedSite(pool, req.auth, siteId);
      if (!site) return res.status(404).json({ status: "error", message: "Site not found" });
      const result = await pool.query(
        `
        SELECT pp.id AS patrol_point_id, pp.point_name, pp.active,
               rpc.enabled, rpc.patrols_per_day, rpc.effective_from_date,
               rpc.updated_at, u.username AS updated_by_username
        FROM patrol_points pp
        LEFT JOIN random_patrol_configurations rpc
          ON rpc.company_id = $1 AND rpc.site_id = $2 AND rpc.patrol_point_id = pp.id
        LEFT JOIN users u ON u.id = rpc.updated_by
        WHERE pp.site_id = $2 AND pp.active = TRUE
        ORDER BY pp.point_name ASC, pp.id ASC
        `,
        [site.company_id, siteId]
      );
      return res.json({ status: "ok", site, points: result.rows });
    } catch (error) {
      console.error("Random patrol config load error:", error);
      return res.status(500).json({ status: "error", message: "Failed to load Random Patrol configuration" });
    }
  });

  router.put("/settings/sites/:siteId/random-patrol-config", requireAuth, requirePermission("patrols.manage"), async (req, res) => {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      const siteId = Number(req.params.siteId);
      const pointIds = [...new Set((req.body.point_ids || []).map(Number))];
      const enabled = req.body.enabled === true;
      const patrolsPerDay = Number(req.body.patrols_per_day);
      if (!Number.isInteger(siteId) || siteId <= 0 || pointIds.length === 0 ||
          pointIds.some((id) => !Number.isInteger(id) || id <= 0) ||
          !Number.isInteger(patrolsPerDay) || patrolsPerDay < 1 || patrolsPerDay > 20) {
        return res.status(400).json({ status: "error", message: "Valid point_ids and patrols_per_day (1-20) are required" });
      }
      const site = await getAuthorizedSite(pool, req.auth, siteId);
      if (!site) return res.status(404).json({ status: "error", message: "Site not found" });
      const points = await client.query(
        "SELECT id FROM patrol_points WHERE site_id = $1 AND active = TRUE AND id = ANY($2::int[])",
        [siteId, pointIds]
      );
      if (points.rows.length !== pointIds.length) {
        return res.status(400).json({ status: "error", message: "One or more Patrol Points are invalid for this Site" });
      }

      await client.query("BEGIN");
      transactionStarted = true;
      const localClockResult = await client.query(
        `
        SELECT
          (NOW() AT TIME ZONE $1::text)::date AS local_date,
          ((NOW() AT TIME ZONE $1::text)::date + 1) AS tomorrow,
          (
            EXTRACT(HOUR FROM (NOW() AT TIME ZONE $1::text))::int * 60
            + EXTRACT(MINUTE FROM (NOW() AT TIME ZONE $1::text))::int
          )::int AS current_minute,
          EXTRACT(SECOND FROM (NOW() AT TIME ZONE $1::text))::int AS current_second
        `,
        [site.timezone]
      );
      const localClock = localClockResult.rows[0];
      const generatedSchedules = [];
      const effectiveDates = [];
      for (const pointId of pointIds) {
        const previous = await client.query(
          "SELECT enabled, patrols_per_day FROM random_patrol_configurations WHERE company_id=$1 AND site_id=$2 AND patrol_point_id=$3 FOR UPDATE",
          [site.company_id, siteId, pointId]
        );
        const old = previous.rows[0] || null;
        const { isActivation, effectiveFromDate } = resolveConfigurationActivation({
          enabled,
          previousEnabled: old?.enabled,
          today: localClock.local_date,
          tomorrow: localClock.tomorrow,
        });
        effectiveDates.push(effectiveFromDate);
        await client.query(
          `
          INSERT INTO random_patrol_configurations (
            company_id, site_id, patrol_point_id, enabled, patrols_per_day,
            effective_from_date, updated_by, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
          ON CONFLICT (company_id, site_id, patrol_point_id)
          DO UPDATE SET enabled=EXCLUDED.enabled,
                        patrols_per_day=EXCLUDED.patrols_per_day,
                        effective_from_date=EXCLUDED.effective_from_date,
                        updated_by=EXCLUDED.updated_by,
                        updated_at=NOW()
          `,
          [site.company_id, siteId, pointId, enabled, patrolsPerDay, effectiveFromDate, req.auth.user_id]
        );
        await client.query(
          `
          INSERT INTO random_patrol_configuration_history (
            company_id, site_id, patrol_point_id, admin_user_id,
            previous_enabled, new_enabled, previous_patrols_per_day,
            new_patrols_per_day, effective_from_date, changed_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
          `,
          [site.company_id, siteId, pointId, req.auth.user_id, old?.enabled ?? null,
           enabled, old?.patrols_per_day ?? null, patrolsPerDay, effectiveFromDate]
        );

        if (isActivation) {
          const minuteOffsets = generatePartialDayMinuteOffsets({
            currentMinute: Number(localClock.current_minute),
            currentSecond: Number(localClock.current_second),
            maxCount: patrolsPerDay,
          });
          const generated = await createRandomPatrolDay(
            client,
            {
              company_id: site.company_id,
              site_id: siteId,
              patrol_point_id: pointId,
              local_date: localClock.local_date,
              timezone: site.timezone,
              patrols_per_day: patrolsPerDay,
            },
            minuteOffsets,
            "partial_first_day"
          );
          generatedSchedules.push({
            patrol_point_id: pointId,
            created: generated.created,
            generated_count: generated.generatedCount,
            configured_count: patrolsPerDay,
            generation_type: "partial_first_day",
          });
        }
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return res.json({
        status: "ok",
        updated_points: pointIds.length,
        effective_from_dates: effectiveDates,
        local_date: localClock.local_date,
        generated_schedules: generatedSchedules,
      });
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      console.error("Random patrol config save error:", error);
      return res.status(500).json({ status: "error", message: "Failed to save Random Patrol configuration" });
    } finally {
      client.release();
    }
  });

  router.get("/settings/sites/:siteId/random-patrol-config/history", requireAuth, requirePermission("patrols.view"), async (req, res) => {
    try {
      const siteId = Number(req.params.siteId);
      const site = await getAuthorizedSite(pool, req.auth, siteId);
      if (!site) return res.status(404).json({ status: "error", message: "Site not found" });
      const result = await pool.query(
        `
        SELECT h.*, pp.point_name, u.username AS admin_username
        FROM random_patrol_configuration_history h
        INNER JOIN patrol_points pp ON pp.id=h.patrol_point_id AND pp.site_id=h.site_id
        LEFT JOIN users u ON u.id=h.admin_user_id
        WHERE h.company_id=$1 AND h.site_id=$2
        ORDER BY h.changed_at DESC, h.id DESC LIMIT 200
        `,
        [site.company_id, siteId]
      );
      return res.json({ status: "ok", history: result.rows });
    } catch (error) {
      return res.status(500).json({ status: "error", message: "Failed to load Random Patrol history" });
    }
  });

  router.get("/patrols/random-schedules", requireAuth, requirePermission("patrols.view"), async (req, res) => {
    try {
      const siteId = Number(req.query.site_id);
      const date = String(req.query.date || "");
      if (!Number.isInteger(siteId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ status: "error", message: "Valid site_id and date are required" });
      }
      const schedule = await loadSchedule(req, siteId, date);
      if (!schedule) return res.status(404).json({ status: "error", message: "Site not found" });
      return res.json({ status: "ok", ...schedule });
    } catch (error) {
      console.error("Random schedule load error:", error);
      return res.status(500).json({ status: "error", message: "Failed to load Random Patrol schedule" });
    }
  });

  router.get("/patrols/random-schedules/report/pdf", requireAuth, requireAllPermissions(["patrols.view", "exports.view"]), async (req, res) => {
    let browser;
    try {
      const siteId = Number(req.query.site_id);
      const date = String(req.query.date || "");
      const schedule = await loadSchedule(req, siteId, date);
      if (!schedule) return res.status(404).json({ status: "error", message: "Site not found" });
      const rows = schedule.occurrences.map((item) => `
        <tr><td>${escapeHtml(item.point_name)}</td><td>${escapeHtml(item.scheduled_at)}</td>
        <td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.completed_at || "-")}</td>
        <td>${escapeHtml(item.delay_minutes ?? "-")}</td><td>${escapeHtml(item.guard_name || "-")}</td></tr>
      `).join("");
      const generatedAt = schedule.days[0]?.generated_at || "-";
      const daySummaryRows = schedule.days.map((day) => `
        <tr><td>${escapeHtml(day.point_name)}</td><td>${escapeHtml(day.configured_count)}</td>
        <td>${escapeHtml(day.generated_count)}</td><td>${day.generation_type === "partial_first_day" ? "Partial first day" : "Full day"}</td></tr>
      `).join("");
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:Arial,sans-serif;padding:32px;color:#111}h1{margin-bottom:4px}
        table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border:1px solid #bbb;padding:8px;text-align:left}
        th{background:#eee}</style></head><body>
        <h1>Aegis Link — Random Daily Patrols</h1>
        <p><strong>Company:</strong> ${escapeHtml(schedule.site.company_name)}<br>
        <strong>Site:</strong> ${escapeHtml(schedule.site.name)}<br><strong>Date:</strong> ${escapeHtml(date)}<br>
        <strong>Generated:</strong> ${escapeHtml(generatedAt)}<br>
        <strong>Configured daily patrols:</strong> ${escapeHtml(schedule.configured_daily_patrols)}<br>
        <strong>Generated today:</strong> ${escapeHtml(schedule.generated_count)}<br>
        <strong>Schedule type:</strong> ${schedule.schedule_type === "partial_first_day" ? "Partial first day" : "Full day"}</p>
        <table><thead><tr><th>Patrol Point</th><th>Configured / day</th><th>Generated</th><th>Schedule type</th></tr></thead>
        <tbody>${daySummaryRows || '<tr><td colspan="4">No generated schedule.</td></tr>'}</tbody></table>
        <table><thead><tr><th>Patrol Point</th><th>Scheduled</th><th>Status</th><th>Completed</th><th>Delay</th><th>Guard</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6">No generated Random Patrols.</td></tr>'}</tbody></table></body></html>`;
      browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "15mm", bottom: "15mm", left: "12mm", right: "12mm" } });
      await browser.close();
      browser = null;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `${req.query.preview === "true" ? "inline" : "attachment"}; filename=random-patrols-${date}.pdf`);
      return res.send(pdf);
    } catch (error) {
      if (browser) await browser.close();
      console.error("Random schedule PDF error:", error);
      return res.status(500).json({ status: "error", message: "Failed to generate Random Patrol PDF" });
    }
  });

  return router;
}

module.exports = {
  createRandomPatrolRouter,
  generateRandomPatrolsForCurrentLocalDay,
  getAuthorizedSite,
  resolveConfigurationActivation,
};
