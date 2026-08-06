// @ts-check

import { canonicalSha256 } from "./canonical-json.js";
import { MbtError } from "./errors.js";

/** @param {unknown} payload */
export function hashCommandPayload(payload) {
  return canonicalSha256(payload);
}

/**
 * @param {unknown} storedHash
 * @param {unknown} candidatePayload
 */
export function compareCommandPayload(storedHash, candidatePayload) {
  const normalizedStoredHash = String(storedHash || "");
  const candidatePayloadHash = hashCommandPayload(candidatePayload);

  if (normalizedStoredHash === candidatePayloadHash) {
    return {
      outcome: "replay",
      payloadHash: normalizedStoredHash
    };
  }

  throw new MbtError({
    status: 409,
    code: "MBT_IDEMPOTENCY_CONFLICT",
    message: "Idempotency key was already used with a different payload.",
    details: {
      storedPayloadHash: normalizedStoredHash,
      candidatePayloadHash
    }
  });
}
