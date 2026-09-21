const express = require("express");

const OUTCOME_VALUES = new Set([
  "MISSED",
  "COMPLETED",
  "COMPLETED_LATE",
]);

function requirePatrolCorrectionPermission(req, res, next) {
  if (!req.auth?.is_system_owner && !req.auth?.permissions?.includes("patrols.correct")) {
    return res.status(403).json({
      status: "error",
      message: "Only the system owner can manage patrol corrections",
    });
  }

  next();
}

function formatCorrection(row) {
  return {
    id: row.id,
    field: row.field_name,
    original_value: row.original_value,
    corrected_value: row.corrected_value,
    reason: row.reason,
    corrected_by: row.corrected_by,
    corrected_by_name: row.corrected_by_name,
    corrected_at: row.corrected_at,
  };
}

async function loadCorrectionsByOccurrence(pool, occurrenceKeys) {
  if (!occurrenceKeys.length) return new Map();

  const result = await pool.query(
    `
    SELECT
      pc.id,
      pc.occurrence_key,
      pc.field_name,
      pc.original_value,
      pc.corrected_value,
      pc.reason,
      pc.corrected_by,
      pc.corrected_at,
      COALESCE(u.full_name, u.username) AS corrected_by_name
    FROM patrol_corrections pc
    LEFT JOIN users u ON u.id = pc.corrected_by
    WHERE pc.occurrence_key = ANY($1::text[])
    ORDER BY pc.corrected_at ASC, pc.id ASC
    `,
    [occurrenceKeys]
  );

  const byOccurrence = new Map();

  for (const row of result.rows) {
    if (!byOccurrence.has(row.occurrence_key)) {
      byOccurrence.set(row.occurrence_key, []);
    }
    byOccurrence.get(row.occurrence_key).push(formatCorrection(row));
  }

  return byOccurrence;
}

async function attachCorrectionsToRows(pool, rows, keySelector, outcomeSelector) {
  const keys = rows.map(keySelector).filter(Boolean);
  const correctionsByOccurrence = await loadCorrectionsByOccurrence(pool, keys);

  return rows.map((row) => {
    const occurrenceKey = keySelector(row);
    const corrections = correctionsByOccurrence.get(occurrenceKey) || [];
    const outcomeCorrections = corrections.filter(
      (correction) => correction.field === "outcome"
    );
    const originalOutcome = outcomeSelector(row);

    return {
      ...row,
      occurrence_key: occurrenceKey,
      corrected: corrections.length > 0,
      corrections,
      original_operational_outcome: originalOutcome,
      final_interpreted_value:
        outcomeCorrections.at(-1)?.corrected_value || originalOutcome,
    };
  });
}

async function loadOccurrence(pool, occurrenceKey) {
  const completedMatch = /^patrol-log-(\d+)$/.exec(occurrenceKey);

  if (completedMatch) {
    const result = await pool.query(
      `
      SELECT
        CONCAT('patrol-log-', pl.id) AS occurrence_key,
        pl.id AS patrol_log_id,
        pl.site_id,
        s.company_id,
        s.name AS site_name,
        pl.point_id,
        pp.point_name,
        pl.schedule_id,
        COALESCE(pl.schedule_type, 'recurring') AS schedule_type,
        pl.scheduled_at,
        pl.patrol_time,
        pl.delay_minutes,
        CASE
          WHEN pl.completion_status = 'completed_late'
          THEN 'COMPLETED_LATE'
          ELSE 'COMPLETED'
        END AS original_outcome,
        pl.latitude,
        pl.longitude,
        pl.accuracy,
        g.full_name AS guard_name
      FROM patrol_logs pl
      JOIN sites s ON s.id = pl.site_id
      LEFT JOIN patrol_points pp ON pp.id = pl.point_id
      LEFT JOIN guards g ON g.id = pl.guard_id
      WHERE pl.id = $1
      LIMIT 1
      `,
      [Number(completedMatch[1])]
    );

    return result.rows[0] || null;
  }

  const recurringMatch = /^recurring-missed-(\d+)-([0-9.]+)$/.exec(occurrenceKey);

  if (recurringMatch) {
    const result = await pool.query(
      `
      SELECT
        $1::text AS occurrence_key,
        NULL::bigint AS patrol_log_id,
        ps.site_id,
        s.company_id,
        s.name AS site_name,
        ps.patrol_point_id AS point_id,
        pp.point_name,
        ps.id AS schedule_id,
        'recurring'::text AS schedule_type,
        (TO_TIMESTAMP($3::double precision) AT TIME ZONE 'UTC') AS scheduled_at,
        NULL::timestamptz AS patrol_time,
        NULL::int AS delay_minutes,
        'MISSED'::text AS original_outcome,
        NULL::numeric AS latitude,
        NULL::numeric AS longitude,
        NULL::numeric AS accuracy,
        NULL::text AS guard_name
      FROM patrol_schedules ps
      JOIN sites s ON s.id = ps.site_id
      JOIN companies c ON c.id = s.company_id
      JOIN patrol_points pp ON pp.id = ps.patrol_point_id
      WHERE ps.id = $2
        AND ps.schedule_type = 'recurring'
        AND (TO_TIMESTAMP($3::double precision) AT TIME ZONE 'UTC')
          + INTERVAL '2 hours' <= NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')
        AND NOT EXISTS (
          SELECT 1
          FROM patrol_logs pl
          WHERE pl.schedule_id = ps.id
            AND COALESCE(pl.schedule_type, 'recurring') = 'recurring'
            AND pl.scheduled_at =
              (TO_TIMESTAMP($3::double precision) AT TIME ZONE 'UTC')
        )
      LIMIT 1
      `,
      [occurrenceKey, Number(recurringMatch[1]), Number(recurringMatch[2])]
    );

    return result.rows[0] || null;
  }

  const manualMatch = /^manual-missed-(\d+)$/.exec(occurrenceKey);

  if (manualMatch) {
    const result = await pool.query(
      `
      SELECT
        $1::text AS occurrence_key,
        NULL::bigint AS patrol_log_id,
        ps.site_id,
        s.company_id,
        s.name AS site_name,
        ps.patrol_point_id AS point_id,
        pp.point_name,
        ps.id AS schedule_id,
        'manual'::text AS schedule_type,
        (ps.scheduled_date + ps.scheduled_time) AS scheduled_at,
        NULL::timestamptz AS patrol_time,
        NULL::int AS delay_minutes,
        'MISSED'::text AS original_outcome,
        NULL::numeric AS latitude,
        NULL::numeric AS longitude,
        NULL::numeric AS accuracy,
        NULL::text AS guard_name
      FROM patrol_schedules ps
      JOIN sites s ON s.id = ps.site_id
      JOIN companies c ON c.id = s.company_id
      JOIN patrol_points pp ON pp.id = ps.patrol_point_id
      WHERE ps.id = $2
        AND ps.schedule_type = 'manual'
        AND ps.scheduled_date + ps.scheduled_time + INTERVAL '2 hours'
          <= NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')
        AND NOT EXISTS (
          SELECT 1 FROM patrol_logs pl WHERE pl.schedule_id = ps.id
        )
      LIMIT 1
      `,
      [occurrenceKey, Number(manualMatch[1])]
    );

    return result.rows[0] || null;
  }

  const randomMatch = /^random-missed-(\d+)$/.exec(occurrenceKey);

  if (randomMatch) {
    const result = await pool.query(
      `
      SELECT
        $1::text AS occurrence_key,
        NULL::bigint AS patrol_log_id,
        rpo.site_id,
        rpo.company_id,
        s.name AS site_name,
        rpo.patrol_point_id AS point_id,
        pp.point_name,
        NULL::bigint AS schedule_id,
        'random'::text AS schedule_type,
        rpo.scheduled_at,
        NULL::timestamptz AS patrol_time,
        NULL::int AS delay_minutes,
        'MISSED'::text AS original_outcome,
        NULL::numeric AS latitude,
        NULL::numeric AS longitude,
        NULL::numeric AS accuracy,
        NULL::text AS guard_name
      FROM random_patrol_occurrences rpo
      JOIN random_patrol_days rpd ON rpd.id = rpo.random_patrol_day_id
      JOIN sites s ON s.id = rpo.site_id AND s.company_id = rpo.company_id
      JOIN patrol_points pp ON pp.id = rpo.patrol_point_id
      WHERE rpo.id = $2
        AND rpo.scheduled_at + INTERVAL '2 hours' <= NOW() AT TIME ZONE rpd.timezone
        AND NOT EXISTS (
          SELECT 1 FROM patrol_logs pl WHERE pl.random_occurrence_id = rpo.id
        )
      LIMIT 1
      `,
      [occurrenceKey, Number(randomMatch[1])]
    );

    return result.rows[0] || null;
  }

  return null;
}

function createPatrolCorrectionsRouter({ pool, requireAuth, requirePermission }) {
  const router = express.Router();

  router.use(requireAuth, requirePermission ? requirePermission("patrols.correct") : requirePatrolCorrectionPermission);

  router.get("/occurrences", async (req, res) => {
    try {
      const siteId = Number(req.query.site_id);
      const from = req.query.from;
      const to = req.query.to;

      if (!Number.isInteger(siteId) || siteId <= 0 || !from || !to) {
        return res.status(400).json({
          status: "error",
          message: "site_id, from and to are required",
        });
      }

      const fromDate = new Date(`${from}T00:00:00Z`);
      const toDate = new Date(`${to}T00:00:00Z`);
      const rangeDays = (toDate - fromDate) / 86400000;

      if (!Number.isFinite(rangeDays) || rangeDays < 0 || rangeDays > 31) {
        return res.status(400).json({
          status: "error",
          message: "Patrol correction range must be between 1 and 31 days",
        });
      }

      const result = await pool.query(
        `
        WITH completed AS (
          SELECT
            CONCAT('patrol-log-', pl.id) AS occurrence_key,
            pl.id AS patrol_log_id,
            pl.site_id,
            s.name AS site_name,
            pl.point_id,
            pp.point_name,
            pl.schedule_id,
            COALESCE(pl.schedule_type, 'recurring') AS schedule_type,
            pl.scheduled_at,
            pl.patrol_time,
            CASE
              WHEN pl.completion_status = 'completed_late'
              THEN 'COMPLETED_LATE'
              ELSE 'COMPLETED'
            END AS original_outcome,
            g.full_name AS guard_name
          FROM patrol_logs pl
          JOIN sites s ON s.id = pl.site_id
          JOIN companies c ON c.id = s.company_id
          LEFT JOIN patrol_points pp ON pp.id = pl.point_id
          LEFT JOIN guards g ON g.id = pl.guard_id
          WHERE pl.site_id = $1
            AND (pl.patrol_time AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
              BETWEEN $2::date AND $3::date
        ),
        recurring_missed AS (
          SELECT
            CONCAT(
              'recurring-missed-', ps.id, '-', EXTRACT(EPOCH FROM slots.scheduled_at)
            ) AS occurrence_key,
            NULL::bigint AS patrol_log_id,
            ps.site_id,
            s.name AS site_name,
            ps.patrol_point_id AS point_id,
            pp.point_name,
            ps.id AS schedule_id,
            'recurring'::text AS schedule_type,
            slots.scheduled_at,
            NULL::timestamptz AS patrol_time,
            'MISSED'::text AS original_outcome,
            NULL::text AS guard_name
          FROM patrol_schedules ps
          JOIN sites s ON s.id = ps.site_id
          JOIN companies c ON c.id = s.company_id
          JOIN patrol_points pp ON pp.id = ps.patrol_point_id
          CROSS JOIN LATERAL generate_series(
            (ps.created_at AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
              + ps.start_time,
            LEAST(
              NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'),
              ($3::date + 1)::timestamp - INTERVAL '1 millisecond'
            ),
            (ps.interval_hours || ' hours')::interval
          ) AS slots(scheduled_at)
          WHERE ps.site_id = $1
            AND ps.schedule_type = 'recurring'
            AND ps.active = true
            AND ps.start_time IS NOT NULL
            AND ps.interval_hours > 0
            AND slots.scheduled_at >= $2::date::timestamp
            AND slots.scheduled_at < ($3::date + 1)::timestamp
            AND slots.scheduled_at + INTERVAL '2 hours'
              <= NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')
            AND NOT EXISTS (
              SELECT 1
              FROM patrol_logs pl
              WHERE pl.schedule_id = ps.id
                AND COALESCE(pl.schedule_type, 'recurring') = 'recurring'
                AND pl.scheduled_at = slots.scheduled_at
            )
        ),
        manual_missed AS (
          SELECT
            CONCAT('manual-missed-', ps.id) AS occurrence_key,
            NULL::bigint AS patrol_log_id,
            ps.site_id,
            s.name AS site_name,
            ps.patrol_point_id AS point_id,
            pp.point_name,
            ps.id AS schedule_id,
            'manual'::text AS schedule_type,
            ps.scheduled_date + ps.scheduled_time AS scheduled_at,
            NULL::timestamptz AS patrol_time,
            'MISSED'::text AS original_outcome,
            NULL::text AS guard_name
          FROM patrol_schedules ps
          JOIN sites s ON s.id = ps.site_id
          JOIN companies c ON c.id = s.company_id
          JOIN patrol_points pp ON pp.id = ps.patrol_point_id
          WHERE ps.site_id = $1
            AND ps.schedule_type = 'manual'
            AND ps.scheduled_date BETWEEN $2::date AND $3::date
            AND ps.scheduled_date + ps.scheduled_time + INTERVAL '2 hours'
              <= NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')
            AND NOT EXISTS (
              SELECT 1 FROM patrol_logs pl WHERE pl.schedule_id = ps.id
            )
        ),
        random_missed AS (
          SELECT
            CONCAT('random-missed-', rpo.id) AS occurrence_key,
            NULL::bigint AS patrol_log_id,
            rpo.site_id,
            s.name AS site_name,
            rpo.patrol_point_id AS point_id,
            pp.point_name,
            NULL::bigint AS schedule_id,
            'random'::text AS schedule_type,
            rpo.scheduled_at,
            NULL::timestamptz AS patrol_time,
            'MISSED'::text AS original_outcome,
            NULL::text AS guard_name
          FROM random_patrol_occurrences rpo
          JOIN random_patrol_days rpd ON rpd.id = rpo.random_patrol_day_id
          JOIN sites s ON s.id = rpo.site_id AND s.company_id = rpo.company_id
          JOIN patrol_points pp ON pp.id = rpo.patrol_point_id
          WHERE rpo.site_id = $1
            AND rpd.local_date BETWEEN $2::date AND $3::date
            AND rpo.scheduled_at + INTERVAL '2 hours' <= NOW() AT TIME ZONE rpd.timezone
            AND NOT EXISTS (
              SELECT 1 FROM patrol_logs pl WHERE pl.random_occurrence_id = rpo.id
            )
        ),
        all_occurrences AS (
          SELECT * FROM completed
          UNION ALL SELECT * FROM recurring_missed
          UNION ALL SELECT * FROM manual_missed
          UNION ALL SELECT * FROM random_missed
        )
        SELECT *
        FROM all_occurrences
        ORDER BY COALESCE(patrol_time, scheduled_at) DESC
        LIMIT 500
        `,
        [siteId, from, to]
      );

      const occurrences = await attachCorrectionsToRows(
        pool,
        result.rows,
        (row) => row.occurrence_key,
        (row) => row.original_outcome
      );

      return res.json({ status: "ok", occurrences });
    } catch (error) {
      console.error("Patrol corrections occurrence load error:", error);
      return res.status(500).json({
        status: "error",
        message: "Unable to load patrol occurrences",
      });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const occurrenceKey = String(req.body.occurrence_key || "").trim();
      const fieldName = String(req.body.field || "").trim().toLowerCase();
      const correctedValue = String(req.body.corrected_value || "").trim().toUpperCase();
      const reason = String(req.body.reason || "").trim();

      if (!occurrenceKey || fieldName !== "outcome") {
        return res.status(400).json({
          status: "error",
          message: "A valid occurrence and outcome field are required",
        });
      }

      if (!OUTCOME_VALUES.has(correctedValue)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid corrected outcome",
        });
      }

      if (reason.length < 10 || reason.length > 1000) {
        return res.status(400).json({
          status: "error",
          message: "Correction reason must be between 10 and 1000 characters",
        });
      }

      const occurrence = await loadOccurrence(pool, occurrenceKey);

      if (!occurrence) {
        return res.status(404).json({
          status: "error",
          message: "Patrol occurrence was not found or is not eligible",
        });
      }

      const insertResult = await pool.query(
        `
        INSERT INTO patrol_corrections (
          company_id,
          site_id,
          patrol_log_id,
          occurrence_key,
          schedule_id,
          scheduled_at,
          field_name,
          original_value,
          corrected_value,
          reason,
          original_record,
          corrected_by
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12
        )
        RETURNING *
        `,
        [
          occurrence.company_id,
          occurrence.site_id,
          occurrence.patrol_log_id,
          occurrence.occurrence_key,
          occurrence.schedule_id,
          occurrence.scheduled_at,
          fieldName,
          occurrence.original_outcome,
          correctedValue,
          reason,
          JSON.stringify(occurrence),
          req.auth.user_id,
        ]
      );

      return res.status(201).json({
        status: "ok",
        message: "Patrol correction recorded without changing the original record",
        correction: insertResult.rows[0],
      });
    } catch (error) {
      console.error("Patrol correction creation error:", error);
      return res.status(500).json({
        status: "error",
        message: "Unable to create patrol correction",
      });
    }
  });

  return router;
}

module.exports = {
  attachCorrectionsToRows,
  createPatrolCorrectionsRouter,
  loadOccurrence,
  requirePatrolCorrectionPermission,
};
