// @ts-check

import { query } from "./db.js";
import {
  buildItemFulfillmentPayload,
  getDeliveryOrder,
  isPickupDeliveryMethod
} from "./delivery-repository.js";
import {
  buildItemReceiptPayload,
  getLocalCoReceivingOrder,
  getReceivableReceivingOrder
} from "./receiving-repository.js";
import {
  normalizeOperatorNetSuiteLocationId,
  OPERATOR_NETSUITE_POSTING_FUNCTIONS
} from "./operator-netsuite-posting-policy.js";

/** @type {Map<string, Record<string, any>>} */
const FUNCTION_DETAILS = new Map(Object.values(OPERATOR_NETSUITE_POSTING_FUNCTIONS)
  .map((details) => [details.functionKey, details]));

/** @param {string} code @param {string} message @param {number} [status] */
function resolutionError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

/** @param {unknown} value */
function positiveNumber(value) {
  const number = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** @param {Record<string, any>} line */
function hasPackedQuantity(line) {
  return [
    line.packed_pallet_qty,
    line.packed_layer_qty,
    line.packed_section_qty,
    line.packed_piece_qty,
    line.packed_sales_qty
  ].some((value) => positiveNumber(value) > 0);
}

/** @param {Record<string, any>} line */
function eligibleLine(line) {
  return line?.netsuite_active === true
    && !line?.sync_exception
    && ["InvtPart", "NonInvtPart"].includes(String(line?.item_type || ""));
}

/** @param {Record<string, any>} order */
function localOnlyDeliveryOrder(order) {
  return order?.order_type === "co_order"
    || order?.order_type === "vrma_order"
    || order?.reload_authorized === true
    || order?.sales_order_reattempt === true;
}

/** @param {string} functionKey @param {Record<string, any>} order */
function localOrderKey(functionKey, order) {
  const type = String(order?.order_type || (order?.is_dispatch_group ? "group_order" : "order"));
  const id = String(order?.netsuite_id ?? order?.tranid ?? "").trim();
  if (!id) {
    throw resolutionError(
      "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED",
      "The local Operator order identity could not be resolved."
    );
  }
  return `${functionKey}:${type}:${id}`;
}

/** @param {Record<string, any>} order @param {string} functionKey */
function orderLocation(order, functionKey) {
  const raw = functionKey === "receiving"
    ? order?.destination_location_id
    : order?.outbound_location_id ?? order?.source_location_id;
  return normalizeOperatorNetSuiteLocationId(raw);
}

/** @param {Record<string, any>} order @param {string} functionKey */
function selectedPayload(order, functionKey) {
  if (functionKey === "receiving") {
    return buildItemReceiptPayload(order, order.receivableLines || []);
  }
  const selected = (order.lines || []).filter((/** @type {Record<string, any>} */ line) => eligibleLine(line) && hasPackedQuantity(line));
  return buildItemFulfillmentPayload(order, selected);
}

/** @param {Record<string, any>} order @param {string} functionKey @param {number} orderLine */
function localLineIdForPayload(order, functionKey, orderLine) {
  const transferFulfillmentOffset = functionKey !== "receiving" && order.order_type === "transfer_order" ? 1 : 0;
  const localLineKey = orderLine - transferFulfillmentOffset;
  const line = (order.lines || []).find((/** @type {Record<string, any>} */ candidate) => Number(candidate.line_id) === localLineKey);
  if (!line) {
    throw resolutionError(
      "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED",
      `NetSuite line ${orderLine} could not be mapped to ${order.tranid || order.netsuite_id}.`
    );
  }
  return String(line.id ?? line.line_id);
}

/**
 * @param {Record<string, any>} order
 * @param {string} functionKey
 * @param {(order: Record<string, any>, context: {functionKey: string}) => Promise<Record<string, any> | null>} resolveRealSource
 */
async function targetForOrder(order, functionKey, resolveRealSource) {
  const payload = selectedPayload(order, functionKey);
  const selectedItems = /** @type {Record<string, any>[]} */ (payload?.item?.items || []).filter((/** @type {Record<string, any>} */ item) => (
    item.itemReceive !== false
      && item.itemreceive !== false
      && positiveNumber(item.quantity) > 0
  ));
  if (!selectedItems.length) {return null;}
  const source = await resolveRealSource(order, { functionKey });
  if (!source
      || !Number.isSafeInteger(Number(source.sourceNetSuiteId))
      || Number(source.sourceNetSuiteId) <= 0
      || !Array.isArray(source.availableLines)
      || !source.availableLines.length) {
    throw resolutionError(
      "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED",
      `The positive NetSuite parent and line mapping for ${order.tranid || order.netsuite_id} is unavailable.`
    );
  }
  const orderKey = localOrderKey(functionKey, order);
  return {
    sourceOrderKind: source.sourceOrderKind,
    sourceNetSuiteId: Number(source.sourceNetSuiteId),
    sourceOrderRef: String(source.sourceOrderRef || ""),
    selectedLines: selectedItems.map((/** @type {Record<string, any>} */ item) => ({
      orderLine: Number(item.orderLine),
      quantity: Number(item.quantity),
      location: item.location ?? null,
      localOrderKey: orderKey,
      localLineId: localLineIdForPayload(order, functionKey, Number(item.orderLine))
    })),
    availableLines: source.availableLines
  };
}

/** @param {Record<string, any>} root @param {string} functionKey */
function localOperation(root, functionKey) {
  const orderId = String(root.netsuite_id ?? root.tranid ?? "");
  if (functionKey === "customer_pickup") {
    return { kind: "customer_pickup_load", orderId, orderType: "sales_order" };
  }
  if (functionKey === "receiving") {
    return { kind: "receiving_receipt", orderId, orderType: String(root.order_type) };
  }
  return {
    kind: "delivery_prep_load",
    orderId,
    orderType: root.is_dispatch_group ? "group_order" : String(root.order_type)
  };
}

/**
 * A dependency-injected resolver keeps the difficult group/split policy
 * executable without a database and leaves production identity reads server-owned.
 *
 * @param {object} dependencies
 * @param {(id: unknown) => Promise<Record<string, any> | null>} dependencies.getDeliveryOrder
 * @param {(id: unknown, orderType?: unknown) => Promise<Record<string, any> | null>} dependencies.getReceivableReceivingOrder
 * @param {(order: Record<string, any>, context: {functionKey: string}) => Promise<Record<string, any> | null>} dependencies.resolveRealSource
 */
export function createOperatorNetSuitePostingTargetResolver({
  getDeliveryOrder: readDeliveryOrder,
  getReceivableReceivingOrder: getReceivingOrderById,
  resolveRealSource
}) {
  // This is the single policy orchestration boundary: each validation is kept
  // adjacent so no caller can bypass canonical yard/group/source resolution.
  // eslint-disable-next-line complexity
  return async function resolveOperatorNetSuitePostingTargets(/** @type {Record<string, any>} */ {
    functionKey: rawFunctionKey,
    orderId,
    orderType,
    clientLocationId,
    deferTargets = false
  } = {}) {
    const functionKey = String(rawFunctionKey || "").trim().toLowerCase();
    const details = FUNCTION_DETAILS.get(functionKey);
    if (!details) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_FUNCTION_UNSUPPORTED",
        "This Operator function cannot create a NetSuite transaction.",
        400
      );
    }
    const root = functionKey === "receiving"
      ? await getReceivingOrderById(orderId, orderType)
      : await readDeliveryOrder(orderId);
    if (!root) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_ORDER_NOT_FOUND",
        "The current Operator order was not found.",
        404
      );
    }
    if (functionKey === "customer_pickup"
        && (root.order_type !== "sales_order" || !isPickupDeliveryMethod(root.delivery_method))) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_ORDER_UNSUPPORTED",
        "Only a current Pick-Up Sales Order can use Customer Pickup posting."
      );
    }

    const children = functionKey === "delivery_prep" && root.is_dispatch_group
      ? (root.child_orders || [])
      : [root];
    if (!children.length) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED",
        "The grouped Operator order has no current children."
      );
    }
    const locations = new Set(children
      .map((/** @type {Record<string, any>} */ order) => orderLocation(order, functionKey))
      .filter((/** @type {number | null} */ locationId) => locationId !== null));
    if (locations.size !== 1) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_MIXED_YARDS",
        "All orders completed together must resolve to one supported yard."
      );
    }
    const canonicalLocationId = [...locations][0];
    const submittedLocationId = clientLocationId === null || clientLocationId === undefined || clientLocationId === ""
      ? canonicalLocationId
      : normalizeOperatorNetSuiteLocationId(clientLocationId);
    if (submittedLocationId !== canonicalLocationId) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_LOCATION_MISMATCH",
        "The selected yard does not match the server-owned order yard. Refresh before confirming."
      );
    }

    const localOrderKeys = [localOrderKey(functionKey, root)];
    if (root.is_dispatch_group) {
      for (const child of children) {localOrderKeys.push(localOrderKey(functionKey, child));}
    }
    const localChildren = children.filter((/** @type {Record<string, any>} */ child) => (
      (functionKey === "receiving" && child.order_type === "co_order")
      || (functionKey === "delivery_prep" && localOnlyDeliveryOrder(child))
    ));
    const postingChildren = children.filter((/** @type {Record<string, any>} */ child) => !localChildren.includes(child));
    const netSuitePostingOwner = functionKey === "delivery_prep"
      && postingChildren.length > 0
      && postingChildren.every((/** @type {Record<string, any>} */ child) => child.order_type === "sales_order")
      ? "driver_completion"
      : "operator";
    const baseResolution = {
      functionKey,
      transactionType: details.transactionType,
      netSuitePostingOwner,
      canonicalLocationId,
      localOrderKeys: [...new Set(localOrderKeys)].sort(),
      localOperation: localOperation(root, functionKey)
    };
    const materializeTargets = async () => {
      /** @type {Record<string, any>[]} */
      const targets = [];
      for (const child of postingChildren) {
        const target = await targetForOrder(child, functionKey, resolveRealSource);
        if (target) {targets.push(target);}
      }
      const localOnly = targets.length === 0 && localChildren.length > 0;
      if (!targets.length && !localOnly) {
        throw resolutionError(
          "OPERATOR_NETSUITE_POSTING_NO_LINES",
          functionKey === "receiving"
            ? "No confirmed NetSuite lines are available to receive."
            : "No packed NetSuite lines are available to fulfill."
        );
      }
      return { ...baseResolution, localOnly, targets };
    };
    if (deferTargets === true) {
      return {
        ...baseResolution,
        localOnly: postingChildren.length === 0,
        targets: [],
        materializeTargets
      };
    }
    return materializeTargets();
  };
}

/**
 * SQL selection is intentionally centralized so SO/PO/TO lineage and line
 * offsets cannot diverge across separate production adapters.
 *
 * @param {{query: Function}} dependencies
 */
export function createOperatorNetSuitePostingRealSourceResolver({ query: runQuery }) {
  // eslint-disable-next-line complexity
  return async function resolveRealSourceFromDatabase(/** @type {Record<string, any>} */ order, /** @type {{functionKey: string}} */ { functionKey }) {
  const orderType = String(order?.order_type || "");
  let sourceNetSuiteId = Number(order?.netsuite_id);
  let sourceOrderRef = String(order?.tranid || "");
  let sourceOrderKind = orderType === "transfer_order" ? "TO" : orderType === "purchase_order" ? "PO" : "SO";
  if (!Number.isSafeInteger(sourceNetSuiteId) || sourceNetSuiteId <= 0) {
    const split = orderType === "transfer_order"
      ? await runQuery(
          `SELECT source_to_id AS source_id, source_to_ref AS source_ref
             FROM dispatch_scm_to_splits
            WHERE split_to_id = $1
              AND status = 'active'
            LIMIT 1`,
          [order?.netsuite_id]
        )
      : await runQuery(
          `SELECT source_so_id AS source_id, source_so_ref AS source_ref
             FROM dispatch_scm_so_splits
            WHERE split_so_id = $1
              AND status = 'active'
            LIMIT 1`,
          [order?.netsuite_id]
        );
    if (!split.rows[0]) {return null;}
    sourceNetSuiteId = Number(split.rows[0].source_id);
    sourceOrderRef = String(split.rows[0].source_ref || "");
    sourceOrderKind = orderType === "transfer_order" ? "TO" : "SO";
  }
  if (!Number.isSafeInteger(sourceNetSuiteId) || sourceNetSuiteId <= 0) {return null;}

  let rows;
  if (sourceOrderKind === "SO") {
    rows = await runQuery(
      `SELECT line.line_id AS order_line,
              COALESCE(line.location_id, parent.outbound_location_id) AS location_id
         FROM sales_order_lines line
         JOIN sales_orders parent ON parent.netsuite_id = line.sales_order_id
        WHERE line.sales_order_id = $1
          AND line.netsuite_active = true
          AND line.sync_exception IS NULL
          AND line.item_type IN ('InvtPart', 'NonInvtPart')
          AND line.line_id IS NOT NULL
        ORDER BY line.line_id, line.id`,
      [sourceNetSuiteId]
    );
  } else if (sourceOrderKind === "PO") {
    rows = await runQuery(
      `SELECT line.line_id AS order_line,
              COALESCE(line.location_id, parent.destination_location_id) AS location_id
         FROM purchase_order_lines line
         JOIN purchase_orders parent ON parent.netsuite_id = line.purchase_order_id
        WHERE line.purchase_order_id = $1
          AND line.netsuite_active = true
          AND line.sync_exception IS NULL
          AND line.item_type IN ('InvtPart', 'NonInvtPart')
          AND line.line_id IS NOT NULL
        ORDER BY line.line_id, line.id`,
      [sourceNetSuiteId]
    );
  } else {
    const lineStage = functionKey === "receiving" ? "receiving" : "outbound";
    rows = await runQuery(
      `SELECT line.line_id AS order_line, NULL::bigint AS location_id
         FROM transfer_order_lines line
        WHERE line.transfer_order_id = $1
          AND line.line_stage = $2
          AND line.netsuite_active = true
          AND line.sync_exception IS NULL
          AND line.item_type IN ('InvtPart', 'NonInvtPart')
          AND line.line_id IS NOT NULL
        ORDER BY line.line_id, line.id`,
      [sourceNetSuiteId, lineStage]
    );
  }
  const transferFulfillmentOffset = sourceOrderKind === "TO" && functionKey !== "receiving" ? 1 : 0;
  return {
    sourceOrderKind,
    sourceNetSuiteId,
    sourceOrderRef,
    availableLines: rows.rows.map((/** @type {Record<string, any>} */ line) => ({
      orderLine: Number(line.order_line) + transferFulfillmentOffset,
      location: line.location_id === null ? null : Number(line.location_id)
    }))
    };
  };
}

/** @param {{getLocalCoReceivingOrder: Function, getReceivableReceivingOrder: Function}} dependencies */
export function createOperatorNetSuiteReceivingOrderReader({
  getLocalCoReceivingOrder: readLocalCo,
  getReceivableReceivingOrder: readNetSuiteReceivingOrder
}) {
  return async function readReceivingOrder(/** @type {unknown} */ orderId, /** @type {unknown} */ orderType) {
    if (String(orderType || "") === "co_order" || String(orderId || "").startsWith("CO-")) {
      return readLocalCo(orderId);
    }
    return readNetSuiteReceivingOrder(orderId);
  };
}

const resolveRealSourceFromDatabase = createOperatorNetSuitePostingRealSourceResolver({ query });
const readReceivingOrder = createOperatorNetSuiteReceivingOrderReader({
  getLocalCoReceivingOrder,
  getReceivableReceivingOrder
});

export const resolveOperatorNetSuitePostingTargets = createOperatorNetSuitePostingTargetResolver({
  getDeliveryOrder,
  getReceivableReceivingOrder: readReceivingOrder,
  resolveRealSource: resolveRealSourceFromDatabase
});
