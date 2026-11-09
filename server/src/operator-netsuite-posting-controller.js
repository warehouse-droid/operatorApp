// @ts-check

import { afterTransactionCommit, withTransaction } from "./db.js";
import { ensureOutboundLocationDirectory } from './outbound-location-runtime.js';
import { getDeliveryOrder, recordCustomerPickupLoad, recordDeliveryLoad } from "./delivery-repository.js";
import { withConsolidatedLoadMutation } from "./consolidation-load-locks.js";
import {
  buildItemReceiptPayload,
  getReceivableReceivingOrder,
  recordReceivingReceipt
} from "./receiving-repository.js";
import { syncOrderDependenciesForTransferOrder } from "./order-dependency-repository.js";
import { createOperatorNetSuitePostingAdmission } from "./operator-netsuite-posting-admission.js";
import { getOperatorNetSuitePostingPolicy } from "./operator-netsuite-posting-policy-repository.js";
import { resolveOperatorNetSuitePostingTargets } from "./operator-netsuite-posting-targets.js";
import {
  assertNoActiveOperatorNetSuitePostingClaims,
  createOrReplayOperatorNetSuitePostingCommand,
  findReplayableOperatorNetSuitePostingCommand,
  getOperatorNetSuitePostingCommand,
  listOperatorNetSuitePostingAttentionCommands,
  resumeOperatorNetSuitePostingCommand
} from "./operator-netsuite-posting-repository.js";
import { operatorNetSuitePostingRuntime } from "./operator-netsuite-posting-runtime.js";
import { operatorPostingTelemetry as telemetry } from "./operator-netsuite-posting-telemetry.js";

/** @param {Record<string, any>} input @param {Record<string, any>} resolution */
async function preflightExistingLocalCompletion(input, resolution) {
  await withTransaction(async () => {
    const operation = resolution.localOperation;
    if (operation.kind === "customer_pickup_load") {
      await recordCustomerPickupLoad(operation.orderId, input.actorOperatorId, {
        photoDataUrls: input.photoRefs,
        locationId: resolution.canonicalLocationId,
        allowNetSuiteCompleted: resolution.allowNetSuiteCompleted === true
      });
      return;
    }
    if (operation.kind === "delivery_prep_load") {
      await recordDeliveryLoad(operation.orderId, input.actorOperatorId, {
        photoDataUrls: input.photoRefs,
        requestId: input.requestId,
        allowNetSuiteCompleted: resolution.allowNetSuiteCompleted === true
      });
      return;
    }
    if (operation.kind === "receiving_receipt") {
      const order = await getReceivableReceivingOrder(operation.orderId, {
        includeNetSuiteClosed: resolution.allowNetSuiteCompleted === true
      });
      const payload = resolution.localPayload || buildItemReceiptPayload(order, order.receivableLines);
      await recordReceivingReceipt(operation.orderId, input.actorOperatorId, {
        photoDataUrls: input.photoRefs,
        payload,
        response: { preflight: true },
        itemReceiptId: null,
        itemReceiptTranid: null,
        allowNetSuiteCompleted: resolution.allowNetSuiteCompleted === true
      });
      if (operation.orderType === "transfer_order") {
        await syncOrderDependenciesForTransferOrder(operation.orderId);
      }
      return;
    }
    throw new Error("Unsupported Operator NetSuite posting preflight.");
  }, { rollback: true });
}

/** @param {Record<string, any>} command */
async function enqueueAfterCommit(command) {
  afterTransactionCommit(() => {
    void operatorNetSuitePostingRuntime.enqueue(command.id);
  });
}

const admit = createOperatorNetSuitePostingAdmission({
  resolveTargets: resolveOperatorNetSuitePostingTargets,
  getPolicy: getOperatorNetSuitePostingPolicy,
  createCommand: createOrReplayOperatorNetSuitePostingCommand,
  preflight: preflightExistingLocalCompletion,
  assertLocalCompletionAllowed: (/** @type {Record<string, any>} */ resolution) => assertNoActiveOperatorNetSuitePostingClaims({
    functionKey: resolution.functionKey,
    localOrderKeys: resolution.localOrderKeys
  }),
  onAccepted: enqueueAfterCommit
});

/**
 * How long a Load submit waits for its order lock. Another Load for the same
 * order can hold that lock through slow NetSuite validation; a repeat should
 * report "in progress" instead of queueing behind it.
 */
export const LOAD_SUBMIT_ORDER_LOCK_TIMEOUT_MS = 5000;

function loadSubmitInProgressError() {
  return Object.assign(
    new Error("This order is still being processed by an earlier Load. Check its status before loading again."),
    { code: "OPERATOR_NETSUITE_POSTING_IN_PROGRESS", status: 409 }
  );
}

/**
 * @param {object} dependencies
 * @param {(input: Record<string, any>) => Promise<Record<string, any>>} dependencies.admit
 * @param {(input: Record<string, any>) => Promise<Record<string, any> | null>} dependencies.findReplay
 * @param {(orderId: unknown, options: Record<string, any>) => Promise<Record<string, any> | null>} dependencies.readDeliveryOrder
 * @param {(command: Record<string, any>) => Promise<unknown>} [dependencies.onReplayed]
 * @param {() => Promise<unknown>} [dependencies.beforeCustomerPickup]
 * @param {number} [dependencies.lockTimeoutMs]
 */
export function createOperatorNetSuitePostingSubmission({
  admit: admitCommand,
  findReplay,
  readDeliveryOrder,
  onReplayed = async () => {},
  beforeCustomerPickup = async () => {},
  lockTimeoutMs = LOAD_SUBMIT_ORDER_LOCK_TIMEOUT_MS
}) {
  /** @param {Record<string, any>} input */
  async function replayOrAdmit(input) {
    // An exact repeat of an accepted request returns that job before any
    // NetSuite call; NetSuite allows only a few concurrent requests.
    const command = await findReplay(input);
    if (!command) {return admitCommand(input);}
    await onReplayed(command);
    return telemetry.context({ commandId: command.id, actorOperatorId: input.actorOperatorId, orderId: input.orderId,
      functionKey: input.functionKey, transactionType: command.transactionType, stage: "admission" },
    () => telemetry.time({ operation: "posting.replay" }, async () => ({
      mode: "netsuite",
      policy: null,
      replayed: true,
      command
    })));
  }

  return async function submitOperatorNetSuitePostingAction(/** @type {Record<string, any>} */ input) {
    if (input.functionKey === "customer_pickup") {await beforeCustomerPickup();}
    if (["delivery_prep", "customer_pickup"].includes(input.functionKey)) {
      return withConsolidatedLoadMutation(
        () => readDeliveryOrder(input.orderId, { includeNetSuiteClosed: true }),
        () => replayOrAdmit(input),
        { lockTimeoutMs, onLockTimeout: loadSubmitInProgressError }
      );
    }
    return withTransaction(() => replayOrAdmit(input));
  };
}

export const submitOperatorNetSuitePostingAction = createOperatorNetSuitePostingSubmission({
  admit,
  findReplay: findReplayableOperatorNetSuitePostingCommand,
  readDeliveryOrder: getDeliveryOrder,
  onReplayed: enqueueAfterCommit,
  beforeCustomerPickup: ensureOutboundLocationDirectory
});

/**
 * Freeze every local draft/quantity mutation while an accepted command owns
 * the order. Candidate keys are exact; an order such as 123 cannot collide
 * with 1234, and grouped child claims are protected by their own identity.
 *
 * @param {{functionKey: string, orderId: unknown, orderType?: unknown}} input
 */
export async function assertOperatorNetSuitePostingOrderMutable({ functionKey, orderId, orderType }) {
  const normalizedFunction = String(functionKey || "").trim();
  const normalizedOrderId = String(orderId ?? "").trim();
  if (!normalizedFunction || !normalizedOrderId) {return;}
  const supportedTypes = normalizedFunction === "customer_pickup"
    ? ["sales_order"]
    : normalizedFunction === "receiving"
      ? ["purchase_order", "transfer_order", "co_order"]
      : ["sales_order", "transfer_order", "group_order", "co_order", "vrma_order", "order"];
  const requestedType = String(orderType || "").trim();
  const types = [...new Set([requestedType, ...supportedTypes].filter(Boolean))];
  await assertNoActiveOperatorNetSuitePostingClaims({
    functionKey: normalizedFunction,
    localOrderKeys: types.map((type) => `${normalizedFunction}:${type}:${normalizedOrderId}`)
  });
}

/** @param {Record<string, any> | null | undefined} command */
export function publicOperatorNetSuitePostingCommand(command) {
  if (!command) {return null;}
  return {
    schemaVersion: "operator-netsuite-posting-job-v1",
    id: command.id,
    requestId: command.requestId,
    actorOperatorId: command.actorOperatorId,
    functionKey: command.functionKey,
    transactionType: command.transactionType,
    locationId: command.canonicalLocationId,
    yardCode: command.yardCode,
    gateKey: command.gateKey,
    gateRevision: command.gateRevision,
    status: command.status,
    lastError: command.lastError,
    autoRetryCount: command.autoRetryCount ?? 0,
    nextAutoRetryAt: command.nextAutoRetryAt ?? null,
    result: command.status === "completed" ? command.result : {},
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    completedAt: command.completedAt,
    steps: (command.steps || []).map((/** @type {Record<string, any>} */ step) => ({
      stepIndex: step.stepIndex,
      sourceOrderKind: step.sourceOrderKind,
      sourceNetSuiteId: step.sourceNetSuiteId,
      sourceOrderRef: step.sourceOrderRef,
      transactionType: step.transactionType,
      externalId: step.externalId,
      status: step.status,
      attemptCount: step.attemptCount,
      transactionId: step.netSuiteTransactionId,
      transactionRef: step.netSuiteTransactionRef,
      observedTransaction: step.response?.observedTransaction || null,
      fulfillmentParts: step.fulfillmentParts || step.response?.fulfillmentParts || [],
      lastError: step.lastError
    }))
  };
}

/** @param {string} commandId */
export async function getPublicOperatorNetSuitePostingCommand(commandId) {
  return publicOperatorNetSuitePostingCommand(await getOperatorNetSuitePostingCommand(commandId));
}

export async function listPublicOperatorNetSuitePostingAttentionCommands() {
  return (await listOperatorNetSuitePostingAttentionCommands())
    .map((command) => publicOperatorNetSuitePostingCommand(command))
    .filter(Boolean);
}

/**
 * @param {string} commandId
 * @param {{ authorizeRepost?: boolean }} [options] Admin "Resume verification" only.
 */
export async function resumePublicOperatorNetSuitePostingCommand(commandId, options = {}) {
  return withTransaction(async () => {
    const command = await resumeOperatorNetSuitePostingCommand(commandId, options);
    afterTransactionCommit(() => {
      void operatorNetSuitePostingRuntime.enqueue(command.id);
    });
    const publicCommand = publicOperatorNetSuitePostingCommand(command);
    if (!publicCommand) {throw new Error("The resumed Operator NetSuite posting command is unavailable.");}
    return publicCommand;
  });
}
