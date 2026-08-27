// @ts-check

import { isAmbiguousOperatorNetSuiteFailure } from "./operator-netsuite-posting-service.js";
import {
  buildSalesOrderItemFulfillmentPayload,
  compareSalesOrderFulfillmentSnapshot,
  resolveSalesOrderFulfillmentLines
} from "./sales-order-auto-fulfillment-domain.js";

/** @typedef {Record<string, any>} LooseRecord */

/** @param {LooseRecord | null | undefined} record */
function safeRemoteEvidence(record) {
  return {
    id: Number(record?.id),
    tranId: String(record?.tranId ?? record?.tranid ?? record?.id ?? ""),
    externalId: String(record?.externalId ?? record?.externalid ?? "")
  };
}

/** @param {LooseRecord} candidate */
function resolutionAction(candidate) {
  const action = String(candidate?.resolutionAction || "automatic").trim().toLowerCase();
  if (["automatic", "historical_backfill", "recheck", "recover"].includes(action)) {return "snapshot";}
  return action;
}

/** @param {LooseRecord} candidate */
function rawResolutionAction(candidate) {
  return String(candidate?.resolutionAction || "automatic").trim().toLowerCase();
}

/** @param {LooseRecord} candidate */
function requiresAutomaticDriftStop(candidate) {
  const action = rawResolutionAction(candidate);
  return !["snapshot", "all_live_remaining", "custom"].includes(action);
}

/** @param {LooseRecord} candidate */
function retainedRecoveryPayload(candidate) {
  const payload = candidate?.payload;
  if (!payload || typeof payload !== "object" || payload.externalId !== candidate.externalId
      || !Array.isArray(payload?.item?.items)) {
    return null;
  }
  return payload;
}

/** @param {LooseRecord} candidate @param {LooseRecord} payload */
function retainedRecoveryLines(candidate, payload) {
  const stored = candidate?.liveSnapshot?.selectedLines;
  if (Array.isArray(stored) && stored.length) {return stored;}
  const items = /** @type {LooseRecord[]} */ (payload.item.items);
  return items
    .filter((line) => line?.itemReceive === true && Number(line?.quantity) > 0)
    .map((line) => ({
      orderLine: Number(line.orderLine),
      quantity: Number(line.quantity),
      location: line.location === undefined ? null : Number(line.location)
    }));
}

/**
 * @param {{
 *   repository: LooseRecord,
 *   fetchLiveOrder: (candidate: LooseRecord) => Promise<LooseRecord>,
 *   adapter: LooseRecord,
 *   workerId: string
 * }} dependencies
 */
export function createSalesOrderAutoFulfillmentProcessor({
  repository,
  fetchLiveOrder,
  adapter,
  workerId
}) {
  const leaseSeconds = 180;

  /** @param {LooseRecord} candidate @param {() => Promise<any>} work */
  async function withLeaseHeartbeat(candidate, work) {
    await repository.renew({
      candidateId: candidate.id,
      leaseToken: candidate.leaseToken,
      leaseSeconds
    });
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal
        .then(() => repository.renew({
          candidateId: candidate.id,
          leaseToken: candidate.leaseToken,
          leaseSeconds
        }))
        .then(() => undefined)
        .catch(() => undefined);
    }, 30000);
    try {
      return await work();
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  // One explicit state machine protects the no-second-transform invariant.
  /** @param {string} candidateId */
  // eslint-disable-next-line complexity
  async function process(candidateId) {
    let candidate = await repository.prepare(candidateId);
    if (!candidate || !["queued", "discovered", "waiting_evidence", "uncertain"].includes(candidate.status)) {
      return candidate;
    }
    if (candidate.status === "uncertain" && rawResolutionAction(candidate) !== "recover") {
      return candidate;
    }
    const recoveryPayload = rawResolutionAction(candidate) === "recover"
      ? retainedRecoveryPayload(candidate)
      : null;
    // An Admin recovery first checks the immutable external identity. When the
    // remote IF exists, live remaining quantity is expected to be zero and
    // must not erase the transaction evidence as a generic reconciliation.
    const preRecoveredRecord = recoveryPayload
      ? await adapter.findByExternalId(candidate)
      : null;
    const liveOrder = preRecoveredRecord
      ? (candidate.liveSnapshot || {})
      : await fetchLiveOrder(candidate);
    const snapshotLines = /** @type {LooseRecord[]} */ (candidate.lineSnapshot || []);
    const liveLines = /** @type {LooseRecord[]} */ (liveOrder.lines || []);
    const snapshotOrderLines = new Set(snapshotLines.map((line) => Number(line.orderLine)));
    const comparison = compareSalesOrderFulfillmentSnapshot({
      snapshotLines: candidate.lineSnapshot,
      liveOrder: candidate.isSplit
        ? { ...liveOrder, lines: liveLines.filter((line) => snapshotOrderLines.has(Number(line.orderLine))) }
        : liveOrder
    });
    if (!preRecoveredRecord && comparison.state === "closed") {
      return repository.closed({ candidateId: candidate.id, liveOrder, issues: comparison.issues });
    }
    if (!preRecoveredRecord && comparison.state === "reconciled") {
      return repository.reconciled({ candidateId: candidate.id, liveOrder });
    }
    if (!preRecoveredRecord && comparison.state === "attention" && requiresAutomaticDriftStop(candidate)) {
      return repository.attention({ candidateId: candidate.id, liveOrder, issues: comparison.issues });
    }

    const selectedLines = recoveryPayload
      ? retainedRecoveryLines(candidate, recoveryPayload)
      : resolveSalesOrderFulfillmentLines({
          action: resolutionAction(candidate),
          snapshotLines: candidate.lineSnapshot,
          liveLines: liveOrder.lines,
          customLines: candidate.customLines || candidate.resolutionLines || [],
          reason: candidate.resolutionReason
        });
    if (!selectedLines.length) {
      return repository.get(candidate.id);
    }
    const payload = recoveryPayload || buildSalesOrderItemFulfillmentPayload({
      selectedLines,
      availableLines: liveOrder.lines,
      externalId: candidate.externalId
    });
    candidate = await repository.claim({
      candidateId: candidate.id,
      workerId,
      payload,
      liveOrder,
      selectedLines
    });
    if (!candidate) {return repository.get(candidateId);}

    // Remote verification and ambiguous recovery must share one leased attempt.
    // eslint-disable-next-line complexity
    return withLeaseHeartbeat(candidate, async () => {
      const attempt = await repository.startAttempt({
        candidateId: candidate.id,
        leaseToken: candidate.leaseToken
      });
      let record = null;
      let verified = null;
      let recovered = false;
      try {
        record = preRecoveredRecord || await adapter.findByExternalId(candidate);
        if (record) {
          verified = adapter.verify(candidate, record, payload);
          recovered = true;
        } else {
          const transformed = await adapter.transform(candidate, payload);
          const transactionId = Number(transformed?.id);
          if (Number.isSafeInteger(transactionId) && transactionId > 0) {
            record = await adapter.fetchById(candidate, transactionId);
            if (!record) {
              throw Object.assign(new Error("NetSuite SO fulfillment was created but could not be read for verification."), {
                code: "SALES_ORDER_IF_RESULT_UNVERIFIED",
                ambiguous: true
              });
            }
            verified = adapter.verify(candidate, record, payload);
          } else {
            record = await adapter.findByExternalId(candidate);
            if (!record) {
              throw Object.assign(new Error("NetSuite SO fulfillment returned no verifiable identity."), {
                code: "SALES_ORDER_IF_RESULT_UNVERIFIED",
                ambiguous: true
              });
            }
            verified = adapter.verify(candidate, record, payload);
            recovered = true;
          }
        }
      } catch (error) {
        if (isAmbiguousOperatorNetSuiteFailure(error)) {
          try {
            const recovery = await adapter.findByExternalId(candidate);
            if (recovery) {
              record = recovery;
              verified = adapter.verify(candidate, recovery, payload);
              recovered = true;
            }
          } catch (recoveryError) {
            error = recoveryError;
          }
        }
        if (!record || !verified) {
          return repository.failure({
            candidateId: candidate.id,
            leaseToken: candidate.leaseToken,
            attemptNumber: attempt.attemptNumber,
            error,
            uncertain: isAmbiguousOperatorNetSuiteFailure(error)
          });
        }
      }
      return repository.complete({
        candidateId: candidate.id,
        leaseToken: candidate.leaseToken,
        attemptNumber: attempt.attemptNumber,
        transactionId: verified.id,
        transactionRef: verified.transactionRef,
        response: safeRemoteEvidence(record),
        recovered,
        payload,
        liveOrder,
        selectedLines
      });
    });
  }

  return { process };
}
