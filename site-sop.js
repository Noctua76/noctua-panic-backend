const PRIVATE_BUCKET = "aegis-site-sops-private";
const crypto = require("node:crypto");

function legacyPublicObject(url, site, supabaseUrl, bucket) {
  if (!url || !supabaseUrl) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(supabaseUrl).origin || parsed.search || parsed.hash) return null;
    const prefix = `/storage/v1/object/public/${bucket}/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const path = decodeURIComponent(parsed.pathname.slice(prefix.length));
    if (!path.startsWith(`sites/site-${site.id}/`) &&
        !path.startsWith(`companies/company-${site.company_id}/sites/site-${site.id}/`)) return null;
    return path;
  } catch { return null; }
}

function registerSiteSopRoutes({ app, pool, supabase, requireAuth, upload }) {
  async function privateBucket() {
    const { data, error } = await supabase.storage.getBucket(PRIVATE_BUCKET);
    if (error && !/not found/i.test(error.message || "")) throw error;
    if (!data) {
      const created = await supabase.storage.createBucket(PRIVATE_BUCKET, {
        public: false,
        fileSizeLimit: 10 * 1024 * 1024,
        allowedMimeTypes: ["application/pdf"],
      });
      if (created.error && !/already exists/i.test(created.error.message || "")) throw created.error;
    }
    const verified = await supabase.storage.getBucket(PRIVATE_BUCKET);
    if (verified.error || !verified.data || verified.data.public !== false) {
      throw new Error("Private SOP storage is unavailable");
    }
    return supabase.storage.from(PRIVATE_BUCKET);
  }

  async function scopedSite(req) {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const result = await pool.query(
      `SELECT id, company_id, sop_storage_path, sop_file_url FROM sites WHERE id=$1 AND company_id=$2`,
      [id, req.auth.effective_company_id]
    );
    return result.rows[0] || null;
  }

  app.get("/settings/sites/:id/sop/file", requireAuth, async (req, res) => {
    try {
      const site = await scopedSite(req);
      if (!site || !site.sop_storage_path) return res.status(404).json({ status: "error", message: "SOP not found" });
      const bucket = await privateBucket();
      const { data, error } = await bucket.download(site.sop_storage_path);
      if (error || !data) throw error || new Error("SOP download failed");
      res.set("Content-Type", "application/pdf");
      res.set("Cache-Control", "private, no-store");
      res.set("X-Content-Type-Options", "nosniff");
      return res.send(Buffer.from(await data.arrayBuffer()));
    } catch (error) {
      console.error("Private SOP download failed", error);
      return res.status(503).json({ status: "error", message: "SOP temporarily unavailable" });
    }
  });

  app.post("/settings/sites/:id/sop/upload", requireAuth, upload.single("sop_file"), async (req, res) => {
    try {
      const site = await scopedSite(req);
      if (!site) return res.status(404).json({ status: "error", message: "Site not found" });
      if (!req.file || req.file.mimetype !== "application/pdf" ||
          req.file.buffer.subarray(0, 5).toString() !== "%PDF-") {
        return res.status(400).json({ status: "error", message: "A PDF file is required" });
      }
      const bucket = await privateBucket();
      const path = `companies/company-${site.company_id}/sites/site-${site.id}/sop-${Date.now()}-${crypto.randomUUID()}.pdf`;
      const { error } = await bucket.upload(path, req.file.buffer, { contentType: "application/pdf", upsert: false });
      if (error) throw error;
      const verified = await bucket.download(path);
      if (verified.error || !verified.data ||
          crypto.createHash("sha256").update(Buffer.from(await verified.data.arrayBuffer())).digest("hex") !==
          crypto.createHash("sha256").update(req.file.buffer).digest("hex")) {
        await bucket.remove([path]).catch(() => {});
        throw new Error("Private SOP copy failed integrity verification");
      }
      let updated;
      try {
        updated = await pool.query(
          `UPDATE sites SET sop_storage_path=$1, sop_updated_at=NOW()
           WHERE id=$2 AND company_id=$3 RETURNING id, sop_updated_at`,
          [path, site.id, site.company_id]
        );
      } catch (error) {
        await bucket.remove([path]).catch(() => {});
        throw error;
      }
      const legacyBucket = process.env.SUPABASE_SOP_BUCKET || "aegis-sop-files";
      const legacyPath = legacyPublicObject(site.sop_file_url, site, process.env.SUPABASE_URL, legacyBucket);
      let publicCopyRemoved = false;
      if (legacyPath) {
        try {
          const old = await supabase.storage.from(legacyBucket).download(legacyPath);
          if (!old.error && old.data &&
              crypto.createHash("sha256").update(Buffer.from(await old.data.arrayBuffer())).digest("hex") ===
              crypto.createHash("sha256").update(req.file.buffer).digest("hex")) {
            const removal = await supabase.storage.from(legacyBucket).remove([legacyPath]);
            if (!removal.error) publicCopyRemoved = true;
          }
        } catch (cleanupError) {
          console.error("Legacy public SOP cleanup failed", cleanupError);
        }
      }
      if (publicCopyRemoved || !site.sop_file_url) {
        await pool.query(`UPDATE sites SET sop_file_url=NULL WHERE id=$1 AND company_id=$2 AND sop_storage_path=$3`,
          [site.id, site.company_id, path]);
      }
      return res.json({ status: "ok", site: updated.rows[0], sop_available: true,
        public_copy_removed: publicCopyRemoved, legacy_public_copy_pending: Boolean(site.sop_file_url && !publicCopyRemoved) });
    } catch (error) {
      console.error("Private SOP upload failed", error);
      return res.status(503).json({ status: "error", message: "Private SOP storage unavailable" });
    }
  });
}

module.exports = { registerSiteSopRoutes, legacyPublicObject, PRIVATE_BUCKET };
