// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { canonicalSha256 } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import { authorizeMbtPhase3Capability } from "./phase3-authorization.js";
import { applyLocalRateCardDraft, normalizeLocalRateCardGraph } from "./rate-card-configuration-service.js";
import { parseRateCardCsvBundle } from "./rate-card-csv-import.js";

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

/** @param {string} code @param {string} message @param {number} [status] @returns {never} */
function importError(code, message, status = 400) {
  throw new MbtError({ status, code, message });
}

/** @param {unknown} value @param {string} code @param {string} message */
function requiredText(value, code, message) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return importError(code, message);
  }
  return normalized;
}

/** @param {unknown} value @param {string} code */
function sha256(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    return importError(code, "A SHA-256 rate-card import identity is required.");
  }
  return normalized;
}

/** @param {unknown} value @returns {MbtActor} */
function adminActor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return importError("MBT_ADMIN_REQUIRED", "Admin account required.", 403);
  }
  const actor = /** @type {{operatorId?: unknown, roles?: unknown}} */ (value);
  const operatorId = String(actor.operatorId ?? "").trim();
  const roles = Array.isArray(actor.roles)
    ? actor.roles.map((role) => String(role).trim()).filter(Boolean)
    : [];
  if (!operatorId || !roles.some((role) => role.toLowerCase() === "admin")) {
    return importError("MBT_ADMIN_REQUIRED", "Admin account required.", 403);
  }
  return { operatorId, roles };
}

/** @param {MbtActor} actor */
async function authorizeImport(actor) {
  const authorized = adminActor(actor);
  await authorizeMbtPhase3Capability({ capability: "masterData", pilotAuthorized: true });
  return authorized;
}

/** @param {string} rateCardCode @param {boolean} [forUpdate] */
async function targetRevision(rateCardCode, forUpdate = false) {
  const cards = await query(
    `SELECT rate_card_id::text, revision::int, active
       FROM mbt_rate_cards
      WHERE rate_card_code = $1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [rateCardCode]
  );
  /** @type {Record<string, any>[]} */
  let versions = [];
  if (cards.rowCount) {
    const result = await query(
      `SELECT rate_card_version_id::text, version_number, status, revision::int
         FROM mbt_rate_card_versions
        WHERE rate_card_id = $1
        ORDER BY version_number, rate_card_version_id`,
      [cards.rows[0].rate_card_id]
    );
    versions = result.rows;
  }
  return {
    exists: Boolean(cards.rowCount),
    token: canonicalSha256({
      rateCardCode,
      cards: cards.rows.map((/** @type {Record<string, any>} */ row) => ({
        rateCardId: String(row.rate_card_id),
        revision: Number(row.revision),
        active: row.active === true
      })),
      versions: versions.map((/** @type {Record<string, any>} */ row) => ({
        rateCardVersionId: String(row.rate_card_version_id),
        versionNumber: Number(row.version_number),
        status: String(row.status),
        revision: Number(row.revision)
      }))
    })
  };
}

/** @param {Record<string, any>} row */
function publicPreview(row) {
  return {
    schemaVersion: "mbt-rate-card-import-preview-v1",
    batchId: String(row.batch_id),
    status: String(row.status),
    fileHash: String(row.file_hash),
    normalizedHash: String(row.normalized_hash),
    targetRevisionToken: String(row.target_revision_token),
    summary: row.summary,
    graph: row.graph
  };
}

/**
 * Parse and persist normalized private preview evidence. No rate-card domain,
 * command, audit, outbox, or operational row is written here.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {unknown} input.files
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function previewRateCardCsvImport(input) {
  const actor = await authorizeImport(input.actor);
  const correlationId = requiredText(
    input.correlationId,
    "MBT_CORRELATION_ID_REQUIRED",
    "A correlation ID is required."
  );
  const requestId = requiredText(input.requestId, "MBT_REQUEST_ID_REQUIRED", "A request ID is required.");
  const parsed = await parseRateCardCsvBundle(input.files);
  const rateCardCode = String(parsed.graph.rateCard.rateCardCode);
  const target = await targetRevision(rateCardCode);
  if (target.exists) {
    return importError("MBT_RATE_CARD_EXISTS", "This rate-card code already exists.", 409);
  }
  const batchId = crypto.randomUUID();
  const safeMetadata = {
    correlationId,
    requestId,
    files: parsed.fileEvidence.map(({ key, fileName, byteLength, sha256: hash }) => ({
      key,
      fileName,
      byteLength,
      sha256: hash
    }))
  };
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_import_batches (
         batch_id, resource_kind, source_kind, source_account_id,
         source_filename, schema_version, file_hash, normalized_hash,
         target_revision_token, status, actor_operator_id, summary,
         warnings, safe_errors, safe_metadata
       ) VALUES (
         $1, 'rate_cards', 'csv', 'local', 'five-file-rate-card-csv',
         $2, $3, $4, $5, 'previewed', $6, $7::jsonb,
         '[]'::jsonb, '[]'::jsonb, $8::jsonb
       )`,
      [
        batchId,
        parsed.schemaVersion,
        parsed.fileHash,
        parsed.normalizedHash,
        target.token,
        actor.operatorId,
        JSON.stringify(parsed.summary),
        JSON.stringify(safeMetadata)
      ]
    );
    await query(
      `INSERT INTO mbt_import_staged_rows (
         batch_id, row_number, natural_key, normalized_payload, payload_hash
       ) VALUES ($1, 1, $2, $3::jsonb, $4)`,
      [batchId, rateCardCode, JSON.stringify(parsed.graph), parsed.normalizedHash]
    );
  });
  return publicPreview({
    batch_id: batchId,
    status: "previewed",
    file_hash: parsed.fileHash,
    normalized_hash: parsed.normalizedHash,
    target_revision_token: target.token,
    summary: parsed.summary,
    graph: parsed.graph
  });
}

/** @param {string} batchId @param {string} actorOperatorId */
async function lockedBatch(batchId, actorOperatorId) {
  const selected = await query(
    `SELECT * FROM mbt_import_batches
      WHERE batch_id = $1 AND resource_kind = 'rate_cards'
        AND actor_operator_id = $2
      FOR UPDATE`,
    [batchId, actorOperatorId]
  );
  if (!selected.rowCount) {
    return importError("MBT_IMPORT_BATCH_NOT_FOUND", "The rate-card import preview was not found.", 404);
  }
  return /** @type {Record<string, any>} */ (selected.rows[0]);
}

/** @param {string} batchId */
async function stagedGraph(batchId) {
  const selected = await query(
    `SELECT normalized_payload, payload_hash
       FROM mbt_import_staged_rows
      WHERE batch_id = $1 AND row_number = 1`,
    [batchId]
  );
  if (selected.rowCount !== 1) {
    return importError("MBT_IMPORT_BATCH_NOT_APPLICABLE", "The rate-card preview evidence is incomplete.", 409);
  }
  return {
    graph: normalizeLocalRateCardGraph(selected.rows[0].normalized_payload, { sourceKind: "csv" }),
    payloadHash: String(selected.rows[0].payload_hash)
  };
}

/** @param {unknown} error @returns {never} */
function translateTargetConflict(error) {
  const code = error && typeof error === "object"
    ? String(/** @type {{code?: unknown}} */ (error).code || "")
    : "";
  if (code === "23505" || code === "23503" || code === "23514") {
    return importError("MBT_IMPORT_TARGET_CONFLICT", "The rate-card target changed after preview.", 409);
  }
  throw error;
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.batchId
 * @param {string} input.normalizedHash
 * @param {string} input.targetRevisionToken
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {{afterDraftApply?: () => Promise<void> | void}} [input.hooks]
 */
export async function applyRateCardCsvImport(input) {
  const actor = await authorizeImport(input.actor);
  const batchId = requiredText(input.batchId, "MBT_IMPORT_BATCH_REQUIRED", "A preview batch ID is required.");
  const normalizedHash = sha256(input.normalizedHash, "MBT_IMPORT_HASH_MISMATCH");
  const targetRevisionToken = sha256(input.targetRevisionToken, "MBT_IMPORT_STALE_REVISION");
  const reason = String(input.reason || "").trim()
    || "Created local rate card from approved CSV import";
  return executeMbtCommand({
    actor,
    commandName: "mbt.import.rate_cards.apply",
    idempotencyKey: input.idempotencyKey,
    payload: { batchId, normalizedHash, targetRevisionToken, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const batch = await lockedBatch(batchId, actor.operatorId);
      if (String(batch.normalized_hash) !== normalizedHash) {
        return importError("MBT_IMPORT_HASH_MISMATCH", "The import content does not match its preview.", 409);
      }
      if (String(batch.target_revision_token) !== targetRevisionToken) {
        return importError("MBT_IMPORT_STALE_REVISION", "The import target identity does not match its preview.", 409);
      }
      if (String(batch.status) !== "previewed") {
        return importError("MBT_IMPORT_BATCH_NOT_APPLICABLE", "The rate-card preview cannot be applied.", 409);
      }
      if (new Date(String(batch.expires_at)).getTime() <= Date.now()) {
        return importError("MBT_IMPORT_BATCH_EXPIRED", "The rate-card preview expired.", 409);
      }
      const staged = await stagedGraph(batchId);
      if (staged.payloadHash !== normalizedHash || canonicalSha256(staged.graph) !== normalizedHash) {
        return importError("MBT_IMPORT_HASH_MISMATCH", "The staged rate-card graph no longer matches its preview.", 409);
      }
      const rateCardCode = String(staged.graph.rateCard.rateCardCode);
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mbt:rate-card-import:${rateCardCode}`]);
      const target = await targetRevision(rateCardCode, true);
      if (target.token !== targetRevisionToken) {
        return importError("MBT_IMPORT_STALE_REVISION", "The rate-card target changed after preview.", 409);
      }
      const draft = await applyLocalRateCardDraft({
        actor,
        sourceKind: "csv",
        graph: staged.graph,
        reason,
        idempotencyKey: `rate-card-import:${batchId}:draft`,
        correlationId: input.correlationId,
        requestId: input.requestId
      }).catch(translateTargetConflict);
      await input.hooks?.afterDraftApply?.();
      const version = /** @type {Record<string, any>} */ (draft.body.version);
      const body = {
        schemaVersion: "mbt-rate-card-import-apply-v1",
        batchId,
        status: "applied",
        normalizedHash,
        version
      };
      await query(
        `UPDATE mbt_import_batches
            SET status = 'applied', applied_idempotency_key = $2,
                apply_reason = $3, applied_at = clock_timestamp(),
                revision = revision + 1, updated_at = now()
          WHERE batch_id = $1`,
        [batchId, input.idempotencyKey, reason]
      );
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.import.rate_cards.applied",
          entityType: "mbt_import_batch",
          entityId: batchId,
          beforeState: { status: "previewed", normalizedHash, targetRevisionToken },
          afterState: { status: "applied", normalizedHash, rateCardVersionId: version.rateCardVersionId },
          reason,
          revisionBefore: Number(batch.revision),
          revisionAfter: Number(batch.revision) + 1,
          source: "csv"
        }
      };
    }
  });
}

export const rateCardCsvImportService = Object.freeze({
  previewRateCardCsvImport,
  applyRateCardCsvImport
});
