import { createOperator } from "./auth-repository.js";
import { closeDb, query, withTransaction } from "./db.js";
import { confirmDeliveryLine, getDeliveryOrder, recordDeliveryLoad, setDeliveryLinePackedQuantity } from "./delivery-repository.js";
import { upsertLocalCoOrder } from "./dispatch-repository.js";
import { recordDriverJobPhotos } from "./driver-repository.js";
import { confirmLocalCoReceivingLine } from "./receiving-repository.js";
import { getYardMovementDetail } from "./yard-movement-repository.js";

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const orderId = 9960000000 + Number(runId.slice(-6));
const lineId = Number(runId.slice(-8));
const groupedOrderIds = [orderId + 10000000, orderId + 20000000];
const photos = [
  "data:image/png;base64,bXVsdGktcGhvdG8tMQ==",
  "data:image/png;base64,bXVsdGktcGhvdG8tMg=="
];

function check(condition, message, details = {}) {
  if (!condition) throw new Error(`${message} ${JSON.stringify(details)}`);
}

async function expectedError(action, pattern) {
  try {
    await action();
  } catch (error) {
    check(pattern.test(error.message), "Unexpected validation error.", { message: error.message });
    return error.message;
  }
  throw new Error("Expected validation error was not thrown.");
}

async function main() {
  const result = await withTransaction(async () => {
    const operator = await createOperator({
      username: `photo_pallet_${runId}`,
      displayName: "Photo PALLET Harness",
      password: "Rollback123",
      role: "operator"
    });
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         operator_status, local_yard_order_status, fulfillment_status,
         netsuite_active, is_test_fixture
       ) VALUES ($1, $2, current_date, 'Harness Customer', 'B', 'Pending Fulfillment',
         1, '3445', 'Delivery', 'open', 'Open', 'open', true, false)`,
      [orderId, `PALLET-HARNESS-${runId}`]
    );
    const line = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         quantity, unit, location_id, location,
         pallet_qty, layer_qty, section_qty, piece_qty,
         to_plt, to_lyr, to_sec, to_pcs,
         packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
         packed_sales_qty, loaded_qty, netsuite_active
       ) VALUES ($1, $2, 1784, 'PALLET', 'PALLET', 'InvtPart',
         7, 'EACH', 1, '3445',
         0, 0, 0, 0,
         0, 0, 0, 0,
         0, 0, 0, 0,
         0, 0, true)
       RETURNING id`,
      [orderId, lineId]
    );
    const storageLineId = line.rows[0].id;

    await confirmDeliveryLine(orderId, storageLineId, { pieces: 7, salesQty: 7 }, operator.id);
    let packed = (await query(
      `SELECT packed_piece_qty, packed_sales_qty, confirmed
         FROM sales_order_lines
        WHERE id = $1`,
      [storageLineId]
    )).rows[0];
    check(Number(packed.packed_piece_qty) === 0, "PALLET must not be stored as pieces.", packed);
    check(Number(packed.packed_sales_qty) === 7, "PALLET sales quantity was not packed.", packed);
    check(packed.confirmed === true, "PALLET line was not confirmed.", packed);

    await setDeliveryLinePackedQuantity(orderId, storageLineId, { pieces: 3, salesQty: 3 }, operator.id);
    packed = (await query(
      `SELECT packed_piece_qty, packed_sales_qty
         FROM sales_order_lines
        WHERE id = $1`,
      [storageLineId]
    )).rows[0];
    check(Number(packed.packed_piece_qty) === 0, "PALLET edit moved quantity into pieces.", packed);
    check(Number(packed.packed_sales_qty) === 3, "PALLET edit did not update sales quantity.", packed);

    await query("UPDATE sales_orders SET operator_status = 'packed' WHERE netsuite_id = $1", [orderId]);
    const loadPhotoError = await expectedError(
      () => recordDeliveryLoad(orderId, operator.id, { photoDataUrls: photos.slice(0, 1) }),
      /At least 2 photos are required/i
    );
    const driverPhotoError = await expectedError(
      () => recordDriverJobPhotos("photo-harness", `PHOTO-${runId}`, {
        photoDataUrls: photos.slice(0, 1),
        job: { requiredPhotos: 2 }
      }),
      /2 photos are required/i
    );

    const load = await recordDeliveryLoad(orderId, operator.id, { photoDataUrls: photos });
    const loadRecord = (await query(
      `SELECT photo_data_url, photo_data_urls
         FROM operator_load_records
        WHERE id = $1`,
      [load.id]
    )).rows[0];
    check(loadRecord.photo_data_url === photos[0], "Legacy first-photo reference was not retained.", loadRecord);
    check(Array.isArray(loadRecord.photo_data_urls) && loadRecord.photo_data_urls.length === 2, "All load photos were not persisted.", loadRecord);

    const groupPlan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       SELECT candidate::date, 'confirmed', 'Grouped PALLET harness'
         FROM generate_series(DATE '2095-01-01', DATE '2095-12-31', INTERVAL '1 day') candidate
        WHERE NOT EXISTS (SELECT 1 FROM dispatch_plans p WHERE p.plan_date = candidate::date)
        ORDER BY candidate
        LIMIT 1
       RETURNING id, plan_date`
    );
    check(groupPlan.rowCount === 1, "Could not reserve a dispatch plan date for grouped PALLET regression.");
    const groupRefs = [`PALLET-GROUP-A-${runId}`, `PALLET-GROUP-B-${runId}`];
    for (let index = 0; index < groupedOrderIds.length; index += 1) {
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer, status, status_text,
           outbound_location_id, outbound_location, sales_order_type,
           operator_status, local_yard_order_status, fulfillment_status,
           netsuite_active, is_test_fixture
         ) VALUES ($1, $2, current_date, 'Grouped PALLET Harness', 'B', 'Pending Fulfillment',
           1, '3445', 'Delivery', 'open', 'Open', 'open', true, false)`,
        [groupedOrderIds[index], groupRefs[index]]
      );
      await query(
        `INSERT INTO sales_order_lines (
           sales_order_id, line_id, item_id, item_name, sku, item_type,
           quantity, unit, location_id, location,
           pallet_qty, layer_qty, section_qty, piece_qty,
           to_plt, to_lyr, to_sec, to_pcs,
           packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
           packed_sales_qty, loaded_qty, netsuite_active
         ) VALUES ($1, $2, 1784, 'PALLET', 'PALLET', 'InvtPart',
           $3, 'EACH', 1, '3445',
           0, 0, 0, CASE WHEN $3::numeric = 4 THEN $3::numeric ELSE 0 END,
           0, 0, 0, 0,
           0, 0, 0, 0,
           0, 0, true)`,
        [groupedOrderIds[index], lineId + index + 1, index === 0 ? 4 : 6]
      );
    }
    const groupRef = `GOA-PALLET-${runId}`;
    await query(
      `INSERT INTO dispatch_delivery_groups (
         group_ref, plan_id, plan_date, order_type, truck_plate, load_name, active
       ) VALUES ($1, $2, $3, 'sales_order', 'PALLET-TRUCK', 'PALLET Load', true)`,
      [groupRef, groupPlan.rows[0].id, groupPlan.rows[0].plan_date]
    );
    await query(
      `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
       VALUES ($1, $2, 0), ($1, $3, 1)`,
      [groupRef, groupRefs[0], groupRefs[1]]
    );
    const groupedOrder = await getDeliveryOrder(groupRef);
    const groupedPallet = groupedOrder?.lines?.find((item) => Number(item.item_id) === 1784);
    check(String(groupedPallet?.id || "").startsWith("GRPLINE-"), "Grouped PALLET line was not synthesized.", groupedOrder || {});
    check(Number(groupedPallet?.piece_qty) === 4, "Grouped PALLET regression must include the legacy piece-quantity shape.", groupedPallet || {});
    await confirmDeliveryLine(groupRef, groupedPallet.id, { pieces: 10, salesQty: 10 }, operator.id);
    const groupedPacked = await query(
      `SELECT packed_piece_qty, packed_sales_qty
         FROM sales_order_lines
        WHERE sales_order_id = ANY($1::bigint[])
        ORDER BY sales_order_id`,
      [groupedOrderIds]
    );
    check(
      groupedPacked.rows.reduce((sum, row) => sum + Number(row.packed_piece_qty || 0), 0) === 0,
      "Grouped PALLET quantity must not be stored as pieces.",
      groupedPacked.rows
    );
    check(
      groupedPacked.rows.reduce((sum, row) => sum + Number(row.packed_sales_qty || 0), 0) === 10,
      "Grouped PALLET sales quantity was not allocated to its source lines.",
      groupedPacked.rows
    );
    const groupedAudit = await query(
      `SELECT line_id, details
         FROM delivery_audit_log
        WHERE action = 'delivery.group.line.confirm'
          AND details->>'groupId' = $1
        ORDER BY id DESC
        LIMIT 1`,
      [groupRef]
    );
    check(groupedAudit.rowCount === 1, "Grouped PALLET audit was not written.");
    check(groupedAudit.rows[0].line_id === null, "Synthetic grouped line ID was written into numeric audit line_id.", groupedAudit.rows[0]);
    check(groupedAudit.rows[0].details?.groupLineId === groupedPallet.id, "Synthetic grouped line ID was not retained in audit details.", groupedAudit.rows[0]);

    const co = await upsertLocalCoOrder({
      sourceOrderRef: groupRef,
      fromYard: "3445",
      toYard: "2967",
      requestedBy: operator.id,
      order: {
        id: groupRef,
        type: "SO",
        childOrderDetails: [
          {
            id: groupRefs[0],
            raw: { pickup_location: "3445" },
            items: [{ lineId: lineId + 101, lineRowId: lineId + 201, itemId: 1784, itemName: "PALLET", sku: "PALLET", quantity: 4, pieces: 4, unit: "EACH" }]
          },
          {
            id: groupRefs[1],
            raw: { pickup_location: "2967" },
            items: [{ lineId: lineId + 102, lineRowId: lineId + 202, itemId: 1784, itemName: "PALLET", sku: "PALLET", quantity: 6, pieces: 6, unit: "EACH" }]
          }
        ]
      }
    });
    check(co.lines.length === 1, "Grouped CO must contain only child lines from its source yard.", co.lines);
    check(Number(co.lines[0].item_id) === 1784 && Number(co.lines[0].quantity) === 4,
      "Grouped CO omitted or mis-sized the source-yard PALLET line.", co.lines[0]);
    await confirmDeliveryLine(co.co_ref, co.lines[0].id, { pieces: 4, salesQty: 4 }, operator.id);
    const packedCo = await getDeliveryOrder(co.co_ref);
    const packedCoPallet = packedCo.lines.find((line) => Number(line.item_id) === 1784);
    const storedCoPallet = (await query(
      "SELECT packed_piece_qty, packed_sales_qty FROM local_co_order_lines WHERE co_id = $1 AND id = $2",
      [co.id, co.lines[0].id]
    )).rows[0];
    check(Number(storedCoPallet?.packed_piece_qty) === 0 && Number(storedCoPallet?.packed_sales_qty) === 4,
      "Local CO no-conversion quantity must be stored only in packed_sales_qty.", storedCoPallet || {});
    check(Number(packedCoPallet?.packed_piece_qty) === 0 && Number(packedCoPallet?.packed_sales_qty) === 4,
      "Local CO response must expose the persisted packed sales quantity.", packedCoPallet || {});
    await query("UPDATE local_co_orders SET status = 'packed' WHERE id = $1", [co.id]);
    const coLoad = await recordDeliveryLoad(co.co_ref, operator.id, { photoDataUrls: photos });
    const coLoadRecord = (await query(
      "SELECT order_family, load_type FROM operator_load_records WHERE id = $1",
      [coLoad.id]
    )).rows[0];
    check(coLoadRecord.order_family === "co_order" && coLoadRecord.load_type === "local_co_load",
      "Local CO outbound load record must retain the CO order family.", coLoadRecord);
    const coMovement = await getYardMovementDetail({
      direction: "outbound",
      orderType: "co_order",
      orderId: co.id,
      from: "2000-01-01",
      to: "2099-12-31"
    });
    check(coMovement?.lines?.length === 1 && Number(coMovement.lines[0].item_id) === 1784,
      "CO outbound movement must use its processed line snapshot.", coMovement || {});
    await confirmLocalCoReceivingLine(co.co_ref, co.lines[0].id, { pieces: 4, salesQty: 4 }, operator.id);
    const receivedCoPallet = (await query(
      `SELECT canonical.received_piece_qty,
              canonical.received_sales_qty,
              local.received_sales_qty AS local_received_sales_qty
         FROM co_order_lines canonical
         JOIN local_co_order_lines local ON local.id = canonical.id
        WHERE canonical.co_id = $1
          AND canonical.id = $2`,
      [co.id, co.lines[0].id]
    )).rows[0];
    check(Number(receivedCoPallet?.received_piece_qty) === 0
        && Number(receivedCoPallet?.received_sales_qty) === 4
        && Number(receivedCoPallet?.local_received_sales_qty) === 4,
      "Local CO no-conversion receiving must persist received_sales_qty in both canonical and local lines.",
      receivedCoPallet || {});

    return {
      palletPackedSalesQty: Number(packed.packed_sales_qty),
      groupedPalletPackedSalesQty: groupedPacked.rows.reduce((sum, row) => sum + Number(row.packed_sales_qty || 0), 0),
      groupedCoPalletQty: Number(co.lines[0].quantity),
      coPackedSalesQty: Number(packedCoPallet.packed_sales_qty),
      coReceivedSalesQty: Number(receivedCoPallet.received_sales_qty),
      coLoadOrderFamily: coLoadRecord.order_family,
      coMovementLineCount: coMovement.lines.length,
      loadPhotoCount: loadRecord.photo_data_urls.length,
      loadPhotoError,
      driverPhotoError
    };
  }, { rollback: true });

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

try {
  await main();
} finally {
  await closeDb();
}
