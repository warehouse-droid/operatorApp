import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import {
  createReloadCycle,
  getActiveReloadCycleForOrder,
  listSalesOrderLoadAttempts,
  recordReloadLoadAttempt,
  updateReloadCycleStatus,
  updateReloadPackedQuantity
} from "./sales-order-reload-repository.js";

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const operatorId = `reload-idempotency-${runId}`;
const firstOrderId = 9960000000 + Number(runId.slice(-7));
const secondOrderId = firstOrderId + 1;
const photos = [
  "data:image/jpeg;base64,aWRlbXBvdGVuY3ktcGhvdG8tMQ==",
  "data:image/jpeg;base64,aWRlbXBvdGVuY3ktcGhvdG8tMg=="
];
const requestIds = {
  firstAuthorization: "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e201",
  firstLoad: "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e202",
  secondAuthorization: "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e203",
  secondLoad: "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e204",
  otherAuthorization: "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e205",
  otherLoad: "b2f63fd5-7b2c-4f18-9f8e-5de2a0e0e206"
};

async function seedLoadedOrder(orderId, suffix) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active
     ) VALUES (
       $1, $2, CURRENT_DATE, 'Idempotency Customer', 'B', 'Sales Order : Pending Fulfillment',
       15, '12441', 'Delivery', 'loaded', 'Loaded', 'not_fulfilled', true
     )`,
    [orderId, `SO-IDEMP-${suffix}-${runId}`]
  );
  const line = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_description,
       item_type, quantity, unit, location_id, location,
       pallet_qty, to_plt, loaded_qty, loaded_uom, netsuite_active
     ) VALUES (
       $1, $2, 1354, 'Idempotency Item', 'IDEMPOTENCY-SKU', 'Frozen re-load target',
       'InvtPart', 5, 'SQFT', 15, '12441', 1, 5, 5, 'SQFT', true
     ) RETURNING id`,
    [orderId, 72000 + suffix]
  );
  return {
    order: {
      netsuite_id: orderId,
      tranid: `SO-IDEMP-${suffix}-${runId}`,
      outbound_location_id: 15,
      status: "B",
      status_text: "Sales Order : Pending Fulfillment"
    },
    target: {
      salesOrderLineId: Number(line.rows[0].id),
      netsuiteLineId: 72000 + suffix,
      itemId: 1354,
      itemName: "Idempotency Item",
      sku: "IDEMPOTENCY-SKU",
      itemDescription: "Frozen re-load target",
      salesUom: "SQFT",
      targetSalesQty: 5,
      targetPalletQty: 1,
      targetLayerQty: 0,
      targetSectionQty: 0,
      targetPieceQty: 0,
      toPlt: 5,
      toLyr: 0,
      toSec: 0,
      toPcs: 0
    }
  };
}

async function authorizeAndPack(seed, requestId, reason) {
  const cycle = await createReloadCycle({
    order: seed.order,
    targets: [seed.target],
    reason,
    requestId,
    actor: { id: operatorId }
  });
  await updateReloadPackedQuantity({
    orderId: seed.order.netsuite_id,
    lineId: seed.target.salesOrderLineId,
    values: { pallets: 1 },
    operatorId,
    absolute: true
  });
  await updateReloadCycleStatus({ orderId: seed.order.netsuite_id, status: "packed", operatorId });
  return cycle;
}

function isRequestConflict(error) {
  return error?.code === "RELOAD_REQUEST_CONFLICT" && error?.status === 409;
}

try {
  await withTransaction(async () => {
    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids
       ) VALUES ($1, $1, 'Re-load Idempotency Operator', 'hash', 'salt', 'yard_manager', $2::text[], $3::integer[])`,
      [operatorId, ["yard_manager"], [15]]
    );
    const first = await seedLoadedOrder(firstOrderId, 1);
    const other = await seedLoadedOrder(secondOrderId, 2);

    const firstCycle = await authorizeAndPack(first, requestIds.firstAuthorization, "First physical re-load");
    const firstAttempt = await recordReloadLoadAttempt(firstOrderId, operatorId, {
      requestId: requestIds.firstLoad,
      photoDataUrls: photos
    });
    assert.equal(firstAttempt.completed, true);
    assert.equal(firstAttempt.reloadCycleId, firstCycle.id);
    const legitimateRetry = await recordReloadLoadAttempt(firstOrderId, operatorId, {
      requestId: requestIds.firstLoad,
      photoDataUrls: photos
    });
    assert.equal(legitimateRetry.id, firstAttempt.id);
    assert.equal(legitimateRetry.idempotent, true);

    const secondCycle = await authorizeAndPack(first, requestIds.secondAuthorization, "Second physical re-load");
    await assert.rejects(
      () => recordReloadLoadAttempt(firstOrderId, operatorId, {
        requestId: requestIds.firstLoad,
        photoDataUrls: photos
      }),
      isRequestConflict,
      "A request ID from an earlier cycle must not silently complete or impersonate the active cycle."
    );
    assert.equal((await getActiveReloadCycleForOrder(firstOrderId)).id, secondCycle.id);
    assert.equal((await getActiveReloadCycleForOrder(firstOrderId)).status, "packed");
    await recordReloadLoadAttempt(firstOrderId, operatorId, {
      requestId: requestIds.secondLoad,
      photoDataUrls: photos
    });

    const otherCycle = await authorizeAndPack(other, requestIds.otherAuthorization, "Other order re-load");
    await assert.rejects(
      () => recordReloadLoadAttempt(secondOrderId, operatorId, {
        requestId: requestIds.firstLoad,
        photoDataUrls: photos
      }),
      isRequestConflict,
      "A request ID must never return another Sales Order's load attempt."
    );
    assert.equal((await getActiveReloadCycleForOrder(secondOrderId)).id, otherCycle.id);
    assert.equal((await getActiveReloadCycleForOrder(secondOrderId)).status, "packed");
    await recordReloadLoadAttempt(secondOrderId, operatorId, {
      requestId: requestIds.otherLoad,
      photoDataUrls: photos
    });

    assert.equal((await listSalesOrderLoadAttempts(firstOrderId)).length, 2);
    assert.equal((await listSalesOrderLoadAttempts(secondOrderId)).length, 1);
  }, { rollback: true });

  console.log(JSON.stringify({
    ok: true,
    scenarios: 14,
    sameAttemptRetry: true,
    crossCycleReuseRejected: true,
    crossOrderReuseRejected: true
  }));
} finally {
  await closeDb();
}
