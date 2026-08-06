// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { redactMbtValue } from "./redaction.js";

/**
 * @typedef {object} MbtActor
 * @property {string} operatorId
 * @property {readonly string[]} roles
 * @property {string} [actorType]
 */

/**
 * @typedef {object} MbtAuditMutation
 * @property {string} action
 * @property {string} entityType
 * @property {string} entityId
 * @property {Record<string, unknown>} beforeState
 * @property {Record<string, unknown>} afterState
 * @property {string} reason
 * @property {number} revisionBefore
 * @property {number} revisionAfter
 * @property {string | undefined} [source]
 */

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError(`An audit ${label} is required.`);
  }
  return normalized;
}

/** @param {readonly string[] | undefined} roles */
function normalizedRoles(roles) {
  if (!Array.isArray(roles)) {
    throw new TypeError("An audit actor roles list is required.");
  }
  const normalized = roles.map((role) => String(role).trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new TypeError("An audit actor roles list is required.");
  }
  return normalized;
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} secretValues
 */
function jsonEvidence(value, secretValues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("An audit evidence object is required.");
  }
  return JSON.stringify(redactMbtValue(
    value,
    /** @type {any} */ ({ secretValues: [...secretValues] })
  ));
}

/** @param {unknown} value @param {string} label */
function requiredRevision(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`An audit ${label} is required.`);
  }
  return Number(value);
}

/** @param {MbtActor} actor */
function auditActorType(actor) {
  const normalized = String(actor.actorType || "operator").trim();
  return normalized || "operator";
}

/** @param {MbtAuditMutation} audit */
function auditSource(audit) {
  const normalized = String(audit.source || "mbt").trim();
  return normalized || "mbt";
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {MbtAuditMutation} input.audit
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {string} input.idempotencyKey
 * @param {readonly string[]} [input.secretValues]
 */
function prepareAuditRow({
  actor,
  audit,
  correlationId,
  requestId,
  idempotencyKey,
  secretValues = []
}) {
  return {
    auditEventId: crypto.randomUUID(),
    actorType: auditActorType(actor),
    actorOperatorId: requiredText(actor.operatorId, "actor operator ID"),
    actorRoles: normalizedRoles(actor.roles),
    action: requiredText(audit.action, "action"),
    entityType: requiredText(audit.entityType, "entity type"),
    entityId: requiredText(audit.entityId, "entity ID"),
    beforeState: jsonEvidence(audit.beforeState, secretValues),
    afterState: jsonEvidence(audit.afterState, secretValues),
    reason: requiredText(audit.reason, "reason"),
    revisionBefore: requiredRevision(audit.revisionBefore, "revision before"),
    revisionAfter: requiredRevision(audit.revisionAfter, "revision after"),
    correlationId: requiredText(correlationId, "correlation ID"),
    requestId: requiredText(requestId, "request ID"),
    idempotencyKey: requiredText(idempotencyKey, "idempotency key"),
    source: auditSource(audit)
  };
}

/**
 * Insert one append-only, redacted audit event using the active transaction.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {MbtAuditMutation} input.audit
 * @param {string} input.correlationId
 * @param {string} input.requestId
 * @param {string} input.idempotencyKey
 * @param {readonly string[]} [input.secretValues]
 * @returns {Promise<{auditEventId: string}>}
 */
export async function insertMbtAuditEvent(input) {
  const row = prepareAuditRow(input);
  await query(
    `INSERT INTO mbt_audit_events (
       audit_event_id,
       actor_type,
       actor_operator_id,
       actor_roles,
       action,
       entity_type,
       entity_id,
       before_state,
       after_state,
       reason,
       revision_before,
       revision_after,
       correlation_id,
       request_id,
       idempotency_key,
       source
     ) VALUES (
       $1, $2, $3, $4::text[], $5, $6, $7, $8::jsonb, $9::jsonb,
       $10, $11, $12, $13, $14, $15, $16
     )`,
    [
      row.auditEventId,
      row.actorType,
      row.actorOperatorId,
      row.actorRoles,
      row.action,
      row.entityType,
      row.entityId,
      row.beforeState,
      row.afterState,
      row.reason,
      row.revisionBefore,
      row.revisionAfter,
      row.correlationId,
      row.requestId,
      row.idempotencyKey,
      row.source
    ]
  );
  return { auditEventId: row.auditEventId };
}
