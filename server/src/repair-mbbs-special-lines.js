import { writeAudit } from "./auth-repository.js";
import { closeDb, query, withTransaction } from "./db.js";
import {
  fetchDeliveryOrderDetailsFromNetSuite,
  fetchPurchaseOrderDetailsFromNetSuite
} from "./netsuite.js";
import {
  markMissingInboundOrderLines,
  markMissingOutboundOrderLines,
  upsertPurchaseOrderLines,
  upsertSalesOrderLines
} from "./order-sync-repository.js";

const ITEM_ID = 2055;
const EPSILON = 0.000001;
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const requestedRefs = args
  .filter((arg) => arg !== "--apply")
  .map((value) => String(value || "").trim())
  .filter(Boolean);

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericId(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizedText(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function isSpecial(line) {
  return numericId(line?.item_id) === ITEM_ID;
}

function summary(line) {
  return {
    rowId: line.id ?? null,
    lineId: numericId(line.line_id ?? line.uniquekey),
    description: String(line.item_description || "").trim(),
    quantity: number(line.quantity),
    unit: String(line.unit || "").trim(),
    pallets: number(line.pallet_qty),
    layers: number(line.layer_qty),
    sections: number(line.section_qty),
    pieces: number(line.piece_qty),
    quantitySource: line.pack_quantity_source || null,
    active: line.netsuite_active ?? true
  };
}

function state(line, orderType) {
  const values = orderType === "sales"
    ? [
        line.packed_pallet_qty,
        line.packed_layer_qty,
        line.packed_section_qty,
        line.packed_piece_qty,
        line.packed_sales_qty,
        line.loaded_qty
      ]
    : [
        line.received_pallet_qty,
        line.received_layer_qty,
        line.received_section_qty,
        line.received_piece_qty,
        line.received_sales_qty
      ];
  const hasPhysicalProgress = values.some((value) => number(value) > EPSILON);
  const allocationCount = number(line.allocation_count);
  const splitCount = number(line.split_count);
  return {
    hasPhysicalProgress,
    allocationCount,
    splitCount,
    hasOperationalState: hasPhysicalProgress || allocationCount > 0 || splitCount > 0
  };
}

async function findOrders() {
  const unionSql = [
    "SELECT 'sales'::text AS order_type, so.netsuite_id, so.tranid,",
    "NULL::text AS dispatch_ref, so.outbound_location_id AS location_id FROM sales_orders so",
    "UNION ALL",
    "SELECT 'purchase'::text AS order_type, po.netsuite_id, po.tranid,",
    "po.dispatch_ref, po.destination_location_id AS location_id FROM purchase_orders po"
  ].join(" ");

  if (requestedRefs.length) {
    const refs = requestedRefs.map((value) => value.toLowerCase());
    const result = await query(
      "SELECT * FROM (" + unionSql + ") orders "
        + "WHERE lower(orders.tranid) = ANY($1::text[]) "
        + "OR lower(COALESCE(orders.dispatch_ref, '')) = ANY($1::text[]) "
        + "ORDER BY orders.order_type, orders.tranid",
      [refs]
    );
    if (!result.rowCount) {
      throw new Error("No sales or purchase orders matched: " + requestedRefs.join(", "));
    }
    return result.rows;
  }

  const result = await query(
    "SELECT orders.* FROM (" + unionSql + ") orders "
      + "WHERE EXISTS (SELECT 1 FROM delivery_audit_log audit "
      + "WHERE audit.action = 'netsuite.line.rekey' "
      + "AND audit.order_id = orders.netsuite_id "
      + "AND audit.details->>'itemId' = $1 "
      + "AND audit.details->>'table' = CASE WHEN orders.order_type = 'sales' "
      + "THEN 'sales_order_lines' ELSE 'purchase_order_lines' END) "
      + "ORDER BY orders.order_type, orders.tranid",
    [String(ITEM_ID)]
  );
  return result.rows;
}

async function localLines(order) {
  if (order.order_type === "sales") {
    const result = await query(
      "SELECT line.*, "
        + "(SELECT COUNT(*) FROM dispatch_so_po_allocations allocation "
        + "WHERE allocation.sales_line_id = line.id AND allocation.status = 'active') AS allocation_count, "
        + "0::bigint AS split_count "
        + "FROM sales_order_lines line "
        + "WHERE line.sales_order_id = $1 AND line.item_id = $2 "
        + "ORDER BY line.line_id NULLS LAST, line.id",
      [order.netsuite_id, ITEM_ID]
    );
    return result.rows;
  }
  const result = await query(
    "SELECT line.*, "
      + "(SELECT COUNT(*) FROM dispatch_so_po_allocations allocation "
      + "WHERE allocation.po_line_id = line.id AND allocation.status = 'active') AS allocation_count, "
      + "(SELECT COUNT(*) FROM dispatch_scm_po_split_lines split_line "
      + "JOIN dispatch_scm_po_splits split ON split.id = split_line.split_id "
      + "WHERE split_line.source_line_id = line.id AND split.status = 'active') AS split_count "
      + "FROM purchase_order_lines line "
      + "WHERE line.purchase_order_id = $1 AND line.item_id = $2 "
      + "ORDER BY line.line_id NULLS LAST, line.id",
    [order.netsuite_id, ITEM_ID]
  );
  return result.rows;
}

async function netSuiteLines(order) {
  const locationId = numericId(order.location_id);
  if (order.order_type === "sales") {
    return fetchDeliveryOrderDetailsFromNetSuite(order.netsuite_id, locationId);
  }
  return fetchPurchaseOrderDetailsFromNetSuite(order.netsuite_id, locationId);
}

function topology(local, remote, orderType) {
  const reasons = [];
  const remoteIds = remote.map((line) => numericId(line.line_id ?? line.uniquekey));
  const validRemoteIds = remoteIds.filter((id) => id !== null);
  const remoteSet = new Set(validRemoteIds);
  const localIds = local.map((line) => numericId(line.line_id)).filter((id) => id !== null);
  const localWithState = local.filter((line) => state(line, orderType).hasOperationalState);
  const changed = local.length !== remote.length
    || localIds.some((id) => !remoteSet.has(id))
    || validRemoteIds.some((id) => !localIds.includes(id));

  if (!remote.length) reasons.push("No live MBBS-Special lines were returned by NetSuite.");
  if (validRemoteIds.length !== remote.length) reasons.push("A NetSuite line has no valid unique line key.");
  if (new Set(validRemoteIds).size !== validRemoteIds.length) reasons.push("NetSuite returned duplicate unique line keys.");
  if (changed && localWithState.length) {
    reasons.push("Line topology differs and a local special line has packing, receiving, loading, allocation, or split history.");
  }
  for (const line of localWithState) {
    if (!remoteSet.has(numericId(line.line_id))) {
      reasons.push("Local row " + line.id + " has operational history but line key " + line.line_id + " is absent from NetSuite.");
    }
  }
  return { changed, reasons: [...new Set(reasons)] };
}

function needsRepair(local, remote) {
  if (local.length !== remote.length) return true;
  const localById = new Map(local.map((line) => [numericId(line.line_id), line]));
  return remote.some((remoteLine) => {
    const localLine = localById.get(numericId(remoteLine.line_id ?? remoteLine.uniquekey));
    if (!localLine) return true;
    return !localLine.netsuite_active
      || normalizedText(localLine.item_description) !== normalizedText(remoteLine.item_description)
      || normalizedText(localLine.unit) !== normalizedText(remoteLine.unit)
      || Math.abs(number(localLine.quantity) - number(remoteLine.quantity)) > EPSILON
      || Math.abs(number(localLine.pallet_qty) - number(remoteLine.pallet_qty)) > EPSILON
      || Math.abs(number(localLine.layer_qty) - number(remoteLine.layer_qty)) > EPSILON
      || Math.abs(number(localLine.section_qty) - number(remoteLine.section_qty)) > EPSILON
      || Math.abs(number(localLine.piece_qty) - number(remoteLine.piece_qty)) > EPSILON;
  });
}

async function repair(order, remote, local) {
  const activeLineIds = remote
    .map((line) => numericId(line.line_id ?? line.uniquekey))
    .filter((id) => id !== null);
  await withTransaction(async () => {
    if (order.order_type === "sales") {
      await upsertSalesOrderLines(order.netsuite_id, remote);
      await markMissingOutboundOrderLines(order.netsuite_id, activeLineIds);
    } else {
      await upsertPurchaseOrderLines(order.netsuite_id, remote);
      await markMissingInboundOrderLines(order.netsuite_id, activeLineIds);
    }
    await writeAudit({
      actorType: "system",
      source: "repair",
      action: "netsuite.mbbs_special_lines.repaired",
      orderId: order.netsuite_id,
      details: {
        orderType: order.order_type,
        orderRef: order.tranid,
        itemId: ITEM_ID,
        before: local.map(summary),
        after: remote.filter(isSpecial).map(summary)
      }
    });
  });
}

async function inspect(order) {
  const [local, allRemote] = await Promise.all([localLines(order), netSuiteLines(order)]);
  const remote = allRemote.filter(isSpecial);
  const comparison = topology(local, remote, order.order_type);
  const repairRequired = needsRepair(local, remote);
  const safe = comparison.reasons.length === 0;
  let applied = false;
  if (apply && safe && repairRequired) {
    await repair(order, allRemote, local);
    applied = true;
  }
  return {
    orderType: order.order_type,
    orderRef: order.tranid,
    dispatchRef: order.dispatch_ref || null,
    netsuiteId: order.netsuite_id,
    mode: apply ? "apply" : "dry-run",
    safe,
    needsRepair: repairRequired,
    wouldApply: !apply && safe && repairRequired,
    applied,
    requiresManualReview: !safe,
    reasons: comparison.reasons,
    localLines: local.map((line) => ({ ...summary(line), operationalState: state(line, order.order_type) })),
    netSuiteLines: remote.map(summary)
  };
}

try {
  const orders = await findOrders();
  const results = [];
  for (const order of orders) {
    try {
      results.push(await inspect(order));
    } catch (error) {
      results.push({
        orderType: order.order_type,
        orderRef: order.tranid,
        netsuiteId: order.netsuite_id,
        mode: apply ? "apply" : "dry-run",
        safe: false,
        applied: false,
        requiresManualReview: true,
        reasons: [error.message]
      });
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({
    itemId: ITEM_ID,
    mode: apply ? "apply" : "dry-run",
    requestedRefs,
    orderCount: results.length,
    results
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
