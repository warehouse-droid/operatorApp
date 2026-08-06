// @ts-check

import { MbtError } from "./errors.js";

/**
 * @param {object} [input]
 * @param {string} [input.status]
 * @param {string | null} [input.sentAt]
 * @param {string | null} [input.externalAcknowledgedAt]
 */
export function recoverExpiredLease({ status, sentAt, externalAcknowledgedAt } = {}) {
  if (status !== "leased") {
    throw new MbtError({
      status: 409,
      code: "MBT_OUTBOX_INVALID_STATE",
      message: "Only a leased outbox event can be recovered."
    });
  }
  if (externalAcknowledgedAt) {
    return { status: "attention", attentionReason: "invalid_lease_evidence" };
  }
  if (sentAt) {
    return { status: "attention", attentionReason: "external_outcome_uncertain" };
  }
  return { status: "pending", attentionReason: null };
}

/**
 * @param {string} from
 * @param {string} to
 * @param {{externalAcknowledgedAt?: string | null}} [evidence]
 */
export function assertOutboxTransition(from, to, evidence = {}) {
  const allowed = new Set([
    "pending:leased",
    "leased:pending",
    "leased:sent",
    "leased:attention",
    "attention:leased",
    "sent:reconciled"
  ]);
  if (!allowed.has(`${from}:${to}`)) {
    throw new MbtError({
      status: 409,
      code: "MBT_OUTBOX_INVALID_TRANSITION",
      message: `Outbox state cannot change from ${String(from)} to ${String(to)}.`
    });
  }
  if (to === "sent" && !evidence.externalAcknowledgedAt) {
    throw new MbtError({
      status: 409,
      code: "MBT_OUTBOX_ACK_REQUIRED",
      message: "External acknowledgement is required before marking an outbox event sent."
    });
  }
  return true;
}
