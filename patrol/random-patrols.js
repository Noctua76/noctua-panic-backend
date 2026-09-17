const express = require("express");
const puppeteer = require("puppeteer");
const { generateRandomMinuteOffsets } = require("./lifecycle");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
      (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date AS local_date
    FROM random_patrol_configurations rpc
    INNER JOIN companies c ON c.id = rpc.company_id
    INNER JOIN sites s
      ON s.id = rpc.site_id
      AND s.company_id = rpc.company_id
    INNER JOIN patrol_points pp
      ON pp.id = rpc.patrol_point_id
      AND pp.site_id = rpc.site_id
      AND pp.active = TRUE
    WHERE rpc.enabled = TRUE
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
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`random-patrol:${configuration.company_id}:${configuration.site_id}:${configuration.patrol_point_id}:${configuration.local_date}`]
      );
      const day = await client.query(
        `
        INSERT INTO random_patrol_days (
          company_id, site_id, patrol_point_id, local_date,
          timezone, configured_count, generated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
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
        ]
      );
      if (day.rows.length === 0) {
        await client.query("COMMIT");
        continue;
      }

      const minuteOffsets = generateRandomMinuteOffsets(configuration.patrols_per_day);
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
      await client.query("COMMIT");
      generatedDays += 1;
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
  const isSystemOwner = auth.role === "system_owner";
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

function createRandomPatrolRouter({ pool, requireAuth }) {
  const router = express.Router();

  function requirePatrolAdministrator(req, res, next) {
    if (!["system_owner", "supervisor"].includes(req.auth.role)) {
      return res.status(403).json({ status: "error", message: "Administrator access required" });
    }
    return next();
  }

  async function loadSchedule(req, siteId, localDate) {
    const site = await getAuthorizedSite(pool, req.auth, siteId);
    if (!site) return null;
    const result = await pool.query(
      `
      SELECT
        rpd.id AS day_id,
        rpo.id AS occurrence_id,
        rpd.local_date,
        rpd.generated_at,
        rpd.configured_count,
        rpd.timezone,
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
    return { site, occurrences: result.rows };
  }

  router.get("/settings/sites/:siteId/random-patrol-config", requireAuth, requirePatrolAdministrator, async (req, res) => {
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

  router.put("/settings/sites/:siteId/random-patrol-config", requireAuth, requirePatrolAdministrator, async (req, res) => {
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
      const effective = await client.query(
        "SELECT ((NOW() AT TIME ZONE $1::text)::date + 1) AS effective_from_date",
        [site.timezone]
      );
      const effectiveFromDate = effective.rows[0].effective_from_date;
      for (const pointId of pointIds) {
        const previous = await client.query(
          "SELECT enabled, patrols_per_day FROM random_patrol_configurations WHERE company_id=$1 AND site_id=$2 AND patrol_point_id=$3 FOR UPDATE",
          [site.company_id, siteId, pointId]
        );
        const old = previous.rows[0] || null;
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
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return res.json({ status: "ok", updated_points: pointIds.length, effective_from_date: effectiveFromDate });
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      console.error("Random patrol config save error:", error);
      return res.status(500).json({ status: "error", message: "Failed to save Random Patrol configuration" });
    } finally {
      client.release();
    }
  });

  router.get("/settings/sites/:siteId/random-patrol-config/history", requireAuth, requirePatrolAdministrator, async (req, res) => {
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

  router.get("/patrols/random-schedules", requireAuth, requirePatrolAdministrator, async (req, res) => {
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

  router.get("/patrols/random-schedules/report/pdf", requireAuth, requirePatrolAdministrator, async (req, res) => {
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
      const generatedAt = schedule.occurrences[0]?.generated_at || "-";
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:Arial,sans-serif;padding:32px;color:#111}h1{margin-bottom:4px}
        table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border:1px solid #bbb;padding:8px;text-align:left}
        th{background:#eee}</style></head><body>
        <h1>Aegis Link — Random Daily Patrols</h1>
        <p><strong>Company:</strong> ${escapeHtml(schedule.site.company_name)}<br>
        <strong>Site:</strong> ${escapeHtml(schedule.site.name)}<br><strong>Date:</strong> ${escapeHtml(date)}<br>
        <strong>Generated:</strong> ${escapeHtml(generatedAt)}<br><strong>Occurrences:</strong> ${schedule.occurrences.length}</p>
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
};
