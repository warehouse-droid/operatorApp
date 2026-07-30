import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { createPhotoDeleteToken, createPhotoReadToken, normalizeR2Key } from "./photo-upload.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PHOTO_ARCHIVE_ROOT = path.resolve(dirname, "../data/photo-archive");
const ARCHIVE_MODES = new Set(["off", "manual", "auto"]);
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 43200;

const PHOTO_REFERENCE_TARGETS = [
  { table: "operator_load_records", column: "photo_data_url", kind: "text" },
  { table: "operator_load_records", column: "photo_data_urls", kind: "jsonb" },
  { table: "customer_pickup_load_records", column: "photo_data_url", kind: "text" },
  { table: "customer_pickup_load_records", column: "photo_data_urls", kind: "jsonb" },
  { table: "delivery_fulfillment_records", column: "photo_data_url", kind: "text" },
  { table: "delivery_fulfillment_records", column: "photo_data_urls", kind: "jsonb" },
  { table: "receiving_receipt_records", column: "photo_data_urls", kind: "jsonb" },
  { table: "local_co_receipt_records", column: "photo_data_urls", kind: "jsonb" },
  { table: "driver_day_records", column: "pre_dvir_photo_data_urls", kind: "jsonb" },
  { table: "driver_day_records", column: "post_dvir_photo_data_urls", kind: "jsonb" },
  { table: "driver_job_records", column: "photo_data_urls", kind: "jsonb" },
  { table: "return_drafts", column: "payload", kind: "jsonb_deep" },
  { table: "return_photos", column: "photo_reference", kind: "text" }
];

let activeArchiveRun = null;

function cleanMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!ARCHIVE_MODES.has(mode)) throw new Error("Photo archive mode must be Off, Manual, or Auto.");
  return mode;
}

function cleanIntervalMinutes(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    throw new Error("Photo archive interval must be between 5 minutes and 30 days.");
  }
  return minutes;
}

function publicSettings(row = {}) {
  const intervalMinutes = Number(row.interval_minutes || 1440);
  const lastFinishedAt = row.last_finished_at || null;
  return {
    mode: row.mode || "off",
    intervalMinutes,
    running: row.running === true || Boolean(activeArchiveRun),
    lastStartedAt: row.last_started_at || null,
    lastFinishedAt,
    lastStatus: row.last_status || "idle",
    lastSource: row.last_source || "",
    lastError: row.last_error || "",
    lastSummary: row.last_summary || {},
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null,
    nextRunAt: row.mode === "auto" && lastFinishedAt
      ? new Date(new Date(lastFinishedAt).getTime() + intervalMinutes * 60000).toISOString()
      : null
  };
}

async function rawPhotoArchiveSettings() {
  const result = await query("SELECT * FROM photo_archive_settings WHERE id = 1");
  if (!result.rowCount) {
    const inserted = await query("INSERT INTO photo_archive_settings (id) VALUES (1) RETURNING *");
    return inserted.rows[0];
  }
  return result.rows[0];
}

async function availablePhotoTargets() {
  const result = await query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          SELECT target.table_name, target.column_name
            FROM unnest($1::text[], $2::text[]) target(table_name, column_name)
        )`,
    [
      PHOTO_REFERENCE_TARGETS.map((target) => target.table),
      PHOTO_REFERENCE_TARGETS.map((target) => target.column)
    ]
  );
  return new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
}

export async function collectReferencedR2Keys({ includeTrackedPending = false } = {}) {
  const available = await availablePhotoTargets();
  const keys = new Set();
  for (const target of PHOTO_REFERENCE_TARGETS) {
    if (!available.has(`${target.table}.${target.column}`)) continue;
    const result = target.kind === "text"
      ? await query(
          `SELECT DISTINCT ${target.column} AS photo_ref
             FROM ${target.table}
            WHERE ${target.column} LIKE 'r2://%'`
        )
      : target.kind === "jsonb_deep"
        ? await query(
          `SELECT DISTINCT photo_value #>> '{}' AS photo_ref
             FROM ${target.table}
             CROSS JOIN LATERAL jsonb_path_query(
               COALESCE(${target.column}, '{}'::jsonb),
               '$.** ? (@.type() == "string")'
             ) photo(photo_value)
            WHERE photo_value #>> '{}' LIKE 'r2://%'`
        )
        : await query(
          `SELECT DISTINCT photo_ref
             FROM ${target.table}
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(COALESCE(${target.column}, '[]'::jsonb)) = 'array'
                   THEN COALESCE(${target.column}, '[]'::jsonb)
                 ELSE '[]'::jsonb
               END
             ) photo(photo_ref)
            WHERE photo_ref LIKE 'r2://%'`
        );
    for (const row of result.rows) {
      const key = normalizeR2Key(row.photo_ref);
      if (key) keys.add(key);
    }
  }
  if (includeTrackedPending) {
    const tracked = await query("SELECT r2_key FROM photo_archive_objects WHERE r2_deleted_at IS NULL");
    for (const row of tracked.rows) {
      const key = normalizeR2Key(row.r2_key);
      if (key) keys.add(key);
    }
  }
  return [...keys].sort();
}

function archiveRelativePath(r2Key) {
  const hash = crypto.createHash("sha256").update(r2Key).digest("hex");
  return path.join(hash.slice(0, 2), hash.slice(2, 4), `${hash}.blob`);
}

function archiveAbsolutePath(relativePath, archiveRoot = DEFAULT_PHOTO_ARCHIVE_ROOT) {
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(root, String(relativePath || ""));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid local photo archive path.");
  return resolved;
}

async function archiveDiskStats(archiveRoot = DEFAULT_PHOTO_ARCHIVE_ROOT) {
  await fs.mkdir(archiveRoot, { recursive: true });
  try {
    const stats = await fs.statfs(archiveRoot);
    return {
      localDiskTotalBytes: Number(stats.blocks) * Number(stats.bsize),
      localDiskAvailableBytes: Number(stats.bavail) * Number(stats.bsize)
    };
  } catch {
    return { localDiskTotalBytes: 0, localDiskAvailableBytes: 0 };
  }
}

export async function getPhotoArchiveSettings({ archiveRoot = DEFAULT_PHOTO_ARCHIVE_ROOT, includeStats = true } = {}) {
  const settings = publicSettings(await rawPhotoArchiveSettings());
  if (!includeStats) return settings;
  const referencedKeys = await collectReferencedR2Keys();
  const tracked = referencedKeys.length
    ? await query(
        `SELECT r2_key, byte_size, r2_deleted_at
           FROM photo_archive_objects
          WHERE r2_key = ANY($1::text[])`,
        [referencedKeys]
      )
    : { rows: [] };
  const trackedByKey = new Map(tracked.rows.map((row) => [row.r2_key, row]));
  const totals = await query(
    `SELECT COUNT(*)::int AS archived_count,
            COUNT(*) FILTER (WHERE r2_deleted_at IS NOT NULL)::int AS remote_deleted_count,
            COALESCE(SUM(byte_size), 0)::bigint AS local_bytes
       FROM photo_archive_objects`
  );
  const total = totals.rows[0] || {};
  return {
    ...settings,
    stats: {
      referencedR2Count: referencedKeys.length,
      referencedArchivedCount: referencedKeys.filter((key) => trackedByKey.has(key)).length,
      referencedRemoteDeletedCount: referencedKeys.filter((key) => trackedByKey.get(key)?.r2_deleted_at).length,
      referencedPendingCount: referencedKeys.filter((key) => !trackedByKey.get(key)?.r2_deleted_at).length,
      archivedCount: Number(total.archived_count || 0),
      remoteDeletedCount: Number(total.remote_deleted_count || 0),
      localBytes: Number(total.local_bytes || 0),
      ...(await archiveDiskStats(archiveRoot))
    }
  };
}

export async function updatePhotoArchiveSettings(input = {}, operatorId = null) {
  const current = await rawPhotoArchiveSettings();
  const mode = Object.hasOwn(input, "mode") ? cleanMode(input.mode) : current.mode;
  const intervalMinutes = Object.hasOwn(input, "intervalMinutes")
    ? cleanIntervalMinutes(input.intervalMinutes)
    : Number(current.interval_minutes || 1440);
  const result = await query(
    `UPDATE photo_archive_settings
        SET mode = $1, interval_minutes = $2, updated_by = $3, updated_at = now()
      WHERE id = 1
      RETURNING *`,
    [mode, intervalMinutes, operatorId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "admin",
    action: "photo_archive.settings_update",
    details: { mode, intervalMinutes }
  });
  return getPhotoArchiveSettings();
}

async function defaultDownloadR2Object(r2Key) {
  const ticket = createPhotoReadToken({
    actor: { id: "photo-archive", role: "system" },
    key: r2Key,
    options: { ttlMinutes: 30 }
  });
  const response = await fetch(ticket.objectUrl, {
    headers: { Authorization: `Bearer ${ticket.token}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`R2 download failed (${response.status}): ${body || response.statusText}`);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: String(response.headers.get("content-type") || "application/octet-stream").split(";")[0],
    etag: response.headers.get("etag") || ""
  };
}

async function defaultDeleteR2Object(r2Key) {
  const ticket = createPhotoDeleteToken({
    actor: { id: "photo-archive", role: "system" },
    key: r2Key,
    options: { ttlMinutes: 30 }
  });
  const response = await fetch(ticket.objectUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ticket.token}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`R2 delete failed (${response.status}): ${body || response.statusText}`);
  }
  return { status: response.status };
}

async function findArchiveRow(r2Key) {
  const result = await query("SELECT * FROM photo_archive_objects WHERE r2_key = $1", [r2Key]);
  return result.rows[0] || null;
}

async function verifyLocalArchive(row, archiveRoot = DEFAULT_PHOTO_ARCHIVE_ROOT) {
  if (!row?.local_path) return null;
  try {
    const absolutePath = archiveAbsolutePath(row.local_path, archiveRoot);
    const bytes = await fs.readFile(absolutePath);
    if (bytes.length !== Number(row.byte_size)) return null;
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== row.sha256) return null;
    return { absolutePath, bytes, sha256 };
  } catch {
    return null;
  }
}

async function writeVerifiedArchive(r2Key, downloaded, archiveRoot = DEFAULT_PHOTO_ARCHIVE_ROOT) {
  const bytes = Buffer.isBuffer(downloaded?.bytes) ? downloaded.bytes : Buffer.from(downloaded?.bytes || []);
  if (!bytes.length) throw new Error("Downloaded R2 object is empty.");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const localPath = archiveRelativePath(r2Key);
  const absolutePath = archiveAbsolutePath(localPath, archiveRoot);
  const tempPath = `${absolutePath}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, bytes, { flag: "wx" });
    const written = await fs.readFile(tempPath);
    const writtenHash = crypto.createHash("sha256").update(written).digest("hex");
    if (written.length !== bytes.length || writtenHash !== sha256) {
      throw new Error("Local archive verification failed after writing the file.");
    }
    await fs.rename(tempPath, absolutePath);
  } finally {
    await fs.unlink(tempPath).catch(() => null);
  }
  const stat = await fs.stat(absolutePath);
  if (stat.size !== bytes.length) throw new Error("Local archive size verification failed.");
  return {
    localPath,
    absolutePath,
    byteSize: bytes.length,
    sha256,
    contentType: String(downloaded.contentType || "application/octet-stream").slice(0, 160),
    etag: String(downloaded.etag || "").slice(0, 500)
  };
}

async function saveArchiveRecord(r2Key, archived) {
  const result = await query(
    `INSERT INTO photo_archive_objects (
       r2_key, local_path, content_type, byte_size, sha256, etag,
       archived_at, verified_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now())
     ON CONFLICT (r2_key) DO UPDATE SET
       local_path = EXCLUDED.local_path,
       content_type = EXCLUDED.content_type,
       byte_size = EXCLUDED.byte_size,
       sha256 = EXCLUDED.sha256,
       etag = EXCLUDED.etag,
       archived_at = now(),
       verified_at = now(),
       updated_at = now()
     RETURNING *`,
    [r2Key, archived.localPath, archived.contentType, archived.byteSize, archived.sha256, archived.etag]
  );
  return result.rows[0];
}

async function markRemoteDeleted(r2Key) {
  await query(
    `UPDATE photo_archive_objects
        SET r2_deleted_at = now(), delete_attempts = delete_attempts + 1,
            last_delete_error = null, last_delete_attempt_at = now(), updated_at = now()
      WHERE r2_key = $1`,
    [r2Key]
  );
}

async function markRemoteDeleteFailure(r2Key, error) {
  await query(
    `UPDATE photo_archive_objects
        SET delete_attempts = delete_attempts + 1,
            last_delete_error = $2, last_delete_attempt_at = now(), updated_at = now()
      WHERE r2_key = $1`,
    [r2Key, String(error?.message || error || "R2 deletion failed.").slice(0, 2000)]
  );
}

function archiveSummaryError(summary) {
  const parts = [];
  if (summary.archiveFailed) parts.push(`${summary.archiveFailed} local archive failure(s)`);
  if (summary.deleteFailed) parts.push(`${summary.deleteFailed} R2 deletion failure(s)`);
  return parts.join("; ");
}

export function isPhotoArchiveRunning() {
  return Boolean(activeArchiveRun);
}

export async function runPhotoArchive({
  source = "manual",
  actorOperatorId = null,
  references = null,
  archiveRoot = DEFAULT_PHOTO_ARCHIVE_ROOT,
  transport = {}
} = {}) {
  if (activeArchiveRun) return { skipped: true, reason: "photo_archive_running", runId: activeArchiveRun.id };
  const run = { id: crypto.randomUUID(), source, startedAt: new Date().toISOString() };
  activeArchiveRun = run;
  await query(
    `UPDATE photo_archive_settings
        SET running = true, last_started_at = $1, last_source = $2,
            last_status = 'running', last_error = null, updated_by = $3, updated_at = now()
      WHERE id = 1`,
    [run.startedAt, source, actorOperatorId]
  );
  const summary = {
    runId: run.id,
    discovered: 0,
    archived: 0,
    reusedLocal: 0,
    alreadyDeleted: 0,
    remoteDeleted: 0,
    archiveFailed: 0,
    deleteFailed: 0,
    bytesArchived: 0,
    failures: []
  };
  try {
    const normalizedReferences = references === null
      ? await collectReferencedR2Keys({ includeTrackedPending: true })
      : [...new Set((references || []).map(normalizeR2Key).filter(Boolean))];
    summary.discovered = normalizedReferences.length;
    const download = transport.download || defaultDownloadR2Object;
    const remove = transport.delete || defaultDeleteR2Object;
    await fs.mkdir(archiveRoot, { recursive: true });

    for (const r2Key of normalizedReferences) {
      let row = await findArchiveRow(r2Key);
      let verified = await verifyLocalArchive(row, archiveRoot);
      if (row?.r2_deleted_at && verified) {
        summary.alreadyDeleted += 1;
        continue;
      }
      if (!verified) {
        try {
          const downloaded = await download(r2Key);
          const archived = await writeVerifiedArchive(r2Key, downloaded, archiveRoot);
          row = await saveArchiveRecord(r2Key, archived);
          verified = await verifyLocalArchive(row, archiveRoot);
          if (!verified) throw new Error("Local archive could not be verified before R2 deletion.");
          summary.archived += 1;
          summary.bytesArchived += archived.byteSize;
        } catch (error) {
          summary.archiveFailed += 1;
          summary.failures.push({ key: r2Key, stage: "archive", error: error.message });
          continue;
        }
      } else {
        summary.reusedLocal += 1;
      }
      try {
        await remove(r2Key);
        await markRemoteDeleted(r2Key);
        summary.remoteDeleted += 1;
      } catch (error) {
        await markRemoteDeleteFailure(r2Key, error);
        summary.deleteFailed += 1;
        summary.failures.push({ key: r2Key, stage: "delete", error: error.message });
      }
    }

    const finishedAt = new Date().toISOString();
    const lastStatus = summary.archiveFailed || summary.deleteFailed ? "partial" : "success";
    const lastError = archiveSummaryError(summary);
    await query(
      `UPDATE photo_archive_settings
          SET running = false, last_finished_at = $1, last_status = $2,
              last_error = $3, last_summary = $4::jsonb, updated_at = now()
        WHERE id = 1`,
      [finishedAt, lastStatus, lastError, JSON.stringify(summary)]
    );
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "photo_archive",
      action: "photo_archive.run",
      details: { source, ...summary, failures: summary.failures.slice(0, 25) }
    });
    return { skipped: false, startedAt: run.startedAt, finishedAt, status: lastStatus, summary };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await query(
      `UPDATE photo_archive_settings
          SET running = false, last_finished_at = $1, last_status = 'failed',
              last_error = $2, last_summary = $3::jsonb, updated_at = now()
        WHERE id = 1`,
      [finishedAt, error.message, JSON.stringify(summary)]
    ).catch(() => null);
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "photo_archive",
      action: "photo_archive.run_failed",
      details: { source, error: error.message, summary }
    }).catch(() => null);
    throw error;
  } finally {
    if (activeArchiveRun?.id === run.id) activeArchiveRun = null;
  }
}

export async function readArchivedPhoto(reference, { archiveRoot = DEFAULT_PHOTO_ARCHIVE_ROOT } = {}) {
  const r2Key = normalizeR2Key(reference);
  if (!r2Key) return null;
  const row = await findArchiveRow(r2Key);
  if (!row) return null;
  const verified = await verifyLocalArchive(row, archiveRoot);
  if (!verified) {
    return { found: true, available: false, remoteDeleted: Boolean(row.r2_deleted_at), r2Key };
  }
  return {
    found: true,
    available: true,
    remoteDeleted: Boolean(row.r2_deleted_at),
    r2Key,
    bytes: verified.bytes,
    contentType: row.content_type || "application/octet-stream",
    byteSize: Number(row.byte_size || verified.bytes.length),
    sha256: row.sha256
  };
}

export async function recoverInterruptedPhotoArchive() {
  if (activeArchiveRun) return;
  await query(
    `UPDATE photo_archive_settings
        SET running = false, last_finished_at = now(), last_status = 'interrupted',
            last_error = 'Server restarted before photo archival completed. The next run will safely resume.',
            updated_at = now()
      WHERE id = 1 AND running = true`
  );
}

export async function photoArchiveAutoTick() {
  try {
    if (activeArchiveRun) return { skipped: true, reason: "photo_archive_running" };
    const settings = publicSettings(await rawPhotoArchiveSettings());
    if (settings.mode !== "auto") return { skipped: true, reason: "not_auto" };
    const lastAnchor = settings.lastStatus === "interrupted"
      ? null
      : settings.lastFinishedAt || settings.lastStartedAt;
    const dueAt = lastAnchor ? new Date(lastAnchor).getTime() + settings.intervalMinutes * 60000 : 0;
    if (dueAt && Date.now() < dueAt) return { skipped: true, reason: "not_due", dueAt: new Date(dueAt).toISOString() };
    return runPhotoArchive({ source: "auto" });
  } catch (error) {
    console.error("Automatic photo archive failed:", error.message);
    return { skipped: false, failed: true, error: error.message };
  }
}
