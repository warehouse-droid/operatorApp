import { config } from "./config.js";
import { query } from "./db.js";

const CACHE_TTL_MS = 2000;
let cachedSettings = null;
let cachedAt = 0;

function publicSettings(row = {}) {
  return {
    enabled: row.public_access_enabled === true,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null
  };
}

async function rawSalesPortalSettings() {
  const legacyEnabled = Boolean(config.sales?.publicAccessEnabled);
  await query(
    `INSERT INTO sales_portal_settings (id, public_access_enabled, updated_by)
     VALUES (1, $1, 'legacy_environment')
     ON CONFLICT (id) DO NOTHING`,
    [legacyEnabled]
  );
  await query(
    `UPDATE sales_portal_settings
        SET public_access_enabled = $1,
            updated_by = 'legacy_environment',
            updated_at = now()
      WHERE id = 1
        AND public_access_enabled IS NULL`,
    [legacyEnabled]
  );
  const result = await query(
    `SELECT public_access_enabled, updated_by, updated_at
       FROM sales_portal_settings
      WHERE id = 1`
  );
  return result.rows[0];
}

export async function getSalesPortalSettings({ fresh = false } = {}) {
  if (!fresh && cachedSettings && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSettings;
  cachedSettings = publicSettings(await rawSalesPortalSettings());
  cachedAt = Date.now();
  return cachedSettings;
}

export async function isPublicSalesAccessEnabled() {
  return (await getSalesPortalSettings()).enabled;
}

export async function updateSalesPortalSettings(input = {}, operatorId = null) {
  if (typeof input.enabled !== "boolean") {
    const error = new Error("Public Sales access must be enabled or disabled.");
    error.status = 400;
    throw error;
  }
  const result = await query(
    `INSERT INTO sales_portal_settings (
       id, public_access_enabled, updated_by, updated_at
     ) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE
       SET public_access_enabled = EXCLUDED.public_access_enabled,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING public_access_enabled, updated_by, updated_at`,
    [input.enabled, operatorId]
  );
  cachedSettings = publicSettings(result.rows[0]);
  cachedAt = Date.now();
  return cachedSettings;
}
