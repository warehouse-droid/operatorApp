import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { readArchivedPhoto, runPhotoArchive } from "./photo-archive-repository.js";

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const archiveRoot = path.join("/tmp", `mbbs-photo-archive-${suffix}`);
const successKey = `harness/operator/${suffix}/success.jpg`;
const retainedKey = `harness/driver/${suffix}/retained.jpg`;
const payloads = new Map([
  [successKey, Buffer.from("verified-local-photo-success")],
  [retainedKey, Buffer.from("verified-local-photo-retained")]
]);
const deleteChecks = [];
const rollback = await beginRollbackContext();

try {
  await rollback.run(async () => {
    const result = await runPhotoArchive({
      source: "harness",
      references: [`r2://${successKey}`, `r2://${retainedKey}`],
      archiveRoot,
      transport: {
        async download(key) {
          const bytes = payloads.get(key);
          assert.ok(bytes, `Unexpected download key ${key}`);
          return { bytes, contentType: "image/jpeg", etag: `etag-${key}` };
        },
        async delete(key) {
          const archived = await query(
            "SELECT local_path, byte_size, sha256 FROM photo_archive_objects WHERE r2_key = $1",
            [key]
          );
          assert.equal(archived.rowCount, 1, "Archive metadata must exist before R2 deletion.");
          const row = archived.rows[0];
          const local = await fs.readFile(path.join(archiveRoot, row.local_path));
          assert.equal(local.length, Number(row.byte_size), "Local file size must be verified before R2 deletion.");
          assert.deepEqual(local, payloads.get(key), "Local file content must match the downloaded R2 object.");
          deleteChecks.push(key);
          if (key === retainedKey) throw new Error("Simulated worker without delete support.");
          return { status: 204 };
        }
      }
    });

    assert.equal(result.status, "partial", "A remote deletion failure must report a partial run.");
    assert.equal(result.summary.archived, 2, "Both R2 objects must be archived locally.");
    assert.equal(result.summary.remoteDeleted, 1, "Only a confirmed successful R2 deletion may be marked deleted.");
    assert.equal(result.summary.deleteFailed, 1, "The rejected R2 deletion must remain pending.");
    assert.deepEqual(new Set(deleteChecks), new Set([successKey, retainedKey]), "Deletion must be attempted only after both local archives exist.");

    const rows = await query(
      `SELECT r2_key, r2_deleted_at, last_delete_error
         FROM photo_archive_objects
        WHERE r2_key = ANY($1::text[])
        ORDER BY r2_key`,
      [[successKey, retainedKey]]
    );
    const byKey = new Map(rows.rows.map((row) => [row.r2_key, row]));
    assert.ok(byKey.get(successKey)?.r2_deleted_at, "Successful remote deletion must be recorded.");
    assert.equal(byKey.get(successKey)?.last_delete_error, null, "Successful remote deletion must clear its error.");
    assert.equal(byKey.get(retainedKey)?.r2_deleted_at, null, "Failed remote deletion must never be marked deleted.");
    assert.match(byKey.get(retainedKey)?.last_delete_error || "", /without delete support/, "Remote deletion error must be retained for Admin visibility.");

    const successPhoto = await readArchivedPhoto(`r2://${successKey}`, { archiveRoot });
    const retainedPhoto = await readArchivedPhoto(`r2://${retainedKey}`, { archiveRoot });
    assert.equal(successPhoto?.available, true, "A photo must remain readable locally after R2 deletion.");
    assert.equal(successPhoto?.remoteDeleted, true, "Local preview metadata must report the deleted R2 copy.");
    assert.deepEqual(successPhoto?.bytes, payloads.get(successKey), "Archived success photo bytes must be readable.");
    assert.equal(retainedPhoto?.available, true, "A local photo must remain readable when R2 deletion fails.");
    assert.equal(retainedPhoto?.remoteDeleted, false, "Failed R2 deletion must retain remote fallback eligibility.");
    assert.deepEqual(retainedPhoto?.bytes, payloads.get(retainedKey), "Archived retained photo bytes must be readable.");

    const settings = await query("SELECT running, last_status, last_summary FROM photo_archive_settings WHERE id = 1");
    assert.equal(settings.rows[0]?.running, false, "Archive running state must clear after completion.");
    assert.equal(settings.rows[0]?.last_status, "partial", "Admin status must expose the partial deletion result.");
    assert.equal(Number(settings.rows[0]?.last_summary?.deleteFailed || 0), 1, "Admin summary must include remote deletion failures.");
  });

  console.log("Photo archive rollback harness passed.");
} finally {
  await rollback.rollback();
  await fs.rm(archiveRoot, { recursive: true, force: true });
  await closeDb();
}
