const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

const CATEGORIES = Object.freeze([
  "OBSERVATION",
  "FACILITY_EQUIPMENT",
  "SECURITY_CONCERN",
  "HANDOVER_NOTE",
  "OTHER",
]);
const PRIORITIES = Object.freeze(["NORMAL", "IMPORTANT"]);
const STATUSES = Object.freeze(["NEW", "READ", "ACKNOWLEDGED"]);
const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) return { mimeType: "image/jpeg", extension: "jpg" };
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) return { mimeType: "image/png", extension: "png" };
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return { mimeType: "image/webp", extension: "webp" };
  return null;
}

function validateReportInput(body = {}, files = []) {
  const category = String(body.category || "").trim().toUpperCase();
  const priority = String(body.priority || "NORMAL").trim().toUpperCase();
  const message = String(body.message || "").trim();
  if (!CATEGORIES.includes(category)) throw badRequest("Invalid report category");
  if (!PRIORITIES.includes(priority)) throw badRequest("Invalid report priority");
  if (!message || message.length > 5000) {
    throw badRequest("Message must contain between 1 and 5000 characters");
  }
  if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS) {
    throw badRequest(`A maximum of ${MAX_ATTACHMENTS} images is allowed`);
  }
  const validatedFiles = files.map((file) => {
    if (!file?.buffer?.length || file.size > MAX_FILE_SIZE) {
      throw badRequest("Each image must be no larger than 10 MB");
    }
    const detected = detectImageType(file.buffer);
    if (!detected || detected.mimeType !== file.mimetype) {
      throw badRequest("Only genuine JPEG, PNG and WEBP images are allowed");
    }
    return { ...file, ...detected };
  });
  return { category, priority, message, files: validatedFiles };
}

function badRequest(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizePositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest(`Invalid ${fieldName}`);
  return parsed;
}

function normalizeIsoDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw badRequest(`Invalid ${fieldName}`);
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) throw badRequest(`Invalid ${fieldName}`);
  return normalized;
}

function buildAdminFilters(query, auth, startIndex = 1) {
  const clauses = [];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    clauses.push(sql.replace("?", `$${startIndex + values.length - 1}`));
  };
  if (auth.role !== "system_owner") add("r.company_id = ?", auth.company_id);
  else if (query.company_id) add("r.company_id = ?", normalizePositiveInteger(query.company_id, "company_id"));
  if (query.site_id) add("r.site_id = ?", normalizePositiveInteger(query.site_id, "site_id"));
  if (query.guard_id) add("r.guard_id = ?", normalizePositiveInteger(query.guard_id, "guard_id"));
  if (query.category) {
    const value = String(query.category).toUpperCase();
    if (!CATEGORIES.includes(value)) throw badRequest("Invalid category");
    add("r.category = ?", value);
  }
  if (query.priority) {
    const value = String(query.priority).toUpperCase();
    if (!PRIORITIES.includes(value)) throw badRequest("Invalid priority");
    add("r.priority = ?", value);
  }
  if (query.status) {
    const value = String(query.status).toUpperCase();
    if (!STATUSES.includes(value)) throw badRequest("Invalid status");
    add("r.status = ?", value);
  }
  if (query.from) {
    add(
      "r.created_at >= (?::date::timestamp AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))",
      normalizeIsoDate(query.from, "from date")
    );
  }
  if (query.to) {
    add(
      "r.created_at < ((?::date + 1)::timestamp AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))",
      normalizeIsoDate(query.to, "to date")
    );
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

function reportNumber(localDate, id) {
  return `SR-${String(localDate).replaceAll("-", "")}-${String(id).padStart(6, "0")}`;
}

function mapReport(row) {
  return {
    id: row.id,
    report_number: row.report_number,
    company_id: row.company_id,
    company_name: row.company_name,
    site_id: row.site_id,
    site_name: row.site_name,
    guard_id: row.guard_id,
    guard_name: row.guard_name,
    session_id: row.session_id,
    scheduled_shift_start: row.scheduled_shift_start,
    scheduled_shift_end: row.scheduled_shift_end,
    category: row.category,
    priority: row.priority,
    message: row.message,
    status: row.status,
    created_at: row.created_at,
    read_at: row.read_at,
    read_by_admin_id: row.read_by_admin_id,
    read_by_admin_name: row.read_by_admin_name,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by_admin_id: row.acknowledged_by_admin_id,
    acknowledged_by_admin_name: row.acknowledged_by_admin_name,
    attachment_count: Number(row.attachment_count || 0),
    company_timezone: row.company_timezone || "Europe/Athens",
  };
}

const REPORT_SELECT = `
  r.*,
  c.name AS company_name,
  COALESCE(c.timezone, 'Europe/Athens') AS company_timezone,
  s.name AS site_name,
  g.full_name AS guard_name,
  reader.full_name AS read_by_admin_name,
  acknowledger.full_name AS acknowledged_by_admin_name,
  (SELECT COUNT(*) FROM guard_shift_report_attachments a WHERE a.report_id = r.id)::int AS attachment_count
FROM guard_shift_reports r
JOIN companies c ON c.id = r.company_id
JOIN sites s ON s.id = r.site_id
JOIN guards g ON g.id = r.guard_id
LEFT JOIN users reader ON reader.id = r.read_by_admin_id
LEFT JOIN users acknowledger ON acknowledger.id = r.acknowledged_by_admin_id`;

function pdfDisposition(value) {
  return String(value || "").toLowerCase() === "inline" ? "inline" : "attachment";
}

function formatPdfDate(value, timezone = "Europe/Athens") {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function describeFilters(query = {}) {
  const entries = [
    ["Company", query.company_id],
    ["Site", query.site_id],
    ["Guard", query.guard_id],
    ["From", query.from],
    ["To", query.to],
    ["Category", query.category],
    ["Priority", query.priority],
    ["Status", query.status],
  ].filter(([, value]) => value);
  return entries.length
    ? entries.map(([name, value]) => `${name}: ${value}`).join(" · ")
    : "No filters applied";
}

async function removeStorageWithRetry(storage, paths, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await storage.remove(paths);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
  }
  throw lastError;
}

function createShiftReportsRouter({ pool, requireAuth, requireGuardAuth, storage, puppeteer }) {
  if (!pool || !requireAuth || !requireGuardAuth || !storage || !puppeteer) {
    throw new Error("Shift Reports router dependencies are required");
  }
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_ATTACHMENTS, fileSize: MAX_FILE_SIZE },
  });

  router.post("/guard/shift-reports", requireGuardAuth, upload.array("attachments", MAX_ATTACHMENTS), async (req, res) => {
    const uploadedPaths = [];
    let client;
    try {
      const input = validateReportInput(req.body, req.files || []);
      const guard = req.guard;
      client = await pool.connect();
      await client.query("BEGIN");
      const sessionResult = await client.query(
        `SELECT gs.id, gs.guard_id, gs.site_id, s.company_id,
                gs.scheduled_shift_start, gs.scheduled_shift_end,
                TO_CHAR((NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date, 'YYYY-MM-DD') AS local_date
         FROM guard_sessions gs
         JOIN sites s ON s.id = gs.site_id
         JOIN companies c ON c.id = s.company_id
         WHERE gs.id = $1 AND gs.guard_id = $2 AND gs.site_id = $3
           AND s.company_id = $4 AND gs.logout_time IS NULL
           AND (gs.scheduled_shift_end IS NULL OR gs.scheduled_shift_end > (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens')))
         FOR UPDATE`,
        [guard.session_id, guard.guard_id, guard.site_id, guard.company_id]
      );
      if (!sessionResult.rows.length) throw badRequest("The active shift has ended", 409);
      const session = sessionResult.rows[0];
      const sequence = await client.query("SELECT nextval(pg_get_serial_sequence('guard_shift_reports', 'id')) AS id");
      const id = sequence.rows[0].id;
      const number = reportNumber(session.local_date, id);
      const inserted = await client.query(
        `INSERT INTO guard_shift_reports
          (id, report_number, company_id, site_id, guard_id, session_id,
           scheduled_shift_start, scheduled_shift_end, category, priority, message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [id, number, guard.company_id, guard.site_id, guard.guard_id, guard.session_id,
          session.scheduled_shift_start, session.scheduled_shift_end,
          input.category, input.priority, input.message]
      );
      for (const file of input.files) {
        const path = `company-${guard.company_id}/site-${guard.site_id}/report-${id}/${crypto.randomUUID()}.${file.extension}`;
        await storage.upload(path, file.buffer, file.mimeType);
        uploadedPaths.push(path);
        await client.query(
          `INSERT INTO guard_shift_report_attachments
            (report_id, company_id, storage_path, original_filename, mime_type, file_size)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, guard.company_id, path, String(file.originalname || "image").slice(0, 255), file.mimeType, file.size]
        );
      }
      await client.query(
        `INSERT INTO guard_shift_report_events (report_id, company_id, event_type, actor_type, actor_id)
         VALUES ($1,$2,'SHIFT_REPORT_CREATED','GUARD',$3)`,
        [id, guard.company_id, guard.guard_id]
      );
      await client.query("COMMIT");
      return res.status(201).json({ status: "ok", report: inserted.rows[0] });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      if (uploadedPaths.length) {
        await removeStorageWithRetry(storage, uploadedPaths).catch((cleanupError) =>
          console.error("Shift Report storage cleanup failed after retries:", cleanupError)
        );
      }
      const status = error instanceof multer.MulterError ? 400 : (error.statusCode || 500);
      console.error("Create Shift Report error:", error);
      return res.status(status).json({ status: "error", message: status === 500 ? "Could not create Shift Report" : error.message });
    } finally {
      client?.release();
    }
  });

  router.get("/guard/shift-reports/current-shift", requireGuardAuth, async (req, res) => {
    try {
      const guard = req.guard;
      const result = await pool.query(
        `SELECT ${REPORT_SELECT}
         WHERE r.company_id=$1 AND r.site_id=$2 AND r.guard_id=$3 AND r.session_id=$4
         ORDER BY r.created_at DESC`,
        [guard.company_id, guard.site_id, guard.guard_id, guard.session_id]
      );
      return res.json({ status: "ok", reports: result.rows.map(mapReport) });
    } catch (error) {
      console.error("Current Shift Reports error:", error);
      return res.status(500).json({ status: "error", message: "Could not load Shift Reports" });
    }
  });

  router.get("/shift-reports", requireAuth, async (req, res) => {
    try {
      const filters = buildAdminFilters(req.query, req.auth);
      const [result, counts] = await Promise.all([
        pool.query(
          `SELECT ${REPORT_SELECT} ${filters.where} ORDER BY r.created_at DESC LIMIT 500`, filters.values
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE r.status='NEW')::int AS "NEW",
             COUNT(*) FILTER (WHERE r.status='READ')::int AS "READ",
             COUNT(*) FILTER (WHERE r.status='ACKNOWLEDGED')::int AS "ACKNOWLEDGED",
             COUNT(*) FILTER (
               WHERE (r.created_at AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
                 = (NOW() AT TIME ZONE COALESCE(c.timezone, 'Europe/Athens'))::date
             )::int AS "TODAY"
           FROM guard_shift_reports r
           JOIN companies c ON c.id = r.company_id
           ${filters.where}`,
          filters.values
        ),
      ]);
      const reports = result.rows.map(mapReport);
      const summary = counts.rows[0] || { NEW: 0, READ: 0, ACKNOWLEDGED: 0, TODAY: 0 };
      return res.json({ status: "ok", reports, summary });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ status: "error", message: error.statusCode ? error.message : "Could not load Shift Reports" });
    }
  });

  async function scopedReport(req, reportId, client = pool, lock = false) {
    const id = normalizePositiveInteger(reportId, "report id");
    const values = [id];
    let scope = "";
    if (req.auth.role !== "system_owner") {
      values.push(req.auth.company_id);
      scope = ` AND r.company_id=$${values.length}`;
    }
    const result = await client.query(
      `SELECT ${REPORT_SELECT} WHERE r.id=$1${scope} LIMIT 1${lock ? " FOR UPDATE OF r" : ""}`,
      values
    );
    if (!result.rows.length) throw badRequest("Shift Report not found", 404);
    return result.rows[0];
  }

  router.get("/shift-reports/unread-count", requireAuth, async (req, res) => {
    try {
      const values = [];
      let scope = "";
      if (req.auth.role !== "system_owner") {
        values.push(req.auth.company_id);
        scope = " AND company_id=$1";
      }
      const result = await pool.query(
        `SELECT COUNT(*)::int AS unread FROM guard_shift_reports WHERE status='NEW'${scope}`,
        values
      );
      return res.json({ status: "ok", unread: result.rows[0]?.unread || 0 });
    } catch (error) {
      return res.status(500).json({ status: "error", message: "Could not load unread Shift Report count" });
    }
  });

  router.get("/shift-reports/report/pdf", requireAuth, async (req, res) => {
    try {
      const filters = buildAdminFilters(req.query, req.auth);
      const result = await pool.query(`SELECT ${REPORT_SELECT} ${filters.where} ORDER BY r.created_at DESC LIMIT 500`, filters.values);
      const reports = result.rows;
      const rows = reports.map((row) => `<tr><td>${escapeHtml(row.report_number)}</td><td>${escapeHtml(formatPdfDate(row.created_at, row.company_timezone))}</td><td>${escapeHtml(row.company_name)}</td><td>${escapeHtml(row.site_name)}</td><td>${escapeHtml(row.guard_name)}</td><td>${escapeHtml(row.session_id)}</td><td>${escapeHtml(formatPdfDate(row.scheduled_shift_start, row.company_timezone))}<br>→ ${escapeHtml(formatPdfDate(row.scheduled_shift_end, row.company_timezone))}</td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.priority)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.message)}</td></tr>`).join("");
      const reportIds = reports.map((row) => row.id);
      const attachments = reportIds.length
        ? await pool.query(
          `SELECT report_id, storage_path, mime_type, original_filename
           FROM guard_shift_report_attachments
           WHERE report_id = ANY($1::bigint[])
           ORDER BY report_id, created_at`,
          [reportIds]
        )
        : { rows: [] };
      const reportById = new Map(reports.map((row) => [String(row.id), row]));
      const appendix = [];
      for (const attachment of attachments.rows) {
        const owner = reportById.get(String(attachment.report_id));
        if (!owner) continue;
        const data = await storage.download(attachment.storage_path);
        appendix.push(`<section class="photo-page"><h3>${escapeHtml(owner.report_number)} · ${escapeHtml(owner.site_name)} · ${escapeHtml(owner.guard_name)}</h3><p>${escapeHtml(attachment.original_filename || "Photographic evidence")}</p><img class="attachment" src="data:${attachment.mime_type};base64,${data.toString("base64")}" alt="Shift Report attachment"></section>`);
      }
      const metadata = `<div class="pdf-meta"><strong>Applied Filters:</strong> ${escapeHtml(describeFilters(req.query))}<br><strong>Generated At:</strong> ${escapeHtml(formatPdfDate(new Date(), req.auth.company_timezone || "Europe/Athens"))}<br><strong>Generated By:</strong> ${escapeHtml(req.auth.full_name || req.auth.username || `Admin ${req.auth.user_id}`)}</div>`;
      const table = `<table><thead><tr><th>Report</th><th>Created</th><th>Company</th><th>Site</th><th>Guard</th><th>Session</th><th>Shift</th><th>Category</th><th>Priority</th><th>Status</th><th>Message</th></tr></thead><tbody>${rows || '<tr><td colspan="11">No reports</td></tr>'}</tbody></table>`;
      const appendixHtml = appendix.length ? `<h2 class="appendix-title">Photographic Appendix</h2>${appendix.join("")}` : "";
      const html = pdfShell("Aegis Link · Shift Reports", `${metadata}${table}${appendixHtml}`);
      return sendPdf(res, puppeteer, html, `Aegis-Link-Shift-Reports-${new Date().toISOString().slice(0, 10)}.pdf`, pdfDisposition(req.query.disposition));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ status: "error", message: error.statusCode ? error.message : "Could not export Shift Reports" });
    }
  });

  router.get("/shift-reports/:id", requireAuth, async (req, res) => {
    try {
      const row = await scopedReport(req, req.params.id);
      const attachments = await pool.query(
        `SELECT id, original_filename, mime_type, file_size, created_at
         FROM guard_shift_report_attachments WHERE report_id=$1 AND company_id=$2 ORDER BY created_at`,
        [row.id, row.company_id]
      );
      const events = await pool.query(
        `SELECT id, event_type, actor_type, actor_id, created_at
         FROM guard_shift_report_events WHERE report_id=$1 AND company_id=$2 ORDER BY created_at`,
        [row.id, row.company_id]
      );
      return res.json({ status: "ok", report: { ...mapReport(row), attachments: attachments.rows, events: events.rows } });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ status: "error", message: error.statusCode ? error.message : "Could not load Shift Report" });
    }
  });

  async function transition(req, res, target) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = await scopedReport(req, req.params.id, client, true);
      if (row.status === target || (target === "READ" && row.status === "ACKNOWLEDGED")) {
        await client.query("ROLLBACK");
        return res.json({ status: "ok", report: mapReport(row) });
      }
      if ((target === "READ" && row.status !== "NEW") || (target === "ACKNOWLEDGED" && row.status !== "READ")) {
        throw badRequest(`Report cannot transition from ${row.status} to ${target}`, 409);
      }
      const isRead = target === "READ";
      const updated = await client.query(
        isRead
          ? `UPDATE guard_shift_reports SET status='READ', read_at=NOW(), read_by_admin_id=$1 WHERE id=$2 RETURNING *`
          : `UPDATE guard_shift_reports SET status='ACKNOWLEDGED', acknowledged_at=NOW(), acknowledged_by_admin_id=$1 WHERE id=$2 RETURNING *`,
        [req.auth.user_id, row.id]
      );
      await client.query(
        `INSERT INTO guard_shift_report_events (report_id, company_id, event_type, actor_type, actor_id)
         VALUES ($1,$2,$3,'ADMIN',$4)`,
        [row.id, row.company_id, isRead ? "SHIFT_REPORT_READ" : "SHIFT_REPORT_ACKNOWLEDGED", req.auth.user_id]
      );
      await client.query("COMMIT");
      return res.json({ status: "ok", report: mapReport({ ...row, ...updated.rows[0] }) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return res.status(error.statusCode || 500).json({ status: "error", message: error.statusCode ? error.message : "Could not update Shift Report" });
    } finally {
      client.release();
    }
  }

  router.patch("/shift-reports/:id/read", requireAuth, (req, res) => transition(req, res, "READ"));
  router.patch("/shift-reports/:id/acknowledge", requireAuth, (req, res) => transition(req, res, "ACKNOWLEDGED"));

  router.get("/shift-reports/:id/attachments/:attachmentId/url", requireAuth, async (req, res) => {
    try {
      const row = await scopedReport(req, req.params.id);
      const attachmentId = normalizePositiveInteger(req.params.attachmentId, "attachment id");
      const attachment = await pool.query(
        `SELECT id, storage_path FROM guard_shift_report_attachments
         WHERE id=$1 AND report_id=$2 AND company_id=$3 LIMIT 1`,
        [attachmentId, row.id, row.company_id]
      );
      if (!attachment.rows.length) throw badRequest("Attachment not found", 404);
      const expires_in = 300;
      const url = await storage.createSignedUrl(attachment.rows[0].storage_path, expires_in);
      return res.json({ status: "ok", url, expires_in });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ status: "error", message: error.statusCode ? error.message : "Could not open attachment" });
    }
  });

  router.get("/shift-reports/:id/report/pdf", requireAuth, async (req, res) => {
    try {
      const row = await scopedReport(req, req.params.id);
      const attachments = await pool.query(
        `SELECT storage_path, mime_type FROM guard_shift_report_attachments WHERE report_id=$1 AND company_id=$2 ORDER BY created_at`,
        [row.id, row.company_id]
      );
      const images = [];
      for (const attachment of attachments.rows) {
        const data = await storage.download(attachment.storage_path);
        images.push(`<img class="attachment" src="data:${attachment.mime_type};base64,${data.toString("base64")}" alt="Shift Report attachment">`);
      }
      const timezone = row.company_timezone || "Europe/Athens";
      const generatedBy = req.auth.full_name || req.auth.username || `Admin ${req.auth.user_id}`;
      const content = `<h2>${escapeHtml(row.report_number)}</h2><dl><dt>Company</dt><dd>${escapeHtml(row.company_name)}</dd><dt>Site</dt><dd>${escapeHtml(row.site_name)}</dd><dt>Guard</dt><dd>${escapeHtml(row.guard_name)}</dd><dt>Session ID</dt><dd>${escapeHtml(row.session_id)}</dd><dt>Created</dt><dd>${escapeHtml(formatPdfDate(row.created_at, timezone))}</dd><dt>Shift</dt><dd>${escapeHtml(formatPdfDate(row.scheduled_shift_start, timezone))} – ${escapeHtml(formatPdfDate(row.scheduled_shift_end, timezone))}</dd><dt>Category</dt><dd>${escapeHtml(row.category)}</dd><dt>Priority</dt><dd>${escapeHtml(row.priority)}</dd><dt>Status</dt><dd>${escapeHtml(row.status)}</dd><dt>Read</dt><dd>${escapeHtml(row.read_by_admin_name || "—")} · ${escapeHtml(formatPdfDate(row.read_at, timezone))}</dd><dt>Acknowledged</dt><dd>${escapeHtml(row.acknowledged_by_admin_name || "—")} · ${escapeHtml(formatPdfDate(row.acknowledged_at, timezone))}</dd><dt>Generated At</dt><dd>${escapeHtml(formatPdfDate(new Date(), timezone))}</dd><dt>Generated By</dt><dd>${escapeHtml(generatedBy)}</dd></dl><h3>Operational note</h3><p class="message">${escapeHtml(row.message)}</p>${images.length ? '<h3 class="appendix-title">Photographic Evidence</h3>' : ""}${images.join("")}`;
      return sendPdf(res, puppeteer, pdfShell("Aegis Link · Shift Report", content), `Aegis-Link-Shift-Report-${row.report_number}.pdf`, pdfDisposition(req.query.disposition));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ status: "error", message: error.statusCode ? error.message : "Could not export Shift Report" });
    }
  });

  router.use((error, _req, res, next) => {
    if (!(error instanceof multer.MulterError)) return next(error);
    return res.status(400).json({ status: "error", message: error.code === "LIMIT_FILE_SIZE" ? "Each image must be no larger than 10 MB" : `A maximum of ${MAX_ATTACHMENTS} images is allowed` });
  });
  return router;
}

function pdfShell(title, content) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:12mm}body{font:11px Arial;color:#15202b}h1{margin:0 0 14px}h2{margin-top:18px}table{border-collapse:collapse;width:100%;font-size:7.5px;table-layout:auto}th,td{border:1px solid #ccd5df;padding:5px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eef2f6}dl{display:grid;grid-template-columns:125px 1fr;gap:7px}dt{font-weight:bold}.message{white-space:pre-wrap;font-size:12px;line-height:1.5}.pdf-meta{margin:0 0 14px;padding:10px;background:#eef2f6;line-height:1.6}.appendix-title{page-break-before:always}.photo-page{page-break-before:always}.photo-page:first-of-type{page-break-before:auto}.photo-page h3,.photo-page p{margin:0 0 8px}.attachment{display:block;max-width:100%;max-height:680px;margin:14px auto;page-break-inside:avoid}</style></head><body><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}

async function sendPdf(res, puppeteer, html, filename, disposition = "attachment") {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${pdfDisposition(disposition)}; filename="${filename}"`);
    return res.send(pdf);
  } finally {
    await browser.close();
  }
}

module.exports = {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  MAX_ATTACHMENTS,
  MAX_FILE_SIZE,
  detectImageType,
  validateReportInput,
  buildAdminFilters,
  reportNumber,
  pdfDisposition,
  formatPdfDate,
  describeFilters,
  removeStorageWithRetry,
  pdfShell,
  sendPdf,
  createShiftReportsRouter,
};
