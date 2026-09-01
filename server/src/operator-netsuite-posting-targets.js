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
  fetchOperatorNetSuiteSourceItemLinesFromNetSuite,
  fetchPoToLinkedTransactionsFromNetSuite,
  fetchScmReconciliationOrdersFromNetSuite
} from "./netsuite.js";
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

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** @param {unknown[]} values */
function lineAliases(values) {
  return [...new Set(values
    .flat()
    .map((value) => String(value ?? "").trim())
    .filter((value) => value && value !== "0" && value.toLowerCase() !== "null"))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/** @param {Record<string, any>} item */
function restSourceOrderLine(item) {
  return positiveInteger(item?.orderLine ?? item?.orderline ?? item?.line);
}

/** @param {Record<string, any>} item */
function restSourceItemId(item) {
  return positiveInteger(item?.item?.id ?? item?.item?.value ?? item?.itemId ?? item?.item);
}

/** @param {Record<string, any>} line */
function reconciliationOrderLineAliases(line) {
  return lineAliases([line?.orderLineAliases || [], line?.orderLine]);
}

/** @param {Record<string, any>} line */
function reconciliationSourceLineAliases(line) {
  return lineAliases([line?.sourceLineAliases || [], line?.sourceLineKey]);
}

/** @param {Record<string, any>} line @param {Record<string, any>[]} sourceItems */
function exactRestSourceLine(line, sourceItems) {
  const aliases = new Set(reconciliationOrderLineAliases(line));
  let candidates = sourceItems.filter((item) => {
    const orderLine = restSourceOrderLine(item);
    return orderLine && aliases.has(String(orderLine));
  });
  const itemId = positiveInteger(line?.itemId);
  if (itemId) {
    const hasRestItemIdentity = candidates.some((item) => restSourceItemId(item) !== null);
    if (hasRestItemIdentity) {
      candidates = candidates.filter((item) => restSourceItemId(item) === itemId);
    }
  }
  const canonical = positiveInteger(line?.orderLine);
  const direct = candidates.filter((item) => restSourceOrderLine(item) === canonical);
  if (direct.length === 1) {return canonical;}
  const onlyCandidate = candidates.length === 1 ? candidates[0] : null;
  return onlyCandidate ? restSourceOrderLine(onlyCandidate) : null;
}

/** @param {unknown} value */
function linkedTransactionType(value) {
  const type = String(value || "").trim().toUpperCase();
  if (["IF", "ITEMSHIP", "ITEMFULFILLMENT"].includes(type)) {return "IF";}
  if (["IR", "ITEMRCPT", "ITEMRECEIPT"].includes(type)) {return "IR";}
  return "";
}

/**
 * @param {Record<string, any>} row
 * @param {{id: number, expectedType: string, stableAliases: Set<string>, orderAliases: Set<string>}} identity
 */
// NetSuite may expose aliases in normalized fields or in retained raw evidence.
// eslint-disable-next-line complexity
function linkedRowMatchesLiveLine(row, { id, expectedType, stableAliases, orderAliases }) {
  if (Number(row?.sourceOrderId) !== id || linkedTransactionType(row?.transactionType) !== expectedType) {return false;}
  if (/VOID|CANCEL|REJECT/iu.test(String(row?.statusText || row?.status || ""))) {return false;}
  const rowStableAliases = lineAliases([
    row?.sourceLineKey,
    row?.sourceLineAliases || [],
    row?.raw?.sourceLineAliases || []
  ]);
  const rowOrderAliases = lineAliases([
    row?.sourceOrderLine,
    row?.sourceOrderLineAliases || [],
    row?.raw?.sourceOrderLineAliases || []
  ]);
  return rowStableAliases.some((alias) => stableAliases.has(alias))
    || rowOrderAliases.some((alias) => orderAliases.has(alias));
}

/**
 * @param {Record<string, any>[]} linkedRows
 * @param {{id: number, expectedType: string, stableAliases: Set<string>, orderAliases: Set<string>}} identity
 */
function liveLinkedTransactions(linkedRows, identity) {
  return linkedRows.filter((row) => linkedRowMatchesLiveLine(row, identity))
    .map((row) => ({
      id: Number(row.transactionId),
      ref: String(row.transactionRef || ""),
      type: identity.expectedType,
      quantity: positiveNumber(row.quantity)
    })).filter((row) => Number.isSafeInteger(row.id) && row.id > 0 && row.quantity > 0)
    .sort((left, right) => left.id - right.id || left.ref.localeCompare(right.ref));
}

/**
 * Build the live, read-only source evidence used by the posting resolver. The
 * REST source sublist supplies transform line numbers; SuiteQL supplies stable
 * line keys, progress, and linked transaction evidence.
 *
 * @param {object} dependencies
 * @param {Function} dependencies.fetchReconciliationOrders
 * @param {Function} dependencies.fetchSourceItemLines
 * @param {Function} dependencies.fetchLinkedTransactions
 */
export function createOperatorNetSuitePostingLiveSourceFetcher({
  fetchReconciliationOrders,
  fetchSourceItemLines,
  fetchLinkedTransactions
}) {
  // This function joins three independently authoritative NetSuite read shapes
  // and deliberately fails closed on any identity disagreement.
  // eslint-disable-next-line complexity
  return async function fetchOperatorNetSuitePostingLiveSource(
    /** @type {{sourceOrderKind: unknown, sourceNetSuiteId: unknown}} */ { sourceOrderKind, sourceNetSuiteId }
  ) {
    const kind = String(sourceOrderKind || "").trim().toUpperCase();
    const id = positiveInteger(sourceNetSuiteId);
    if (!id || !["SO", "PO", "TO"].includes(kind)) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED",
        "A valid NetSuite source is required for authoritative line mapping."
      );
    }
    const [orders, sourceItems, linkedRows] = await Promise.all([
      fetchReconciliationOrders({ orderIds: [id], kind, includeOpen: false, targetOnly: true }),
      fetchSourceItemLines(kind, id),
      fetchLinkedTransactions([id])
    ]);
    const order = (orders || []).find((/** @type {Record<string, any>} */ candidate) => (
      Number(candidate?.id) === id && String(candidate?.kind) === kind
    ));
    if (!order || !Array.isArray(order.lines) || !Array.isArray(sourceItems)) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED",
        `NetSuite did not return authoritative ${kind} source-line evidence for ${id}.`
      );
    }

    const lines = order.lines.map((/** @type {Record<string, any>} */ line) => ({
      ...line,
      restOrderLine: line?.identityStatus === "exact" ? exactRestSourceLine(line, sourceItems) : null
    }));
    if (kind === "TO") {
      for (const line of lines) {
        if (line.stage !== "receiving") {continue;}
        const outbound = lines.find((/** @type {Record<string, any>} */ candidate) => candidate.stage === "outbound"
          && candidate.logicalLineIdentity
          && candidate.logicalLineIdentity === line.logicalLineIdentity);
        line.restOrderLine = outbound?.restOrderLine || null;
        if (!outbound || outbound.identityStatus !== "exact") {
          line.identityStatus = "ambiguous";
          line.identityIssue = line.identityIssue || "The Transfer receipt line has no exact visible source-line anchor.";
        }
      }
    }

    for (const line of lines) {
      if (!line.restOrderLine) {
        line.identityStatus = "ambiguous";
        line.identityIssue = line.identityIssue || "The SuiteQL source line did not map uniquely to the REST item sublist.";
      }
      const related = kind === "TO"
        ? lines.filter((/** @type {Record<string, any>} */ candidate) => candidate.logicalLineIdentity === line.logicalLineIdentity)
        : [line];
      const stableAliases = new Set(lineAliases(related.map(reconciliationSourceLineAliases)));
      const orderAliases = new Set(lineAliases(related.map(reconciliationOrderLineAliases)));
      const expectedType = kind === "PO" || line.stage === "receiving" ? "IR" : "IF";
      const linkedTransactions = liveLinkedTransactions(linkedRows || [], {
        id,
        expectedType,
        stableAliases,
        orderAliases
      });
      const orderedQuantity = positiveNumber(line.quantity);
      const linkedQuantity = linkedTransactions.reduce((sum, transaction) => sum + transaction.quantity, 0);
      const completedQuantity = Math.min(
        orderedQuantity,
        Math.max(positiveNumber(line.cumulativeProgressQuantity), linkedQuantity)
      );
      line.completedQuantity = Number(completedQuantity.toFixed(6));
      line.remainingQuantity = Number(Math.max(orderedQuantity - completedQuantity, 0).toFixed(6));
      line.linkedTransactions = linkedTransactions;
      line.location = kind === "SO"
        ? line.locationId ?? order.sourceLocationId ?? null
        : kind === "PO"
          ? line.locationId ?? order.destinationLocationId ?? null
          : null;
    }
    return {
      sourceOrderKind: kind,
      sourceNetSuiteId: id,
      sourceOrderRef: String(order.tranid || ""),
      lines,
      linkedTransactions: linkedRows || []
    };
  };
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
  return ["InvtPart", "NonInvtPart"].includes(String(line?.item_type || ""))
    && String(line?.line_id ?? "").trim() !== "";
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
function localLineForPayload(order, functionKey, orderLine) {
  const transferFulfillmentOffset = functionKey !== "receiving" && order.order_type === "transfer_order" ? 1 : 0;
  const localLineKey = orderLine - transferFulfillmentOffset;
  const line = (order.lines || []).find((/** @type {Record<string, any>} */ candidate) => Number(candidate.line_id) === localLineKey);
  if (!line) {
    throw resolutionError(
      "OPERATOR_NETSUITE_POSTING_SOURCE_UNRESOLVED",
      `NetSuite line ${orderLine} could not be mapped to ${order.tranid || order.netsuite_id}.`
    );
  }
  return line;
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
  const authoritativeIdentityPresent = source.availableLines.some((/** @type {Record<string, any>} */ line) => (
    line?.sourceLineKey || (Array.isArray(line?.sourceLineAliases) && line.sourceLineAliases.length)
  ));
  return {
    sourceOrderKind: source.sourceOrderKind,
    sourceNetSuiteId: Number(source.sourceNetSuiteId),
    sourceOrderRef: String(source.sourceOrderRef || ""),
    selectedLines: selectedItems.map((/** @type {Record<string, any>} */ item) => {
      const localLine = localLineForPayload(order, functionKey, Number(item.orderLine));
      const sourceLineKey = String(localLine.line_id);
      const candidates = source.availableLines.filter((/** @type {Record<string, any>} */ available) => {
        if (!authoritativeIdentityPresent) {return Number(available.orderLine) === Number(item.orderLine);}
        return lineAliases([available.sourceLineKey, available.sourceLineAliases || []]).includes(sourceLineKey);
      });
      if (candidates.length !== 1 || !positiveInteger(candidates[0].orderLine)) {
        throw resolutionError(
          "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED",
          `Local line ${sourceLineKey} did not map uniquely to the NetSuite REST source sublist.`
        );
      }
      return {
        orderLine: Number(candidates[0].orderLine),
        quantity: Number(item.quantity),
        location: item.location ?? null,
        localOrderKey: orderKey,
        localLineId: String(localLine.id ?? localLine.line_id),
        ...(authoritativeIdentityPresent ? { sourceLineKey } : {})
      };
    }),
    availableLines: source.availableLines,
    localPayload: payload
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
      const localPayload = functionKey === "receiving" && targets.length === 1
        ? targets[0]?.localPayload || null
        : null;
      const allowNetSuiteCompleted = targets.some((/** @type {Record<string, any>} */ target) => target.selectedLines.some((/** @type {Record<string, any>} */ selected) => {
        const available = target.availableLines.find((/** @type {Record<string, any>} */ line) => Number(line.orderLine) === Number(selected.orderLine));
        return Number.isFinite(Number(available?.remainingQuantity))
          && Number(available.remainingQuantity) + 0.000001 < Number(selected.quantity);
      }));
      return {
        ...baseResolution,
        localOnly,
        localPayload,
        allowNetSuiteCompleted,
        targets: targets.map(({ localPayload: _localPayload, ...target }) => target)
      };
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
 * @param {{query: Function, fetchLiveSource?: Function}} dependencies
 */
export function createOperatorNetSuitePostingRealSourceResolver({ query: runQuery, fetchLiveSource }) {
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
      `SELECT line.line_id AS source_line_key,
              COALESCE(line.location_id, parent.outbound_location_id) AS location_id
         FROM sales_order_lines line
         JOIN sales_orders parent ON parent.netsuite_id = line.sales_order_id
        WHERE line.sales_order_id = $1
          AND line.item_type IN ('InvtPart', 'NonInvtPart')
          AND line.line_id IS NOT NULL
        ORDER BY line.line_id, line.id`,
      [sourceNetSuiteId]
    );
  } else if (sourceOrderKind === "PO") {
    rows = await runQuery(
      `SELECT line.line_id AS source_line_key,
              COALESCE(line.location_id, parent.destination_location_id) AS location_id
         FROM purchase_order_lines line
         JOIN purchase_orders parent ON parent.netsuite_id = line.purchase_order_id
        WHERE line.purchase_order_id = $1
          AND line.item_type IN ('InvtPart', 'NonInvtPart')
          AND line.line_id IS NOT NULL
        ORDER BY line.line_id, line.id`,
      [sourceNetSuiteId]
    );
  } else {
    const lineStage = functionKey === "receiving" ? "receiving" : "outbound";
    rows = await runQuery(
      `SELECT line.line_id AS source_line_key, NULL::bigint AS location_id
         FROM transfer_order_lines line
        WHERE line.transfer_order_id = $1
          AND line.line_stage = $2
          AND line.item_type IN ('InvtPart', 'NonInvtPart')
          AND line.line_id IS NOT NULL
        ORDER BY line.line_id, line.id`,
      [sourceNetSuiteId, lineStage]
    );
  }
  if (typeof fetchLiveSource !== "function") {
    throw resolutionError(
      "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED",
      "The authoritative NetSuite source-line reader is unavailable."
    );
  }
  const live = await fetchLiveSource({ sourceOrderKind, sourceNetSuiteId, functionKey });
  const expectedStage = functionKey === "receiving" ? "receiving" : "outbound";
  const relevantLines = (live?.lines || []).filter((/** @type {Record<string, any>} */ line) => (
    !line.stage || line.stage === expectedStage
  ));
  const unresolved = relevantLines.some((/** @type {Record<string, any>} */ line) => (
    line.identityStatus !== "exact" || !positiveInteger(line.restOrderLine)
  ));
  const duplicateRestLines = new Set();
  for (const line of relevantLines) {
    const restLine = Number(line.restOrderLine);
    if (duplicateRestLines.has(restLine)) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED",
        `NetSuite source ${sourceOrderRef || sourceNetSuiteId} returned duplicate REST line ${restLine}.`
      );
    }
    duplicateRestLines.add(restLine);
  }
  if (!relevantLines.length || unresolved) {
    throw resolutionError(
      "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED",
      `NetSuite source ${sourceOrderRef || sourceNetSuiteId} has a missing or ambiguous transform-line identity.`
    );
  }
  for (const row of rows.rows || []) {
    const sourceLineKey = String(row.source_line_key || "").trim();
    const candidates = relevantLines.filter((/** @type {Record<string, any>} */ line) => (
      reconciliationSourceLineAliases(line).includes(sourceLineKey)
    ));
    if (!sourceLineKey || candidates.length !== 1) {
      throw resolutionError(
        "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED",
        `Local source line ${sourceLineKey || "(missing)"} did not map uniquely to NetSuite.`
      );
    }
  }
  return {
    sourceOrderKind,
    sourceNetSuiteId,
    sourceOrderRef,
    availableLines: relevantLines.map((/** @type {Record<string, any>} */ line) => {
      const matchingLocal = (rows.rows || []).find((/** @type {Record<string, any>} */ row) => reconciliationSourceLineAliases(line)
        .includes(String(row.source_line_key || "")));
      return {
        sourceLineKey: String(line.sourceLineKey || reconciliationSourceLineAliases(line)[0]),
        sourceLineAliases: reconciliationSourceLineAliases(line),
        orderLine: Number(line.restOrderLine),
        location: line.location === null || line.location === undefined
          ? matchingLocal?.location_id === null || matchingLocal?.location_id === undefined
            ? null
            : Number(matchingLocal.location_id)
          : Number(line.location),
        orderedQuantity: positiveNumber(line.quantity ?? line.orderedQuantity),
        completedQuantity: positiveNumber(line.completedQuantity),
        remainingQuantity: positiveNumber(line.remainingQuantity),
        linkedTransactions: Array.isArray(line.linkedTransactions) ? line.linkedTransactions : []
      };
    }).sort((/** @type {Record<string, any>} */ left, /** @type {Record<string, any>} */ right) => left.orderLine - right.orderLine)
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

const fetchLiveSourceFromNetSuite = createOperatorNetSuitePostingLiveSourceFetcher({
  fetchReconciliationOrders: fetchScmReconciliationOrdersFromNetSuite,
  fetchSourceItemLines: fetchOperatorNetSuiteSourceItemLinesFromNetSuite,
  fetchLinkedTransactions: fetchPoToLinkedTransactionsFromNetSuite
});
const resolveRealSourceFromDatabase = createOperatorNetSuitePostingRealSourceResolver({
  query,
  fetchLiveSource: fetchLiveSourceFromNetSuite
});
const readReceivingOrder = createOperatorNetSuiteReceivingOrderReader({
  getLocalCoReceivingOrder,
  getReceivableReceivingOrder: (/** @type {unknown} */ orderId) => getReceivableReceivingOrder(orderId, {
    includeNetSuiteClosed: true
  })
});

export const resolveOperatorNetSuitePostingTargets = createOperatorNetSuitePostingTargetResolver({
  getDeliveryOrder: (/** @type {unknown} */ orderId) => getDeliveryOrder(orderId, { includeNetSuiteClosed: true }),
  getReceivableReceivingOrder: readReceivingOrder,
  resolveRealSource: resolveRealSourceFromDatabase
});
