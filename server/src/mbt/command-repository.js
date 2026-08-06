// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "../db.js";
import { insertMbtAuditEvent } from "./audit-repository.js";
import { compareCommandPayload, hashCommandPayload } from "./idempotency.js";
import { configuredMbtSecretValues, redactMbtValue } from "./redaction.js";

/**
 * @typedef {import("./audit-repository.js").MbtActor} MbtActor
 * @typedef {import("./audit-repository.js").MbtAuditMutation} MbtAuditMutation
 */

/**
 * @typedef {object} MbtCommandMutationResult
 * @property {number} status
 * @property {Record<string, unknown>} body
 * @property {MbtAuditMutation} audit
 */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`A command ${label} is required.`);
  }
  return normalized;
}

/** @param {readonly string[] | undefined} roles */
function normalizedRoles(roles) {
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.map((role) => String(role).trim()).filter(Boolean);
}

/** @param {unknown} value @param {string} label */
function requiredEvidence(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`A command audit ${label} is required.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requiredRevision(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`A command audit ${label} is required.`);
  }
  return Number(value);
}

/**
 * @param {MbtCommandMutationResult} result
 * @returns {MbtCommandMutationResult}
 */
function validateMutationResult(result) {
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 299) {
    throw new TypeError("A successful command HTTP status is required.");
  }
  if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) {
    throw new TypeError("A successful command response object is required.");
  }
  if (!result.audit || typeof result.audit !== "object") {
    throw new TypeError("A successful command audit event is required.");
  }
  requiredEvidence(result.audit.beforeState, "before state");
  requiredEvidence(result.audit.afterState, "after state");
  requiredText(result.audit.reason, "audit reason");
  requiredRevision(result.audit.revisionBefore, "revision before");
  requiredRevision(result.audit.revisionAfter, "revision after");
  return result;
}

/**
 * Execute one privileged MBT mutation with exact idempotency and atomic audit.
 * The advisory lock serializes the durable command identity across independent
 * application clients; the unique receipt remains the database backstop.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.commandName
 * @param {string} input.idempotencyKey
 * @param {unknown} input.payload
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {() => Promise<MbtCommandMutationResult>} input.mutation
 * @param {readonly string[]} [input.secretValues]
 * @returns {Promise<{status: number, body: Record<string, unknown>, replayed: boolean}>}
 */
export async function executeMbtCommand({
  actor,
  commandName,
  idempotencyKey,
  payload,
  correlationId,
  requestId,
  mutation,
  secretValues = []
}) {
  const actorOperatorId = requiredText(actor?.operatorId, "actor operator ID");
  const actorRoles = normalizedRoles(actor?.roles);
  if (actorRoles.length === 0) {
    throw new TypeError("A command actor roles list is required.");
  }
  const normalizedCommandName = requiredText(commandName, "name");
  const normalizedIdempotencyKey = requiredText(idempotencyKey, "idempotency key");
  const normalizedCorrelationId = requiredText(correlationId, "correlation ID");
  const normalizedRequestId = requiredText(requestId, "request ID");
  if (typeof mutation !== "function") {
    throw new TypeError("A command mutation callback is required.");
  }
  const payloadHash = hashCommandPayload(payload);
  const protectedSecretValues = [...new Set([
    ...configuredMbtSecretValues(),
    ...secretValues.map((value) => String(value || "")).filter(Boolean)
  ])];
  const lockIdentity = JSON.stringify([
    actorOperatorId,
    normalizedCommandName,
    normalizedIdempotencyKey
  ]);

  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockIdentity]);
    const existing = await query(
      `SELECT canonical_payload_hash, http_status, response_body
         FROM mbt_command_receipts
        WHERE actor_operator_id = $1
          AND command_name = $2
          AND idempotency_key = $3`,
      [actorOperatorId, normalizedCommandName, normalizedIdempotencyKey]
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      compareCommandPayload(receipt.canonical_payload_hash, payload);
      return {
        status: Number(receipt.http_status),
        body: receipt.response_body,
        replayed: true
      };
    }

    const result = validateMutationResult(await mutation());
    const responseBody = /** @type {Record<string, unknown>} */ (redactMbtValue(
      result.body,
      { secretValues: protectedSecretValues }
    ));
    await insertMbtAuditEvent({
      actor: { ...actor, roles: actorRoles },
      audit: result.audit,
      correlationId: normalizedCorrelationId,
      requestId: normalizedRequestId,
      idempotencyKey: normalizedIdempotencyKey,
      secretValues: protectedSecretValues
    });
    await query(
      `INSERT INTO mbt_command_receipts (
         receipt_id,
         actor_operator_id,
         actor_roles,
         command_name,
         idempotency_key,
         canonical_payload_hash,
         http_status,
         response_body,
         entity_type,
         entity_id,
         correlation_id,
         request_id
       ) VALUES (
         $1, $2, $3::text[], $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12
       )`,
      [
        crypto.randomUUID(),
        actorOperatorId,
        actorRoles,
        normalizedCommandName,
        normalizedIdempotencyKey,
        payloadHash,
        result.status,
        JSON.stringify(responseBody),
        result.audit.entityType,
        result.audit.entityId,
        normalizedCorrelationId,
        normalizedRequestId
      ]
    );
    return {
      status: result.status,
      body: responseBody,
      replayed: false
    };
  });
}
