import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  confirmDeliveryLine,
  getCurrentOperatorDeliveryDraft,
  getDeliveryBootstrap,
  getDeliveryOrder,
  listVrmaDeliveryPrepOrders,
  recordDeliveryLoad,
  updateDeliveryStatus
} from "./delivery-repository.js";
import {
  createScmVrmaOrder,
  getScmVrmaOrder,
  getScmVrmaOptions,
  listDispatchOrders,
  listScmSchedule,
  searchScmVrmaItems,
  syncScmScheduleFromDispatchPlan,
  updateScmScheduleEntry
} from "./dispatch-repository.js";

const suffix = String(Date.now());
const ref = `VRMA-HARNESS-${suffix}`;
const vendor = `VRMA Vendor ${suffix}`;
const vendorYard = `Vendor Yard ${suffix}`;
const vendorAddress = `100 ${suffix.slice(-4)} Test Vendor Road, Toronto, ON`;
const convertedItemId = Number(`98${suffix.slice(-11)}`);
const genericItemId = convertedItemId + 1;
const convertedSku = `VRMA-CONV-${suffix}`;
const genericSku = `VRMA-GENERIC-${suffix}`;

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function assertRejects(action, pattern, message) {
  try {
    await action();
  } catch (error) {
    assert(pattern.test(String(error?.message || error)), message, { error: error?.message });
    return;
  }
  throw new Error(message);
}

function payload(overrides = {}) {
  return {
    vrmaRef: ref,
    localVendor: vendor,
    pickupLocation: "3445",
    dropoffLocation: vendorYard,
    status: "Queued",
    notes: "VRMA rollback harness",
    lines: [
      {
        itemId: convertedItemId,
        palletQty: 2,
        layerQty: 3,
        pieceQty: 4
      },
      {
        itemId: genericItemId,
        quantity: 1200,
        unit: "SQFT"
      }
    ],
    createdBy: "scm-vrma-harness",
    ...overrides
  };
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO dispatch_local_vendors (name, active, updated_by)
       VALUES ($1, true, 'scm-vrma-harness')`,
      [vendor]
    );
    await query(
      `INSERT INTO dispatch_vendor_yards (
         vendor, yard, address, day_label, window_start, window_end, instructions, active
       ) VALUES ($1, $2, $3, 'Mon-Fri', '09:00', '15:00', 'Call vendor receiving', true)`,
      [vendor, vendorYard, vendorAddress]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit, item_weight,
         item_type, item_type_text, to_plt, to_lyr, to_sec, to_pcs
       ) VALUES
         ($1, $2, 'Converted VRMA Test Item', 'Converted dispatch reference', 'SQFT', 0.5, 'InvtPart', 'Inventory Item', 100, 10, NULL, 1),
         ($3, $4, 'Generic VRMA Test Item', 'Generic dispatch reference', 'SQFT', 0.25, 'NonInvtPart', 'Non-Inventory Item', NULL, NULL, NULL, NULL)`,
      [convertedItemId, convertedSku, genericItemId, genericSku]
    );

    const options = await getScmVrmaOptions();
    const optionVendor = options.localVendors.find((entry) => entry.name === vendor);
    assert(options.ownYards.some((yard) => yard.code === "3445")
        && optionVendor?.yards.some((yard) => yard.name === vendorYard && yard.address === vendorAddress),
      "VRMA options must expose own yards and only the selected local vendor's yards.",
      { options });

    const itemMatches = await searchScmVrmaItems({ search: suffix.slice(-7) });
    const convertedMatch = itemMatches.find((item) => Number(item.itemId) === convertedItemId);
    const genericMatch = itemMatches.find((item) => Number(item.itemId) === genericItemId);
    assert(convertedMatch?.toPlt === 100 && convertedMatch?.toLyr === 10 && convertedMatch?.toPcs === 1 && convertedMatch?.itemWeight === 0.5,
      "Item autocomplete must expose configured conversion inputs.",
      { convertedMatch });
    assert(genericMatch && !genericMatch.toPlt && !genericMatch.toLyr && !genericMatch.toSec && !genericMatch.toPcs,
      "Item autocomplete must preserve the no-conversion fallback case.",
      { genericMatch });

    await assertRejects(
      () => createScmVrmaOrder(payload({ pickupLocation: vendorYard })),
      /our local yards/i,
      "VRMA must reject a vendor yard as its pickup."
    );
    await assertRejects(
      () => createScmVrmaOrder(payload({ dropoffLocation: "Not This Vendor's Yard" })),
      /not an active yard/i,
      "VRMA must reject a drop-off that does not belong to the selected local vendor."
    );
    await assertRejects(
      () => createScmVrmaOrder(payload({
        lines: [{ itemId: genericItemId, quantity: 5, unit: "LYR" }]
      })),
      /must be PLT, SQFT, or PC/i,
      "A no-conversion VRMA item must only accept PLT, SQFT, or PC."
    );

    const created = await createScmVrmaOrder(payload());
    assert(created.vrma.pickup_location === "3445"
        && created.vrma.dropoff_location === vendorYard
        && created.vrma.local_vendor === vendor
        && created.vrma.method === "MBT",
      "Persisted VRMA route must remain own yard to selected vendor yard.",
      { vrma: created.vrma });

    const detail = await getScmVrmaOrder(ref);
    const detailConverted = detail?.lines.find((line) => Number(line.itemId) === convertedItemId);
    const detailGeneric = detail?.lines.find((line) => Number(line.itemId) === genericItemId);
    assert(detail?.vrmaRef === ref
        && detail?.localVendor === vendor
        && detail?.pickupLocation === "3445"
        && detail?.dropoffLocation === vendorYard
        && detail?.lines.length === 2
        && detailConverted?.description === "Converted dispatch reference"
        && detailConverted?.toPlt === 100
        && detailConverted?.palletQty === 2
        && detailGeneric?.unit === "SQFT"
        && detailGeneric?.quantity === 1200,
      "Saved VRMA detail must repopulate every editable route and line field.",
      { detail });

    const stored = await query(
      `SELECT item_id, quantity, unit, weight_lbs, pallet_qty, layer_qty, section_qty, piece_qty,
              to_plt, to_lyr, to_sec, to_pcs
         FROM scm_vrma_order_lines
        WHERE vrma_order_id = $1
        ORDER BY item_id`,
      [created.vrma.id]
    );
    const convertedLine = stored.rows.find((line) => Number(line.item_id) === convertedItemId);
    const genericLine = stored.rows.find((line) => Number(line.item_id) === genericItemId);
    assert(Number(convertedLine?.quantity) === 234
        && Number(convertedLine?.pallet_qty) === 2
        && Number(convertedLine?.layer_qty) === 3
        && Number(convertedLine?.piece_qty) === 4
        && Number(convertedLine?.to_plt) === 100
        && Number(convertedLine?.weight_lbs) === 117,
      "Converted quantities must be retained and produce the correct stock-unit reference total.",
      { convertedLine });
    assert(Number(genericLine?.quantity) === 1200
        && genericLine?.unit === "SQFT"
        && Number(genericLine?.pallet_qty) === 0
        && Number(genericLine?.weight_lbs) === 300,
      "No-conversion quantities must retain their selected fallback UOM without fake pallets.",
      { genericLine });

    await updateScmScheduleEntry({
      orderKind: "VRMA",
      orderRef: ref,
      patch: { method: "Vendor", pickupPoint: vendorYard, dropoffPoint: "3445", brand: "Wrong Vendor" },
      updatedBy: "scm-vrma-harness"
    });
    const schedules = await listScmSchedule({ kind: "VRMA", search: ref });
    const schedule = schedules.find((entry) => entry.orderRef === ref);
    assert(schedule?.method === "MBT"
        && schedule?.pickupPoint === "3445"
        && schedule?.dropoffPoint === vendorYard
        && schedule?.brand === vendor
        && schedule?.content.includes("2 PLT")
        && schedule?.content.includes("1200 SQFT"),
      "Schedule edits must not reverse a VRMA route and must retain reference quantities.",
      { schedule });

    const orders = await listDispatchOrders({ type: "PO", includeHiddenScm: true });
    const order = orders.find((entry) => entry.id === ref);
    const dispatchConverted = order?.items.find((item) => Number(item.itemId) === convertedItemId);
    const dispatchGeneric = order?.items.find((item) => Number(item.itemId) === genericItemId);
    assert(order?.sourceTable === "scm_vrma_orders"
        && order?.type === "PO"
        && order?.sourceYard === "3445"
        && order?.pickupLocations.includes("3445")
        && order?.destinationYard === vendorYard
        && order?.address === vendorAddress,
      "VRMA must appear in the dispatch PO list as an own-yard to vendor-yard movement.",
      { order });
    assert(order?.pallets === 2
        && dispatchConverted?.pallets === 2
        && dispatchConverted?.layers === 3
        && dispatchConverted?.pieces === 4
        && dispatchGeneric?.unit === "SQFT"
        && Number(dispatchGeneric?.quantity) === 1200
        && Number(dispatchGeneric?.pallets) === 0,
      "Dispatch and driver-plan reference data must retain explicit converted and fallback quantities.",
      { order });

    const unplannedBootstrap = await getDeliveryBootstrap({ locationId: 1 });
    const operatorVrma = unplannedBootstrap.orders.vrmaOrder.find((entry) => entry.tranid === ref);
    assert(operatorVrma?.order_type === "vrma_order"
        && operatorVrma?.vrma_reference_only === false
        && operatorVrma?.vrma_local_only === true
        && operatorVrma?.dispatch_planned === false
        && operatorVrma?.outbound_location === "3445"
        && operatorVrma?.destination_location === vendorYard,
      "An unplanned VRMA must appear at its pickup yard in the Operator Batch B source data.",
      { operatorVrma });
    const wrongYardBootstrap = await getDeliveryBootstrap({ locationId: 28 });
    assert(!wrongYardBootstrap.orders.vrmaOrder.some((entry) => entry.tranid === ref),
      "VRMA must not appear in Operator Delivery Prep at a different yard.",
      { wrongYardOrders: wrongYardBootstrap.orders.vrmaOrder });

    const operatorDetail = await getDeliveryOrder(`VRMA:${ref}`);
    const operatorConverted = operatorDetail?.lines.find((line) => Number(line.item_id) === convertedItemId);
    assert(operatorDetail?.vrma_reference_only === false
        && operatorDetail?.vrma_local_only === true
        && operatorDetail?.lines.length === 2
        && operatorConverted?.vrma_reference_only === false
        && operatorConverted?.vrma_local_only === true
        && operatorConverted?.item_type === "InvtPart"
        && Number(operatorConverted?.pallet_qty) === 2
        && Number(operatorConverted?.layer_qty) === 3
        && Number(operatorConverted?.piece_qty) === 4,
      "Operator VRMA detail must expose real item types, conversions, and local pack/load quantities.",
      { operatorDetail });

    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ('2097-12-31', 'draft', $1)
       RETURNING id`,
      [`VRMA harness ${suffix}`]
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
      [
        plan.rows[0].id,
        JSON.stringify([{ id: ref, type: "PO", sourceTable: "scm_vrma_orders" }]),
        JSON.stringify([{
          plate: "VRMA-101",
          loads: [{
            name: "VRMA Load 1",
            parkingSpot: "B-1",
            stops: [{ type: "drop", orderId: ref }]
          }]
        }])
      ]
    );
    await syncScmScheduleFromDispatchPlan({
      id: plan.rows[0].id,
      planDate: "2097-12-31",
      orders: [{ id: ref, type: "PO", sourceTable: "scm_vrma_orders" }],
      trucks: [{
        plate: "VRMA-101",
        loads: [{
          name: "VRMA Load 1",
          parkingSpot: "B-1",
          stops: [{ type: "drop", orderId: ref }]
        }]
      }]
    }, { updatedBy: "scm-vrma-harness" });
    const plannedBootstrap = await getDeliveryBootstrap({ locationId: 1 });
    const plannedOperatorVrma = plannedBootstrap.orders.vrmaOrder.find((entry) => entry.tranid === ref);
    assert(plannedOperatorVrma?.dispatch_planned === true
        && plannedOperatorVrma?.dispatch_truck_plate === "VRMA-101"
        && plannedOperatorVrma?.dispatch_load_name === "VRMA Load 1",
      "Once dispatch plans a VRMA, Operator data must move it from Batch B to Planned.",
      { plannedOperatorVrma });

    const inventoryMovement = await query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_balances
        WHERE item_id = ANY($1::bigint[])`,
      [[convertedItemId, genericItemId]]
    );
    assert(inventoryMovement.rows[0]?.count === 0,
      "Creating a VRMA must not create or update inventory balances.",
      { inventoryMovement: inventoryMovement.rows[0] });
    const updated = await createScmVrmaOrder(payload({
      status: "Priority",
      notes: "Edited VRMA rollback harness",
      lines: [{ itemId: genericItemId, quantity: 75, unit: "PC" }]
    }));
    const reopened = await getScmVrmaOrder(ref);
    assert(updated.vrma.id === created.vrma.id
        && reopened?.status === "Priority"
        && reopened?.notes === "Edited VRMA rollback harness"
        && reopened?.lines.length === 1
        && Number(reopened?.lines[0]?.itemId) === genericItemId
        && reopened?.lines[0]?.quantity === 75
        && reopened?.lines[0]?.unit === "PC",
      "Editing a VRMA must update the existing header and replace its editable lines.",
      { updated: updated.vrma, reopened });

    const inventoryAfterEdit = await query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_balances
        WHERE item_id = ANY($1::bigint[])`,
      [[convertedItemId, genericItemId]]
    );
    assert(inventoryAfterEdit.rows[0]?.count === 0,
      "Editing a VRMA must remain inventory-neutral.",
      { inventoryAfterEdit: inventoryAfterEdit.rows[0] });

    const restored = await createScmVrmaOrder(payload());
    assert(restored.vrma.id === created.vrma.id,
      "A pre-packing edit must keep the original local VRMA identity.",
      { restored: restored.vrma });
    const packDetail = await getDeliveryOrder(`VRMA:${ref}`);
    const packConverted = packDetail.lines.find((line) => Number(line.item_id) === convertedItemId);
    const packGeneric = packDetail.lines.find((line) => Number(line.item_id) === genericItemId);
    const operatorResult = await query(
      `SELECT id FROM operators WHERE active = true ORDER BY created_at LIMIT 1`
    );
    const operatorId = operatorResult.rows[0]?.id;
    assert(operatorId, "The VRMA pack/load harness requires one active Operator account.");

    await confirmDeliveryLine(
      `VRMA:${ref}`,
      packConverted.id,
      { pallets: 2, layers: 3, pieces: 4 },
      operatorId
    );
    const activeDraft = await getCurrentOperatorDeliveryDraft(operatorId, { locationId: 1 });
    assert(activeDraft?.order_type === "vrma_order"
        && activeDraft?.netsuite_id === `VRMA:${ref}`
        && Number(activeDraft?.draft_line_count) === 1,
      "A VRMA packing action must become the Operator's local active draft.",
      { activeDraft });
    await confirmDeliveryLine(
      `VRMA:${ref}`,
      packGeneric.id,
      { salesQty: 1200 },
      operatorId
    );
    await updateDeliveryStatus(`VRMA:${ref}`, "packed", operatorId);

    const packedOrders = await listVrmaDeliveryPrepOrders({ locationId: 1, status: "packed" });
    const packedOrder = packedOrders.find((entry) => entry.tranid === ref);
    const packedDetail = await getDeliveryOrder(`VRMA:${ref}`);
    assert(packedOrder?.operator_status === "packed"
        && Number(packedDetail.lines.find((line) => Number(line.item_id) === convertedItemId)?.packed_pallet_qty) === 2
        && Number(packedDetail.lines.find((line) => Number(line.item_id) === genericItemId)?.packed_sales_qty) === 1200,
      "Packed VRMA quantities must be available in the Operator loading list.",
      { packedOrder, packedDetail });

    const loadResult = await recordDeliveryLoad(`VRMA:${ref}`, operatorId, {
      photoDataUrls: [
        "data:image/jpeg;base64,AA==",
        "data:image/jpeg;base64,AQ=="
      ]
    });
    const loadedDetail = await getDeliveryOrder(`VRMA:${ref}`);
    const loadRecords = await query(
      `SELECT load_type, order_family, order_id, response
         FROM operator_load_records
        WHERE order_family = 'vrma_order'
          AND order_id = $1
        ORDER BY id DESC`,
      [created.vrma.id]
    );
    assert(loadResult.localOnly === true
        && loadResult.netSuiteUpdated === false
        && loadResult.inventoryUpdated === false
        && loadedDetail.operator_status === "loaded"
        && loadedDetail.local_yard_order_status === "Loaded"
        && Number(loadedDetail.lines.find((line) => Number(line.item_id) === convertedItemId)?.loaded_qty) === 234
        && Number(loadedDetail.lines.find((line) => Number(line.item_id) === genericItemId)?.loaded_qty) === 1200
        && loadRecords.rows[0]?.load_type === "vrma_local_load"
        && loadRecords.rows[0]?.order_family === "vrma_order",
      "Loading a VRMA must create a local proof-backed record without NetSuite or inventory activity.",
      { loadResult, loadedDetail, loadRecord: loadRecords.rows[0] });

    await assertRejects(
      () => createScmVrmaOrder(payload({ notes: "Must not overwrite Operator progress" })),
      /can no longer be edited/i,
      "VRMA editing must be blocked after Operator packing or loading starts."
    );
    const inventoryAfterLoad = await query(
      `SELECT COUNT(*)::int AS count
         FROM inventory_balances
        WHERE item_id = ANY($1::bigint[])`,
      [[convertedItemId, genericItemId]]
    );
    assert(inventoryAfterLoad.rows[0]?.count === 0,
      "Operator packing and loading a VRMA must not change inventory balances.",
      { inventoryAfterLoad: inventoryAfterLoad.rows[0] });

  });
  console.log("SCM VRMA rollback harness passed.");
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await rollback.rollback();
  await closeDb();
}
