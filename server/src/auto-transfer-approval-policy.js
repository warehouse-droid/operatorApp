export const NETSUITE_PENDING_FULFILLMENT_STATUS_ID = "B";

export async function ensureTransferDependencyPendingFulfillment({
  created,
  proposal,
  batch = null,
  hydrateTransferOrder,
  rememberTransferOrder,
  approveTransferOrder
} = {}) {
  const transferOrderId = Number(created?.id);
  if (!Number.isInteger(transferOrderId) || transferOrderId <= 0) {
    throw new Error("NetSuite did not return the created Transfer Order ID.");
  }
  if (typeof hydrateTransferOrder !== "function" || typeof rememberTransferOrder !== "function") {
    throw new Error("NetSuite Transfer Order recovery transport is unavailable.");
  }
  const hydrate = async () => {
    const transferOrder = await hydrateTransferOrder(transferOrderId, proposal);
    if (Number(transferOrder?.id) !== transferOrderId || !String(transferOrder?.tranid || "").trim()) {
      throw new Error("The created Transfer Order could not be synchronized.");
    }
    return transferOrder;
  };

  let transferOrder = await hydrate();
  await rememberTransferOrder(transferOrder);
  if (transferOrder.pendingFulfillment === true) return transferOrder;
  if (typeof approveTransferOrder !== "function") {
    throw new Error("NetSuite Transfer Order approval transport is unavailable.");
  }

  let approvalError = null;
  try {
    await approveTransferOrder({ transferOrderId, transferOrder, proposal, batch });
  } catch (error) {
    approvalError = error;
  }
  try {
    transferOrder = await hydrate();
  } catch (error) {
    if (approvalError) throw approvalError;
    throw error;
  }
  if (approvalError && transferOrder.pendingFulfillment !== true) throw approvalError;
  return transferOrder;
}

export function transferDependencyCreationOutcome(transferOrder = {}) {
  const pendingFulfillment = transferOrder.pendingFulfillment === true;
  const orderRef = String(transferOrder.tranid || "Transfer Order").trim();
  const status = String(transferOrder.statusText || transferOrder.status || "unknown").trim();
  const statusMessage = pendingFulfillment
    ? null
    : `${orderRef} was created, but NetSuite status is ${status} instead of Pending Fulfillment.`;
  return {
    pendingFulfillment,
    creationStatus: pendingFulfillment ? "created" : "attention",
    approvalStatus: pendingFulfillment ? "approved" : "failed",
    printStatus: pendingFulfillment ? "pending_user_print" : "blocked",
    statusMessage
  };
}

export function transferDependencyApprovalStatusAfterPrintBlock(currentStatus, fallbackStatus) {
  return String(currentStatus || "").trim().toLowerCase() === "approved"
    ? "approved"
    : fallbackStatus;
}
