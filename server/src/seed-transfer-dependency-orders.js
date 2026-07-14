import { closeDb, query } from "./db.js";
import { processNetSuiteOrderWebhook } from "./server.js";
import { isNetSuiteSandboxEnvironment } from "./config.js";
import { listTransferDependencyCandidates } from "./order-dependency-repository.js";

const YARDS = Object.freeze([
  { id: 1, code: "3445" },
  { id: 28, code: "2967" },
  { id: 15, code: "12441" },
  { id: 26, code: "150" }
]);

const CUSTOMER_SITES = Object.freeze([
  "235 Don Park Road, Markham, ON L3R 1C2",
  "100 Milverton Drive, Mississauga, ON L5R 4H1",
  "195 Milner Avenue, Scarborough, ON M1S 3R1",
  "50 Interchange Way, Vaughan, ON L4K 5C3",
  "33 City Centre Drive, Mississauga, ON L5B 2N5",
  "225 Commissioners Street, Toronto, ON M4M 0A1",
  "20 Roybridge Gate, Woodbridge, ON L4H 1E6",
  "200 Basaltic Road, Concord, ON L4K 1G6",
  "35 Sinclair Avenue, Georgetown, ON L7G 4X4",
  "75 Steelcase Road East, Markham, ON L3R 1E9"
]);

function quantity(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function rounded(value) {
  return Number(quantity(value).toFixed(6));
}

function isoDate(daysFromToday) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + daysFromToday);
  return value.toISOString().slice(0, 10);
}

function displayQuantities(baseQuantity, item) {
  let remaining = quantity(baseQuantity);
  const result = { palletQty: 0, layerQty: 0, sectionQty: 0, pieceQty: 0 };
  for (const [field, conversion] of [
    ["palletQty", item.to_plt],
    ["layerQty", item.to_lyr],
    ["sectionQty", item.to_sec],
    ["pieceQty", item.to_pcs]
  ]) {
    const factor = quantity(conversion);
    if (!factor || remaining <= 0) continue;
    const units = Math.floor((remaining / factor) + 0.000001);
    if (!units) continue;
    result[field] = units;
    remaining = rounded(remaining - (units * factor));
  }
  if (!quantity(item.to_plt) && !quantity(item.to_lyr) && !quantity(item.to_sec) && !quantity(item.to_pcs)) {
    result.pieceQty = rounded(baseQuantity);
  }
  return result;
}

async function loadSeedItems() {
  const result = await query(
    `SELECT i.item_id, i.item_name, i.display_name, i.item_description,
            i.item_type, i.item_type_text, i.stock_unit, i.to_plt, i.to_lyr,
            i.to_sec, i.to_pcs, i.item_weight,
            jsonb_object_agg(b.location_id::text, b.quantity_available)
              FILTER (WHERE b.location_id IN (1, 15, 26, 28)) AS balances,
            MAX(b.quantity_available) FILTER (WHERE b.location_id IN (1, 15, 26, 28)) AS maximum_available
       FROM inventory_items i
       JOIN inventory_balances b ON b.item_id = i.item_id
      WHERE b.location_id IN (1, 15, 26, 28)
        AND b.quantity_available > 0
        AND (
          COALESCE(i.item_type_text, '') ILIKE '%inventory%'
          OR COALESCE(i.item_type, '') ILIKE '%invtpart%'
        )
        AND COALESCE(i.item_name, '') !~* '(delivery|freight|sales credit|discount|^pallet$)'
      GROUP BY i.item_id, i.item_name, i.display_name, i.item_description,
               i.item_type, i.item_type_text, i.stock_unit, i.to_plt, i.to_lyr,
               i.to_sec, i.to_pcs, i.item_weight
      ORDER BY
        CASE WHEN COALESCE(i.to_plt, 0) > 0 THEN 0 ELSE 1 END,
        MAX(b.quantity_available) DESC
      LIMIT 50`
  );
  if (!result.rows.length) {
    throw new Error("No active inventory items with available stock were found in the four dependency yards.");
  }
  return result.rows;
}

function buildOrder(index, item) {
  const balances = item.balances || {};
  const sourceYard = [...YARDS]
    .sort((left, right) => quantity(balances[String(right.id)]) - quantity(balances[String(left.id)]))[0];
  const destinationOptions = YARDS.filter((yard) => yard.id !== sourceYard.id);
  const destinationYard = destinationOptions[index % destinationOptions.length];
  const sourceAvailable = quantity(balances[String(sourceYard.id)]);
  const palletSize = quantity(item.to_plt);
  const desired = palletSize
    ? palletSize * (2 + (index % 3))
    : Math.max(quantity(item.to_pcs), 1) * (10 + index);
  const backordered = rounded(Math.min(desired, Math.max(sourceAvailable * 0.4, Math.min(sourceAvailable, 1))));
  const quantities = displayQuantities(backordered, item);
  const orderNumber = String(index + 1).padStart(3, "0");
  const orderId = 9_900_714_001 + index;

  return {
    payload: {
      recordType: "salesorder",
      eventType: "test_seed",
      id: orderId,
      tranid: `TSTDEP-SO-${orderNumber}`,
      trandate: isoDate(0),
      entityId: 9_900_700 + index,
      entityText: `Dependency Test Customer ${orderNumber}`,
      status: "B",
      statusText: "Sales Order : Pending Fulfillment",
      memo: `TEST ONLY - Auto Transfer shortage from ${sourceYard.code} to ${destinationYard.code}. Deliver to ${CUSTOMER_SITES[index]}`,
      expectedDeliveryDate: isoDate(1 + (index % 4)),
      foreignTotal: 1000 + (index * 250),
      locationId: destinationYard.id,
      locationText: destinationYard.code,
      deliveryMethodId: 2,
      deliveryMethodText: "Delivery",
      lines: [{
        uniqueKey: (orderId * 100) + 1,
        itemId: Number(item.item_id),
        itemName: item.item_name,
        itemType: item.item_type || "InvtPart",
        itemTypeText: item.item_type_text || "Inventory Item",
        itemDescription: item.item_description || item.display_name || item.item_name,
        quantity: backordered,
        quantityCommitted: 0,
        quantityBackordered: backordered,
        quantityFulfilled: 0,
        unitText: item.stock_unit || "EA",
        itemWeight: quantity(item.item_weight),
        locationId: destinationYard.id,
        locationText: destinationYard.code,
        custcol_plt: quantities.palletQty,
        custcol_lyr: quantities.layerQty,
        custcol_sec: quantities.sectionQty,
        custcol_pcs: quantities.pieceQty,
        custitem_toplt: quantity(item.to_plt),
        custitem_tolyr: quantity(item.to_lyr),
        custitem_tosec: quantity(item.to_sec),
        custitem_topcs: quantity(item.to_pcs)
      }]
    },
    sourceYard: sourceYard.code,
    destinationYard: destinationYard.code,
    available: sourceAvailable,
    backordered,
    itemName: item.item_name
  };
}

async function run() {
  if (!isNetSuiteSandboxEnvironment()) {
    throw new Error("Refusing to seed Auto Transfer test orders because the active NetSuite account is not sandbox.");
  }
  const items = await loadSeedItems();
  const selected = Array.from({ length: 10 }, (_, index) => items[index % items.length]);
  const orders = selected.map((item, index) => buildOrder(index, item));

  for (const order of orders) {
    await processNetSuiteOrderWebhook(order.payload, { scheduleDelayedStatus: false });
  }
  await query(
    `UPDATE sales_orders
        SET is_test_fixture = true
      WHERE tranid LIKE 'TSTDEP-SO-%'`
  );

  const candidates = await query(
    `SELECT o.tranid, o.outbound_location, l.item_name, l.quantity,
            l.netsuite_backordered_qty, l.unit
       FROM sales_orders o
       JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
      WHERE o.tranid LIKE 'TSTDEP-SO-%'
      ORDER BY o.tranid`
  );
  const visibleCandidates = await listTransferDependencyCandidates({ search: "TSTDEP", reviewStatus: "all" });

  console.log(JSON.stringify({
    ok: true,
    inserted: orders.length,
    visibleCandidateCount: visibleCandidates.length,
    visibleCandidateRefs: visibleCandidates.map((order) => order.salesOrderRef),
    note: "Synthetic orders were processed through processNetSuiteOrderWebhook().",
    orders: orders.map((order) => ({
      tranid: order.payload.tranid,
      item: order.itemName,
      shortage: order.backordered,
      unit: order.payload.lines[0].unitText,
      recommendedSource: order.sourceYard,
      outboundYard: order.destinationYard,
      sourceAvailable: order.available
    })),
    databaseRows: candidates.rows
  }, null, 2));
}

try {
  await run();
} finally {
  await closeDb();
}
