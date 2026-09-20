const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

function createSupabaseGuardReportsStorage({
  env = process.env,
  createClientImpl = createClient,
} = {}) {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = env.SUPABASE_GUARD_REPORTS_BUCKET;

  if (!url || !serviceRoleKey || !bucket) {
    throw new Error(
      "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_GUARD_REPORTS_BUCKET are required"
    );
  }

  const client = createClientImpl(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });

  return Object.freeze({
    bucket,

    async upload(storagePath, buffer, mimeType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(storagePath, buffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (error) throw error;
      return { storagePath };
    },

    async remove(storagePaths) {
      if (!Array.isArray(storagePaths) || storagePaths.length === 0) return;
      const { error } = await client.storage.from(bucket).remove(storagePaths);
      if (error) throw error;
    },

    async createSignedUrl(storagePath, expiresInSeconds = 300) {
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(storagePath, expiresInSeconds);

      if (error) throw error;
      if (!data?.signedUrl) throw new Error("Supabase did not return a signed URL");
      return data.signedUrl;
    },

    async download(storagePath) {
      const { data, error } = await client.storage.from(bucket).download(storagePath);
      if (error) throw error;
      if (!data) throw new Error("Supabase did not return attachment data");
      return Buffer.from(await data.arrayBuffer());
    },
  });
}

module.exports = { createSupabaseGuardReportsStorage };
