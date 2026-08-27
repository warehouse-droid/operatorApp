// @ts-check

import { afterTransactionCommit, withTransaction } from "./db.js";
import { recordCustomerPickupLoad, recordDeliveryLoad } from "./delivery-repository.js";
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
  getOperatorNetSuitePostingCommand,
  listOperatorNetSuitePostingAttentionCommands,
  resumeOperatorNetSuitePostingCommand
} from "./operator-netsuite-posting-repository.js";
import { operatorNetSuitePostingRuntime } from "./operator-netsuite-posting-runtime.js";

/** @param {Record<string, any>} input @param {Record<string, any>} resolution */
async function preflightExistingLocalCompletion(input, resolution) {
  await withTransaction(async () => {
    const operation = resolution.localOperation;
    if (operation.kind === "customer_pickup_load") {
      await recordCustomerPickupLoad(operation.orderId, input.actorOperatorId, {
        photoDataUrls: input.photoRefs
      });
      return;
    }
    if (operation.kind === "delivery_prep_load") {
      await recordDeliveryLoad(operation.orderId, input.actorOperatorId, {
        photoDataUrls: input.photoRefs,
        requestId: input.requestId
      });
      return;
    }
    if (operation.kind === "receiving_receipt") {
      const order = await getReceivableReceivingOrder(operation.orderId);
      const payload = buildItemReceiptPayload(order, order.receivableLines);
      await recordReceivingReceipt(operation.orderId, input.actorOperatorId, {
        photoDataUrls: input.photoRefs,
        payload,
        response: { preflight: true },
        itemReceiptId: null,
        itemReceiptTranid: null
      });
      if (operation.orderType === "transfer_order") {
        await syncOrderDependenciesForTransferOrder(operation.orderId);
      }
      return;
    }
    throw new Error("Unsupported Operator NetSuite posting preflight.");
  }, { rollback: true });
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
  onAccepted: async (/** @type {Record<string, any>} */ command) => {
    afterTransactionCommit(() => {
      void operatorNetSuitePostingRuntime.enqueue(command.id);
    });
  }
});

/** @param {Record<string, any>} input */
export async function submitOperatorNetSuitePostingAction(input) {
  return withTransaction(() => admit(input));
}

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

/** @param {string} commandId */
export async function resumePublicOperatorNetSuitePostingCommand(commandId) {
  return withTransaction(async () => {
    const command = await resumeOperatorNetSuitePostingCommand(commandId);
    afterTransactionCommit(() => {
      void operatorNetSuitePostingRuntime.enqueue(command.id);
    });
    const publicCommand = publicOperatorNetSuitePostingCommand(command);
    if (!publicCommand) {throw new Error("The resumed Operator NetSuite posting command is unavailable.");}
    return publicCommand;
  });
}
