import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import {
  getYardMovementDetail,
  listYardMovementCsvRows,
  listYardMovements
} from "./yard-movement-repository.js";
import { salesStoreLocationIdForOrderRef } from "./sales-store.js";
import { yardMixedUnits } from "./yard-quantity.js";

assert.equal(salesStoreLocationIdForOrderRef("SOA05107"), 28, "SOA must belong to the 2967 Sales store.");
assert.equal(salesStoreLocationIdForOrderRef("sob115895"), 1, "SOB must belong to the 3445 Sales store.");
assert.equal(salesStoreLocationIdForOrderRef(" SOM05107 "), 26, "SOM must belong to the 150 Sales store.");
assert.equal(salesStoreLocationIdForOrderRef("SOC00001"), null, "Unknown SO prefixes must not leak into a Sales store.");

assert.deepEqual(
  yardMixedUnits({ processed_qty: 61.5, to_plt: 61.5, to_lyr: 10.25 }).units.map(({ label, value }) => ({ label, value })),
  [{ label: "PLT", value: 1 }],
  "61.5 SQFT should decompose to exactly 1 PLT"
);
assert.deepEqual(
  yardMixedUnits({ processed_qty: 71.75, to_plt: 61.5, to_lyr: 10.25 }).units.map(({ label, value }) => ({ label, value })),
  [{ label: "PLT", value: 1 }, { label: "LYR", value: 1 }],
  "71.75 SQFT should decompose to 1 PLT and 1 LYR"
);

const range = { from: "2000-01-01", to: "2099-12-31", yard: "all" };
const movementTypes = {
  inbound: ["purchase_order", "transfer_order", "co_order"],
  outbound: ["sales_order", "transfer_order", "co_order", "vrma_order"]
};

async function verifyExistingMovements() {
  const allMovements = [];
  for (const [direction, orderTypes] of Object.entries(movementTypes)) {
    for (const orderType of orderTypes) {
      const rows = await listYardMovements({ ...range, direction, orderType });
      assert.ok(Array.isArray(rows), `${direction}/${orderType} should return an array`);
      for (const row of rows) {
        assert.equal(row.direction, direction);
        assert.equal(row.order_type, orderType);
        assert.ok(row.order_id, `${direction}/${orderType} row should retain its order ID`);
        assert.ok(
          row.last_activity_at || row.last_processed_at,
          `${direction}/${orderType} row should retain its latest activity timestamp`
        );
      }
      allMovements.push(...rows);
    }
  }

  if (allMovements.length) {
    const movement = allMovements[0];
    const detail = await getYardMovementDetail({
      ...range,
      direction: movement.direction,
      orderType: movement.order_type,
      orderId: movement.order_id
    });
    assert.ok(detail, "Movement detail should exist for a listed movement");
    assert.equal(detail.order.direction, movement.direction);
    assert.equal(detail.order.order_type, movement.order_type);
    assert.ok(Array.isArray(detail.lines), "Movement detail should include lines");
    assert.ok(Array.isArray(detail.photos), "Movement detail should include photos");

    const searchableLine = detail.lines.find((line) => line.sku || line.item_name || line.item_description || line.item_id);
    if (searchableLine) {
      const itemTerm = searchableLine.sku || searchableLine.item_name || searchableLine.item_description || String(searchableLine.item_id);
      const itemMatches = await listYardMovements({ ...range, itemSearch: itemTerm });
      assert.ok(itemMatches.some((row) =>
        row.direction === movement.direction
        && row.order_type === movement.order_type
        && String(row.order_id) === String(movement.order_id)
      ), "Global item search should return the processed order containing that item");
    }

    const processedDate = new Date(movement.last_activity_at || movement.last_processed_at).toISOString().slice(0, 10);
    const csvRows = await listYardMovementCsvRows({
      from: processedDate,
      to: processedDate,
      yard: "all",
      direction: movement.direction,
      orderType: movement.order_type,
      search: movement.tranid || String(movement.order_id)
    });
    assert.ok(Array.isArray(csvRows), "CSV query should return rows");
    for (const row of csvRows) {
      assert.equal(row.direction, movement.direction);
      assert.equal(row.order_type, movement.order_type);
      assert.ok(Object.hasOwn(row, "last_activity_at"));
      assert.ok(Object.hasOwn(row, "delivery_at"));
      assert.ok(Object.hasOwn(row, "driver_only"));
      if (!row.driver_only) {
        assert.ok(Object.hasOwn(row, "processed_qty"));
        assert.ok(Object.hasOwn(row, "to_plt"));
        assert.ok(Object.hasOwn(row, "to_lyr"));
        assert.ok(Object.hasOwn(row, "to_sec"));
        assert.ok(Object.hasOwn(row, "to_pcs"));
      }
    }
  }
  return allMovements.length;
}

function driverRecordsFrom(detail) {
  return detail?.driverRecords || detail?.driver_records || detail?.deliveryRecords || detail?.delivery_records || [];
}

function photoReferences(detail) {
  const photos = [
    ...(detail?.photos || []),
    ...(detail?.driverPhotos || detail?.driver_photos || [])
  ];
  return new Set(photos.map((photo) =>
    photo.photo_data_url || photo.photoDataUrl || photo.url || ""
  ).filter(Boolean));
}

async function verifyDriverDeliveryRecords() {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orderId = 9980000000 + Number(runId.slice(-6));
  const lineId = Number(runId.slice(-8));
  const orderRef = `SOB${runId}`;
  const fixtureDate = "2098-07-25";
  const driverPhotos = [
    "data:image/png;base64,ZHJpdmVyLXByb29mLTE=",
    "data:image/png;base64,ZHJpdmVyLXByb29mLTI="
  ];
  const yardPhoto = "data:image/png;base64,eWFyZC1wcm9vZg==";

  await withTransaction(async () => {
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         operator_status, local_yard_order_status, fulfillment_status,
         netsuite_active, is_test_fixture
       ) VALUES (
         $1, $2, $3::date, 'Driver Record Harness Customer', 'B', 'Pending Fulfillment',
         15, '12441', 'Delivery',
         'open', 'Open', 'open',
         true, false
       )`,
      [orderId, orderRef, fixtureDate]
    );
    const line = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_description, item_type,
         quantity, unit, location_id, location,
         pallet_qty, layer_qty, section_qty, piece_qty,
         to_plt, to_lyr, to_sec, to_pcs,
         loaded_qty, loaded_uom, fulfilled_pallet_qty, fulfilled_layer_qty,
         fulfilled_section_qty, fulfilled_piece_qty, netsuite_active
       ) VALUES (
         $1, $2, 1784, 'Driver Record Harness Item', 'DRIVER-ITEM',
         'Driver-only delivery detail', 'InvtPart',
         12, 'EA', 1, '3445',
         0, 0, 0, 12,
         0, 0, 0, 1,
         0, 'EA', 0, 0,
         0, 0, true
       )
       RETURNING id`,
      [orderId, lineId]
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, photo_data_urls, status,
         started_at, completed_at, job_details
       ) VALUES (
         $1, $2::date, 'driver-record-harness', 'TRUCK-DRIVER-RECORD', 'TEST-124',
         'LOAD-DRIVER-RECORD', 'Driver Record Harness Load',
         'STOP-DRIVER-RECORD', 'dropoff', $3::jsonb, $4::jsonb, 'complete',
         $5::timestamptz, $6::timestamptz, $7::jsonb
       )`,
      [
        `JOB-DRIVER-RECORD-${runId}`,
        fixtureDate,
        JSON.stringify([orderRef]),
        JSON.stringify(driverPhotos),
        `${fixtureDate}T13:00:00.000Z`,
        `${fixtureDate}T14:00:00.000Z`,
        JSON.stringify({
          driverName: "Driver Record Harness",
          location: "Harness Delivery Location",
          address: "100 Harness Delivery Address",
          dropLocation: "Harness Delivery Location",
          dropAddress: "100 Harness Delivery Address",
          windowStart: "13:00",
          windowEnd: "15:00",
          instructions: "Harness delivery instructions",
          orderTypes: ["SO"],
          orders: [{
            orderRef,
            party: "Driver Record Harness Customer",
            items: [{
              itemName: "Driver Record Harness Item",
              sku: "DRIVER-ITEM",
              description: "Driver-only delivery detail",
              units: [{ label: "PCS", value: 12 }]
            }]
          }]
        })
      ]
    );

    const fixtureFilters = {
      from: fixtureDate,
      to: fixtureDate,
      yard: "all",
      direction: "outbound",
      orderType: "sales_order",
      search: orderRef
    };
    const driverOnlyRows = await listYardMovements(fixtureFilters);
    const driverOnly = driverOnlyRows.find((row) => String(row.order_id) === String(orderId));
    assert.ok(driverOnly, "A completed driver stop must create an In/Outbound Record without a Yard processing row");
    assert.equal(
      driverOnlyRows.filter((row) => String(row.order_id) === String(orderId)).length,
      1,
      "A driver-only order must be represented by one consolidated order record"
    );
    assert.equal(Number(driverOnly.process_count), 0, "A driver-only order must not invent a Yard processing activity");
    assert.equal(Number(driverOnly.driver_record_count), 1, "The driver stop must count as one driver activity");
    assert.equal(Number(driverOnly.photo_count), 2, "Driver proof photos must contribute to the order photo count");
    assert.equal(
      new Date(driverOnly.last_activity_at).toISOString(),
      `${fixtureDate}T14:00:00.000Z`,
      "The completed driver stop must supply the delivery timestamp"
    );
    assert.equal(
      new Date(driverOnly.delivery_at).toISOString(),
      `${fixtureDate}T14:00:00.000Z`,
      "The driver dropoff must expose its explicit delivery timestamp"
    );
    const wrongYardRows = await listYardMovements({
      ...fixtureFilters,
      allowedYardLocationIds: [1]
    });
    assert.ok(
      !wrongYardRows.some((row) => String(row.order_id) === String(orderId)),
      "Physical Yard scoping must exclude a driver-only record from a Yard that did not ship it"
    );
    const allowedYardRows = await listYardMovements({
      ...fixtureFilters,
      allowedYardLocationIds: [15]
    });
    assert.ok(
      allowedYardRows.some((row) => String(row.order_id) === String(orderId)),
      "Physical Yard scoping must retain the Yard that shipped the driver-only order"
    );
    const wrongSalesStoreRows = await listYardMovements({
      ...fixtureFilters,
      allowedSalesStoreLocationIds: [15]
    });
    assert.ok(
      !wrongSalesStoreRows.some((row) => String(row.order_id) === String(orderId)),
      "Sales store scoping must not treat the outbound Yard as the selling store"
    );
    const allowedSalesStoreRows = await listYardMovements({
      ...fixtureFilters,
      allowedSalesStoreLocationIds: [1]
    });
    assert.ok(
      allowedSalesStoreRows.some((row) => String(row.order_id) === String(orderId)),
      "The 3445 Sales store must see its SOB driver-only record even when 12441 shipped it"
    );
    const selectedSalesStoreRows = await listYardMovements({
      ...fixtureFilters,
      yard: "1",
      allowedSalesStoreLocationIds: [1]
    });
    assert.ok(
      selectedSalesStoreRows.some((row) => String(row.order_id) === String(orderId)),
      "The Sales page Yard selector must represent the 3445 selling store for SOB records"
    );
    const outboundYardSelectedAsStoreRows = await listYardMovements({
      ...fixtureFilters,
      yard: "15",
      allowedSalesStoreLocationIds: [1]
    });
    assert.ok(
      !outboundYardSelectedAsStoreRows.some((row) => String(row.order_id) === String(orderId)),
      "Selecting 12441 in the Sales module must not grant access to an SOB record merely because it shipped there"
    );

    const driverOnlyDetail = await getYardMovementDetail({
      ...fixtureFilters,
      orderId,
      allowedSalesStoreLocationIds: [1]
    });
    assert.ok(driverOnlyDetail, "Driver-only In/Outbound Record detail must exist");
    assert.equal(driverOnlyDetail.lines.length, 0, "Driver-only detail must not invent a processed Yard quantity");
    const driverOnlyRecords = driverRecordsFrom(driverOnlyDetail);
    assert.equal(driverOnlyRecords.length, 1, "Driver-only detail must expose its driver delivery record");
    assert.match(
      JSON.stringify(driverOnlyRecords[0]),
      /100 Harness Delivery Address/,
      "Driver delivery details must include the captured delivery address"
    );
    assert.deepEqual(
      [...photoReferences(driverOnlyDetail)].sort(),
      [...driverPhotos].sort(),
      "Driver-only detail must expose every driver proof photo"
    );
    const forbiddenSalesStoreDetail = await getYardMovementDetail({
      ...fixtureFilters,
      orderId,
      allowedSalesStoreLocationIds: [15]
    });
    assert.equal(forbiddenSalesStoreDetail, null,
      "Sales detail authorization must use the SOB store instead of the 12441 outbound Yard.");

    await query(
      `UPDATE sales_order_lines
          SET loaded_qty = 12,
              loaded_uom = 'EA',
              fulfilled_piece_qty = 12
        WHERE id = $1`,
      [line.rows[0].id]
    );
    await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref, operator_id,
         photo_data_url, photo_data_urls, loaded_qty, loaded_uom,
         line_snapshot, response, created_at
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2, NULL,
         $3, $4::jsonb, 12, 'EA',
         '[]'::jsonb, '{}'::jsonb, $5::timestamptz
       )`,
      [
        orderId,
        orderRef,
        yardPhoto,
        JSON.stringify([yardPhoto]),
        `${fixtureDate}T12:30:00.000Z`
      ]
    );

    const combinedRows = await listYardMovements(fixtureFilters);
    const combinedMatches = combinedRows.filter((row) => String(row.order_id) === String(orderId));
    assert.equal(combinedMatches.length, 1, "Yard and driver activities must consolidate into one order record");
    assert.equal(Number(combinedMatches[0].process_count), 1, "The consolidated record must retain its Yard activity");
    assert.equal(Number(combinedMatches[0].driver_record_count), 1, "The consolidated record must retain its driver activity");
    assert.equal(Number(combinedMatches[0].photo_count), 3, "The consolidated record must count Yard and driver photos");
    const combinedSalesStoreRows = await listYardMovements({
      ...fixtureFilters,
      allowedSalesStoreLocationIds: [1]
    });
    assert.ok(
      combinedSalesStoreRows.some((row) => String(row.order_id) === String(orderId)),
      "The selling store must retain access after Yard and driver records are combined"
    );
    const salesStoreCsvRows = await listYardMovementCsvRows({
      ...fixtureFilters,
      allowedSalesStoreLocationIds: [1]
    });
    const salesStoreCsvRow = salesStoreCsvRows.find((row) => String(row.order_ref) === orderRef);
    assert.ok(salesStoreCsvRow, "Sales CSV export must retain the selling store's combined record");
    assert.equal(salesStoreCsvRow.yard_location, "12441",
      "Sales store authorization must not rewrite the physical outbound Yard shown in records and CSV.");

    const combinedDetail = await getYardMovementDetail({
      ...fixtureFilters,
      orderId
    });
    assert.equal(combinedDetail.lines.length, 1, "The consolidated record must retain the processed Yard line");
    assert.equal(driverRecordsFrom(combinedDetail).length, 1, "The consolidated record must retain its driver delivery");
    assert.deepEqual(
      [...photoReferences(combinedDetail)].sort(),
      [...driverPhotos, yardPhoto].sort(),
      "The consolidated record must append driver proof to the Yard proof"
    );
  }, { rollback: true });
}

let existingMovementCount = 0;
try {
  existingMovementCount = await verifyExistingMovements();
  await verifyDriverDeliveryRecords();
  console.log(`Yard movement integration harness passed (${existingMovementCount} existing orders plus driver delivery fixtures).`);
} finally {
  await closeDb();
}
