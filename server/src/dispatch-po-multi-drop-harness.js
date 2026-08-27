import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { listDispatchOrders } from "./dispatch-repository.js";

const suffix = Number(String(Date.now()).slice(-8));
const base = 993000000000 + suffix;
const poId = base + 1;
const poRef = `PO-MULTI-DROP-${suffix}`;
const vendorYard = `Multi Drop Vendor Yard ${suffix}`;
const planDate = "2097-08-12";

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function number(value) {
  return Number(value || 0);
}

function dropoffByYard(order, yard) {
  return (order?.dropoffs || []).find((dropoff) => String(dropoff.destinationYard) === String(yard));
}

const dispatchSource = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");
const tooltipSource = dispatchSource.slice(
  dispatchSource.indexOf("function showOrderTooltip(event)"),
  dispatchSource.indexOf("function showLoadTooltip(event)")
);
assert(
  /function tooltipItemsForOrder\(order, \{ pickupLocation = "", stop = null \}/.test(dispatchSource)
    && /if \(stop\?\.type === "drop"\) return dropItemsForStop\(order, stop\)\.filter\(isOperationalDispatchItem\)\.filter\(itemHasQuantity\);/.test(dispatchSource),
  "Dispatch drop tooltips must filter operational items by the hovered stop."
);
assert(
  /stopLineRowIds\.length \? stopLineRowIds : dropoffLineRowIds/.test(dispatchSource)
    && /const dropoffs = routeDropoffsForOrder\(order\);/.test(dispatchSource)
    && /const items = routeItemsForOrder\(order\);/.test(dispatchSource)
    && /if \(!lineRowIds\.size\) return dropoffs\.length > 1 \? \[\] : items;/.test(dispatchSource),
  "Drop item selection must fall back to dropoff IDs without leaking every line from an unresolved multi-drop PO."
);
assert(
  /tooltipItemRowsForOrder\(order, \{ pickupLocation, stop \}\)/.test(tooltipSource),
  "The hovered stop must be passed into tooltip item rendering."
);
assert(
  /stopAddress\(stop, order\)/.test(tooltipSource)
    && /dropFootprintPallets\(order, stop\)/.test(tooltipSource)
    && /dropWeightLbs\(order, stop\)/.test(tooltipSource),
  "Dispatch drop tooltips must use the hovered stop's address and totals."
);

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, receipt_status,
         dispatch_vendor_yard, dispatch_address, netsuite_active
       ) VALUES (
         $1, $2, $3::date, $4, 'Multi Drop Harness Vendor', 'pendingReceipt',
         'Purchase Order : Pending Receipt', 28, '2967', 'not_received',
         $5, '500 Harness Vendor Road, Toronto, ON', true
       )`,
      [poId, poRef, planDate, base + 2, vendorYard]
    );

    const insertedLines = await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, item_type, item_type_text,
         item_description, quantity, unit, item_weight, pallet_qty, layer_qty,
         section_qty, piece_qty, location_id, location, netsuite_received_qty,
         netsuite_received_baseline_qty, netsuite_active
       ) VALUES
         ($1, $2, $3, 'Harness 12441 A', 'MD-12441-A', 'InvtPart', 'Inventory Item',
          'First 12441 line', 20, 'EA', 2, 2, 0, 0, 0, 15, '12441', 0, 0, true),
         ($1, $4, $5, 'Harness 12441 B', 'MD-12441-B', 'InvtPart', 'Inventory Item',
          'Second 12441 line', 30, 'EA', 3, 3, 0, 0, 0, 15, '12441', 0, 0, true),
         ($1, $6, $7, 'Harness 2967 A', 'MD-2967-A', 'InvtPart', 'Inventory Item',
          'First 2967 line', 40, 'EA', 4, 4, 0, 0, 0, 28, '2967', 0, 0, true),
         ($1, $8, $9, 'Harness 2967 B', 'MD-2967-B', 'InvtPart', 'Inventory Item',
          'Second 2967 line', 50, 'EA', 5, 5, 0, 0, 0, 28, '2967', 0, 0, true),
         ($1, $10, $11, 'Inactive Harness 150', 'MD-150-INACTIVE', 'InvtPart', 'Inventory Item',
          'Inactive line must not create a drop', 60, 'EA', 6, 6, 0, 0, 0, 26, '150', 0, 0, false)
       RETURNING id, line_id, location_id, location, netsuite_active`,
      [
        poId,
        base + 101, base + 201,
        base + 102, base + 202,
        base + 103, base + 203,
        base + 104, base + 204,
        base + 105, base + 205
      ]
    );

    const rows = await listDispatchOrders({
      type: "PO",
      search: poRef,
      includeHiddenScm: true
    });
    const matching = rows.filter((entry) => entry.originalPoRef === poRef || entry.id === poRef);
    const order = matching[0];
    assert(matching.length === 1,
      "A multi-destination PO must remain one dispatch order.",
      { matching });
    assert(order?.pickupLocations?.length === 1 && order.pickupLocations[0] === vendorYard,
      "A multi-destination PO must retain one vendor pickup.",
      { pickupLocations: order?.pickupLocations });
    assert(Array.isArray(order?.dropoffs) && order.dropoffs.length === 2,
      "Active PO line locations must produce exactly two dispatch dropoffs.",
      { dropoffs: order?.dropoffs });

    const at12441 = dropoffByYard(order, "12441");
    const at2967 = dropoffByYard(order, "2967");
    assert(at12441 && String(at12441.destinationLocationId) === "15"
        && at12441.address === "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
      "The 12441 dropoff must use its canonical location ID and yard address.",
      { at12441 });
    assert(at2967 && String(at2967.destinationLocationId) === "28"
        && at2967.address === "2967 Kennedy Road, Toronto, ON",
      "The 2967 dropoff must use its canonical location ID and yard address.",
      { at2967 });
    assert(!(order.dropoffs || []).some((dropoff) => dropoff.destinationYard === "150"),
      "Inactive PO lines must not create a dispatch dropoff.",
      { dropoffs: order.dropoffs });

    const activeRows = insertedLines.rows.filter((line) => line.netsuite_active);
    const rowIdsByYard = (yard) => activeRows
      .filter((line) => line.location === yard)
      .map((line) => String(line.id))
      .sort();
    assert((at12441.lineRowIds || []).map(String).sort().join(",") === rowIdsByYard("12441").join(","),
      "The 12441 dropoff must reference only its two canonical PO lines.",
      { at12441, activeRows });
    assert((at2967.lineRowIds || []).map(String).sort().join(",") === rowIdsByYard("2967").join(","),
      "The 2967 dropoff must reference only its two canonical PO lines.",
      { at2967, activeRows });

    assert(number(at12441.pallets) === 5
        && number(at12441.salesQty) === 50
        && number(at12441.weight) === 130,
      "The 12441 dropoff totals must use only its line quantities.",
      { at12441 });
    assert(number(at2967.pallets) === 9
        && number(at2967.salesQty) === 90
        && number(at2967.weight) === 410,
      "The 2967 dropoff totals must use only its line quantities.",
      { at2967 });
    assert(number(order.pallets) === 14 && number(order.salesQty) === 140 && number(order.weight) === 540,
      "The PO header totals must remain the sum of both active destination manifests.",
      { order });

    const itemYards = new Map((order.items || []).map((item) => [item.sku, {
      id: String(item.destinationLocationId || ""),
      yard: item.destinationYard || ""
    }]));
    assert(itemYards.get("MD-12441-A")?.id === "15"
        && itemYards.get("MD-12441-A")?.yard === "12441"
        && itemYards.get("MD-2967-A")?.id === "28"
        && itemYards.get("MD-2967-A")?.yard === "2967",
      "Every PO line exposed to PO Split must retain its line-level destination yard.",
      { items: order.items });
  });
  console.log("Dispatch PO multi-drop rollback harness passed.");
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await rollback.rollback();
  await closeDb();
}
