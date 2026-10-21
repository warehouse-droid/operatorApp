// Read-only production export. Run through stdin from /app; no production
// credentials or volumes are copied to the disposable replay environments.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { pool, closeDb } from "./src/db.js";

const hash = value => crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex").slice(0, 20);
const location = value => {
  if (value == null || !String(value).trim()) return value;
  // Preserve hierarchy and the application's technical yard codes. The same
  // physical location is anonymized identically in orders, routes and lines.
  return String(value).split(/\s*:\s*/u).map(part =>
    ["3445", "2967", "12441", "150", "195"].includes(part.trim().toLowerCase())
      ? part.trim() : `location-${hash(part)}`).join(" : ");
};
const keys = new Set(`id orderId orderRef tranid refNumber type orderType orderKind sourceTable sourceOrderId
  originalOrderId originalPoRef sourcePoRef sourcePoRefs correspondingPoRefs relatedSoId
  childOrders childOrderDetails groupAliases groupPlanId groupPlanDate planOwned
  globalGroupDefinition globalGroupSourcePlanId globalGroupSourcePlanDate
  globalOrderDefinition globalOrderDefinitionKind globalOrderSourcePlanId globalOrderSourcePlanDate
  isSplit isGrouped catalogHydrated specialPalletTotal pallets layers sections pieces salesQty quantity
  committedQty weight totalWeightLbs sourceYard outboundLocation destinationYard destinationLocationId
  destinationLocation sourceLocation sourceLocationId fromYard toYard pickupLocations pickupAddressOverride
  address destinationAddress sourceAddress pickupAddress dropAddress location yard base startYard switchYard
  status statusText localDispatchStatus completionStatus dispatchCompletionStatus reconciliationStatus
  historicalReconciliationComplete historicalPlanDate dependencyDirectPickup dependencyWaitingForTransfer
  dependencyAttention dependencyUncovered dependencyUncoveredQuantity dependencyLabels orderDependencies
  transitCo transitOriginalSourceYard directPickupManifest poPickupManifest poRouteProjection toRouteProjection
  poAllocations allocations dependencies items lines dropoffs version dependencyId transferOrderRef
  salesOrderRef canonicalSalesOrderRef dispatchTargetRef dispatchTargetKind targetLineKey mode
  accountingDestinationLocation dispatchDestinationLocation transferReceived transferReceivingStatus
  transferStatusText sourceLocation destinationLocation transferOrderId salesOrderId
  parentOrderRef coRef receivingStatus rentalEquipment dispatchServiceFee
  itemId item_id itemName item_name name sku description item_description itemType item_type itemTypeText
  item_type_text lineRowId lineId line_id sourceLineId salesLineId poLineId purchaseOrderId poOrderId poOrderRef
  lineRowIds sourceLineIds sourceOrderRef lineRole unit uom toPlt toLyr toSec toPcs to_plt to_lyr to_sec to_pcs
  palletQty layerQty sectionQty pieceQty pallet_qty layer_qty section_qty piece_qty salesQuantityOnly
  allocatedQuantity allocatedSalesQty poAllocatedPallets poAllocatedLayers poAllocatedSections
  poAllocatedPieces poAllocatedSalesQty receivedQuantity fulfilledQuantity loadedQty
  receivedPallets receivedLayers receivedSections receivedPieces receivedSalesQty
  salesQtyAvailable poAvailableSalesQty key destinationLocationId orderRefs order_id order_ref order_ref_number
  orderNumber order_ref order_ref_number order_id order_ref tranid stopType stop_type stopId stop_id
  pickupVisitId pickupLocation pickupYard dropLocation dropoffKey visitId start finish plannedStartMinute
  plannedFinishMinute arrival departure eta etd timing stops loads loadId load_id truckId truck_id
  returnOnly ownYardCodes ownYards code testOnly saveRecovery applied checkpoint_kind
  quantityMode physicalQuantityMode splitQty splitPallets splitLayers splitSections splitPieces
  dispatchPlanningRestricted dispatchPlanningRestrictionReason sorRentalReturn dispatchPlanned
  firstSeenAt createdAt updatedAt expectedDeliveryDate`.split(/\s+/u));
const locationKeys = new Set(`sourceYard outboundLocation destinationYard destinationLocation sourceLocation fromYard toYard
  transitOriginalSourceYard accountingDestinationLocation dispatchDestinationLocation pickupLocation pickupYard
  dropLocation location yard base startYard switchYard address destinationAddress sourceAddress pickupAddress
  dropAddress pickupAddressOverride`.split(/\s+/u));
function clean(value, key = "") {
  if (Array.isArray(value)) return value.map(entry => clean(entry, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([name]) => keys.has(name)).map(([name, entry]) => [name, clean(entry, name)]));
  if (locationKeys.has(key) || key === "pickupLocations") return location(value);
  if (["description", "item_description"].includes(key) && value) return `description-${hash(value)}`;
  return value;
}
const headerFields = `netsuite_id tranid trandate status status_text netsuite_active dispatch_parse_source
  outbound_location_id outbound_location order_location_id order_location sales_order_type fulfillment_status
  operator_status local_yard_order_status destination_location_id destination_location source_location_id
  source_location dispatch_ref original_po_ref`.split(/\s+/u);
const lineFields = `id sales_order_id purchase_order_id line_id item_id item_name sku item_description item_type
  item_type_text quantity unit location_id location pallet_qty layer_qty section_qty piece_qty to_plt to_lyr
  to_sec to_pcs netsuite_active netsuite_received_qty netsuite_received_baseline_qty netsuite_backordered_qty
  received_pallet_qty received_layer_qty received_section_qty received_piece_qty fulfilled_pallet_qty
  fulfilled_layer_qty fulfilled_section_qty fulfilled_piece_qty confirmed loaded_qty loaded_uom`.split(/\s+/u);
const allocationFields = `id sales_order_id sales_order_ref sales_line_id po_order_id po_order_ref po_line_id
  item_id item_name sku allocated_pallet_qty allocated_layer_qty allocated_section_qty allocated_piece_qty
  allocated_sales_qty status created_at updated_at cancelled_at dispatch_target_ref dispatch_target_kind
  dispatch_target_line_key`.split(/\s+/u);
const pick = (object, fields) => Object.fromEntries(fields.filter(key => object[key] !== undefined)
  .map(key => [key, /(?:^|_)location$|^outbound_location$/u.test(key) ? location(object[key])
    : key === "item_description" && object[key] ? `description-${hash(object[key])}` : object[key]]));
const refs = new Set(), poIds = new Set(), poRefs = new Set();
function collect(order = {}) {
  for (const ref of [order.id, order.originalOrderId, order.sourceOrderId,
    ...(order.childOrders || []), ...(order.sourcePoRefs || [])]) if (ref) refs.add(String(ref));
  if (String(order.type).toUpperCase() === "PO") poRefs.add(String(order.id));
  for (const entry of [...(order.poAllocations || []), ...(order.poPickupManifest || [])]) {
    if (entry.poOrderRef) poRefs.add(String(entry.poOrderRef));
    if (entry.poOrderId) poIds.add(String(entry.poOrderId));
  }
  for (const child of order.childOrderDetails || []) collect(child);
}
const counts = {};
async function emit(kind, data) {
  counts[kind] = (counts[kind] || 0) + 1;
  if (!process.stdout.write(JSON.stringify({ kind, ...data }) + "\n")) await once(process.stdout, "drain");
}
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='30s'");
  assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
  await emit("capture", { capturedAt: new Date().toISOString(), readOnly: true, window: { from: "2026-10-08", to: "2026-10-14" },
    scope: "All retained planning snapshots containing PO projection fields through October 15, plus every October 8–14 snapshot and all retained PO allocation/link/unlink outcomes",
    anonymization: "Customer/operator/driver/contact/memo/raw fields excluded; addresses and product descriptions hashed; technical identities and quantities preserved" });
  await client.query(`DECLARE history_cursor NO SCROLL CURSOR FOR
    SELECT h.id,h.plan_id,h.plan_date::text,h.revision,h.archive_reason,h.checkpoint_kind,
      h.archived_at,h.orders,h.trucks,h.summary,p.status,p.note
    FROM dispatch_plan_snapshot_history h JOIN dispatch_plans p ON p.id=h.plan_id
    WHERE h.plan_date <= '2026-10-15' AND
      (h.orders::text LIKE '%poPickupManifest%' OR h.orders::text LIKE '%poAllocatedSalesQty%'
        OR h.plan_date BETWEEN '2026-10-08' AND '2026-10-14') ORDER BY h.plan_date,h.archived_at,h.id`);
  while (true) {
    const batch = (await client.query("FETCH FORWARD 10 FROM history_cursor")).rows;
    if (!batch.length) break;
    for (const row of batch) {
      row.orders.forEach(collect);
      await emit("state", { key: `history:${row.id}`, planId: row.plan_id, planDate: row.plan_date,
        revision: row.revision, status: row.status, archiveReason: row.archive_reason,
        rejectedRecovery: row.archive_reason === "save_recovery" && row.checkpoint_kind === "recovery"
          && row.summary?.saveRecovery?.applied === false,
        orders: clean(row.orders), trucks: clean(row.trucks), summary: clean(row.summary || {}) });
    }
  }
  await client.query("CLOSE history_cursor");
  const current = (await client.query(`SELECT s.plan_id,p.plan_date::text,p.revision,p.status,s.orders,s.trucks,s.summary
    FROM dispatch_plan_snapshots s JOIN dispatch_plans p ON p.id=s.plan_id
    WHERE p.plan_date <= '2026-10-15' AND
      (s.orders::text LIKE '%poPickupManifest%' OR s.orders::text LIKE '%poAllocatedSalesQty%'
        OR p.plan_date BETWEEN '2026-10-08' AND '2026-10-14') ORDER BY p.plan_date,s.plan_id`)).rows;
  for (const row of current) {
    row.orders.forEach(collect);
    await emit("state", { key: `current:${row.plan_id}`, planId: row.plan_id, planDate: row.plan_date,
      revision: row.revision, status: row.status, rejectedRecovery: false,
      orders: clean(row.orders), trucks: clean(row.trucks), summary: clean(row.summary || {}) });
  }
  const allocations = (await client.query("SELECT * FROM dispatch_so_po_allocations ORDER BY created_at,id")).rows;
  for (const row of allocations) {
    refs.add(row.sales_order_ref); refs.add(row.dispatch_target_ref || row.sales_order_ref);
    poIds.add(String(row.po_order_id)); poRefs.add(row.po_order_ref);
    await emit("allocation", { row: pick(row, allocationFields) });
  }
  const receipts = (await client.query(`SELECT request_id,action,status,created_at,
    result->'allocations' AS allocations,result->>'allocationId' AS allocation_id,
    result->>'orderRef' AS order_ref,result->>'status' AS result_status
    FROM scm_dependency_action_receipts WHERE action IN ('link_po','unlink_po') ORDER BY created_at,request_id`)).rows;
  for (const row of receipts) {
    await emit("receipt", { requestId: row.request_id, action: row.action, status: row.status,
      createdAt: row.created_at, allocations: clean(row.allocations || []), allocationId: row.allocation_id,
      orderRef: row.order_ref, resultStatus: row.result_status });
  }
  for (const [table, kind, refField] of [["dispatch_global_order_groups", "group", "group_ref"],
    ["dispatch_global_order_splits", "split", "split_ref"]]) {
    const rows = (await client.query(`SELECT * FROM ${table} WHERE order_type='SO' ORDER BY ${refField}`)).rows;
    for (const row of rows) {
      collect(row.full_order);
      await emit("definition", { definitionType: kind, ref: row[refField], active: row.active,
        parentRef: row.parent_order_ref || "", definitionKind: row.definition_kind || "group",
        sourcePlanDate: String(row.source_plan_date?.toISOString?.() || row.source_plan_date).slice(0, 10),
        order: clean(row.full_order) });
    }
  }
  const sales = (await client.query("SELECT to_jsonb(s) AS row FROM sales_orders s WHERE tranid=ANY($1::text[]) ORDER BY tranid", [[...refs]])).rows;
  for (const { row } of sales) await emit("salesHeader", { row: pick(row, headerFields) });
  const salesIds = sales.map(({ row }) => row.netsuite_id);
  const salesLines = (await client.query(`SELECT to_jsonb(l) AS row FROM sales_order_lines l
    WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,line_id NULLS LAST,id`, [salesIds])).rows;
  for (const { row } of salesLines) await emit("salesLine", { row: pick(row, lineFields) });
  const purchases = (await client.query(`SELECT to_jsonb(p) AS row FROM purchase_orders p
    WHERE netsuite_id=ANY($1::bigint[]) OR tranid=ANY($2::text[]) OR dispatch_ref=ANY($2::text[]) ORDER BY netsuite_id`,
  [[...poIds], [...poRefs]])).rows;
  for (const { row } of purchases) await emit("purchaseHeader", { row: { ...pick(row, headerFields),
    vendor: "Historical replay vendor", dispatch_vendor_yard: location(row.dispatch_vendor_yard || "historical-vendor"),
    dispatch_address: location(row.dispatch_address || "historical-vendor-address") } });
  const purchaseLines = (await client.query(`SELECT to_jsonb(l) AS row FROM purchase_order_lines l
    WHERE purchase_order_id=ANY($1::bigint[]) ORDER BY purchase_order_id,line_id NULLS LAST,id`,
  [purchases.map(({ row }) => row.netsuite_id)])).rows;
  for (const { row } of purchaseLines) await emit("purchaseLine", { row: pick(row, lineFields) });
  await client.query("COMMIT");
  await emit("end", { complete: true, counts });
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await closeDb();
}
