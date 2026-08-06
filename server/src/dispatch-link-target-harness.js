import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  createSalesOrderPoAllocations,
  enrichDispatchOrdersWithPoTargetAllocations,
  getSalesOrderPoAllocationOptions
} from "./dispatch-repository.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";
import { applyDispatchPlannedAssignment } from "./dispatch-plan-repository.js";
import {
  createOrderDependency,
  getOrderDependencyOptions,
  listOrderDependencies
} from "./order-dependency-repository.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "./order-sync-repository.js";

const suffix = Number(String(Date.now()).slice(-6));
const base = 9880000000 + suffix;
const itemId = base + 20;
const orderRefs = [`LINK-SO-A-${suffix}`, `LINK-SO-B-${suffix}`, `LINK-SO-C-${suffix}`];
const orderIds = [base + 1, base + 2, base + 3];
const groupRef = `GOA-LINK-${suffix}`;
const splitRefs = [`${orderRefs[2]}-S1`, `${orderRefs[2]}-S2`];
const transferId = base + 10;
const transferRef = `LINK-TO-${suffix}`;
const poId = base + 11;
const poRef = `LINK-PO-${suffix}`;
const planDate = "2097-07-14";

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function insertSalesOrder(orderId, orderRef, quantity, lineId) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       fulfillment_status, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active
     ) VALUES ($1, $2, $3::date, 'Link Target Harness', 'B', 'Pending Fulfillment',
       15, '12441', 'Delivery', 'open', 'open', 'Open',
       '100 Test Street, Toronto, ON', true)`,
    [orderId, orderRef, planDate]
  );
  return (await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type, item_type_text,
       quantity, unit, netsuite_committed_qty, netsuite_backordered_qty,
       netsuite_active, location_id, location, to_pcs
     ) VALUES ($1, $2, $3, 'Link Target Item', 'LINK-TARGET-SKU', 'InvtPart',
       'Inventory Item', $4, 'EA', 0, $4, true, 15, '12441', 1)
     RETURNING *`,
    [orderId, lineId, itemId, quantity]
  )).rows[0];
}

function snapshotItem(line, quantity) {
  return {
    lineRowId: line.id,
    lineId: line.line_id,
    itemId: line.item_id,
    itemName: line.item_name,
    sku: line.sku,
    quantity,
    salesQty: quantity,
    unit: line.unit
  };
}

const dispatchSource = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");
const pickupLinkHelperStart = dispatchSource.indexOf("function isMbbsSpecialLinkLine");
const pickupLinkHelperEnd = dispatchSource.indexOf("function linkQuantityInputStep", pickupLinkHelperStart);
assert(pickupLinkHelperStart >= 0 && pickupLinkHelperEnd > pickupLinkHelperStart,
  "Dispatch MBBS-Special pickup/link helpers must be present.");
const pickupLinkHelpers = Function(
  '"use strict"; '
    + dispatchSource.slice(pickupLinkHelperStart, pickupLinkHelperEnd)
    + "; return { isOperationalDispatchItem, availableUnitsForLine };"
)();
const specialUiUnits = pickupLinkHelpers.availableUnitsForLine({
  itemId: 2055,
  isSpecial: true,
  required: { unit: "PC" },
  available: { pallets: 34, salesQty: 1088 }
});
assert(JSON.stringify(specialUiUnits) === JSON.stringify([["salesQty", "Sales Qty (PC)", 1088]]),
  "MBBS-Special PO linking must expose only Sales Qty in the sales/purchase UOM.", { specialUiUnits });
assert(!pickupLinkHelpers.isOperationalDispatchItem({ sku: "Delivery Charge", quantity: 1 }),
  "Delivery Charge must not be treated as an operational pickup item.");
assert(!pickupLinkHelpers.isOperationalDispatchItem({ sku: "Handling", itemType: "OthCharge", quantity: 1 }),
  "Other Charge item types must not be treated as operational pickup items.");
assert(pickupLinkHelpers.isOperationalDispatchItem({ itemId: 2055, sku: "MBBS-Special Order", itemType: "NonInvtPart" }),
  "MBBS-Special must remain operational even when NetSuite classifies it as non-inventory.");

const pickupAllocationStart = dispatchSource.indexOf("function positiveBalance");
const pickupAllocationEnd = dispatchSource.indexOf("function orderRequiresPickupLocation", pickupAllocationStart);
assert(pickupAllocationStart >= 0 && pickupAllocationEnd > pickupAllocationStart,
  "Dispatch pickup-allocation helpers must be present.");
const pickupAllocationHelpers = Function(
  "ownYardForLocation",
  '"use strict"; '
    + dispatchSource.slice(pickupAllocationStart, pickupAllocationEnd)
    + "; return { directPickupItemsForLocation, poPickupItemsForLocation, isOwnYardCode, itemForPickupLocation, normalizedPickupLocation, sameDispatchLocation, uniqueDispatchLocationLabels };"
)((value) => ["3445", "2967", "12441", "150"].includes(String(value || "")) ? { code: String(value) } : null);
const tooltipItemsStart = dispatchSource.indexOf("function tooltipItemsForOrder");
const tooltipItemsEnd = dispatchSource.indexOf("function tooltipItemRowsForOrder", tooltipItemsStart);
const itemHasQuantityForHarness = (item) => Number(item?.pallets || 0) || Number(item?.layers || 0)
  || Number(item?.sections || 0) || Number(item?.pieces || 0) || Number(item?.quantity || item?.salesQty || 0);
const tooltipItemsForOrder = Function(
  "dropItemsForStop",
  "itemHasQuantity",
  "directPickupItemsForLocation",
  "poPickupItemsForLocation",
  "isOwnYardCode",
  "itemForPickupLocation",
  "isOperationalDispatchItem",
  "sameDispatchLocation",
  '"use strict"; ' + dispatchSource.slice(tooltipItemsStart, tooltipItemsEnd) + "; return tooltipItemsForOrder;"
)(
  (order) => order.items || [],
  itemHasQuantityForHarness,
  pickupAllocationHelpers.directPickupItemsForLocation,
  pickupAllocationHelpers.poPickupItemsForLocation,
  pickupAllocationHelpers.isOwnYardCode,
  pickupAllocationHelpers.itemForPickupLocation,
  pickupLinkHelpers.isOperationalDispatchItem,
  pickupAllocationHelpers.sameDispatchLocation
);
const requiredPickupStart = dispatchSource.indexOf("function requiredPickupLocations");
const requiredPickupEnd = dispatchSource.indexOf("function sequenceWarningsForStops", requiredPickupStart);
const requiredPickupLocations = Function(
  "normalizedPickupLocation",
  "tooltipItemsForOrder",
  "itemHasQuantity",
  "uniqueDispatchLocationLabels",
  '"use strict"; ' + dispatchSource.slice(requiredPickupStart, requiredPickupEnd) + "; return requiredPickupLocations;"
)(
  pickupAllocationHelpers.normalizedPickupLocation,
  tooltipItemsForOrder,
  itemHasQuantityForHarness,
  pickupAllocationHelpers.uniqueDispatchLocationLabels
);

const rollback = await beginRollbackContext();
try {
  const clearedAssignment = applyDispatchPlannedAssignment({
    id: groupRef,
    dispatchPlanned: true,
    dispatchPlanId: "stale-plan",
    dispatchPlanDate: planDate,
    dispatchTruckPlate: "STALE",
    dispatchLoadName: "Stale Load"
  });
  assert(!clearedAssignment.dispatchPlanned
      && !clearedAssignment.dispatchPlanId
      && !clearedAssignment.dispatchPlanDate
      && !clearedAssignment.dispatchTruckPlate
      && !clearedAssignment.dispatchLoadName,
    "Orders without a live plan assignment must not retain stale planned metadata.",
    { clearedAssignment });
  await rollback.run(async () => {
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, item_type, item_type_text, stock_unit, item_weight
       ) VALUES ($1, 'Link Target Item', 'InvtPart', 'Inventory Item', 'EA', 10)`,
      [itemId]
    );
    const firstLine = await insertSalesOrder(orderIds[0], orderRefs[0], 4, base + 101);
    const secondLine = await insertSalesOrder(orderIds[1], orderRefs[1], 6, base + 102);
    const splitParentLine = await insertSalesOrder(orderIds[2], orderRefs[2], 10, base + 103);

    const groupOrder = {
      id: groupRef,
      type: "SO",
      customer: "Grouped Link Harness",
      childOrders: orderRefs.slice(0, 2),
      childOrderDetails: [
        {
          id: orderRefs[0],
          type: "SO",
          items: [
            snapshotItem(firstLine, 4),
            { ...snapshotItem(firstLine, 4), lineRowId: firstLine.id + 999999, lineId: `stale-${firstLine.line_id}` }
          ]
        },
        { id: orderRefs[1], type: "SO", items: [snapshotItem(secondLine, 6)] }
      ],
      items: [snapshotItem(firstLine, 4), snapshotItem(secondLine, 6)]
    };
    const splitOrders = [
      { id: splitRefs[0], type: "SO", originalOrderId: orderRefs[2], items: [snapshotItem(splitParentLine, 3)] },
      { id: splitRefs[1], type: "SO", originalOrderId: orderRefs[2], items: [snapshotItem(splitParentLine, 7)] }
    ];
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ($1::date, 'draft', 'dispatch link target harness')
       RETURNING id`,
      [planDate]
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       VALUES ($1, $2::jsonb, '[]'::jsonb, '{}'::jsonb)`,
      [plan.rows[0].id, JSON.stringify([groupOrder, ...splitOrders])]
    );

    const transfer = {
      id: transferId,
      tranid: transferRef,
      trandate: planDate,
      status: "B",
      status_text: "Transfer Order : Pending Fulfillment",
      source_location_id: 1,
      source_location: "3445",
      destination_location_id: 15,
      destination_location: "12441"
    };
    const transferLine = {
      line_id: base + 201,
      item_id: itemId,
      item_name: "Link Target Item",
      sku: "LINK-TARGET-SKU",
      item_type: "InvtPart",
      item_type_text: "Inventory Item",
      quantity: 8,
      unit: "EA",
      netsuite_received_qty: 0,
      location_id: 1,
      location: "3445"
    };
    await upsertOutboundTransferOrders([transfer]);
    await upsertOutboundTransferOrderLines(transferId, [transferLine]);
    await upsertInboundTransferOrders([transfer]);
    await upsertInboundTransferOrderLines(transferId, [{ ...transferLine, location_id: 15, location: "12441" }]);

    const groupTarget = await resolveDispatchSalesTarget({ dispatchTargetRef: groupRef, planDate });
    assert(groupTarget.target.kind === "group" && groupTarget.lines.length === 2,
      "Grouped target must resolve both canonical child lines.", { groupTarget });
    assert(new Set(groupTarget.lines.map((line) => line.sourceOrderRef)).size === 2,
      "Duplicate grouped SKUs must retain separate source-order identities.", { lines: groupTarget.lines });

    const dependencyOptions = await getOrderDependencyOptions({
      dispatchTargetRef: groupRef,
      transferOrderRef: transferRef,
      planDate
    });
    assert(dependencyOptions.matchingLines.length === 2,
      "One TO must match several grouped target lines.", { dependencyOptions });
    assert(dependencyOptions.matchingLines.reduce((sum, line) => sum + line.suggestedQuantity, 0) === 8,
      "Suggested quantities must not exceed the aggregate TO quantity.", { matchingLines: dependencyOptions.matchingLines });
    assert(dependencyOptions.matchingLines.every((line) => line.suggestedQuantities.pieces === line.suggestedQuantity),
      "Link TO options must expose converted unit quantities.", { matchingLines: dependencyOptions.matchingLines });

    const missingTransferOptions = await getOrderDependencyOptions({
      dispatchTargetRef: groupRef,
      transferOrderRef: "LINK-TO-NOT-FOUND",
      planDate
    });
    assert(missingTransferOptions.matchingLines.length === 0 && /not found/i.test(missingTransferOptions.matchError),
      "Link TO must return a detailed no-match error.", { missingTransferOptions });

    const dependency = await createOrderDependency({
      dispatchTargetRef: groupRef,
      transferOrderRef: transferRef,
      planDate,
      targetSignature: dependencyOptions.targetSignature,
      mode: "direct_to_customer",
      allocations: dependencyOptions.matchingLines.map((line) => ({
        targetLineKey: line.targetLineKey,
        quantities: line.suggestedQuantities
      })),
      operatorId: "dispatch-link-harness"
    });
    assert(dependency.dispatchTargetRef === groupRef && dependency.dispatchTargetKind === "group",
      "Created dependency must retain the visible grouped target.", { dependency });
    assert(dependency.lines.length === 2 && dependency.lines.every((line) => line.targetLineKey),
      "Grouped dependency lines must persist stable target keys.", { dependency });
    assert((await listOrderDependencies({ salesOrderRef: groupRef })).length === 1,
      "Grouped dependency must be retrievable by its visible reference.");

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, receipt_status,
         dispatch_vendor_yard, dispatch_address, netsuite_active
       ) VALUES ($1, $2, $3::date, $4, 'Link Target Vendor', 'pendingReceipt',
         'Pending Receipt', 15, '12441', 'open', 'Link Target Yard',
         '200 Vendor Street, Toronto, ON', true)`,
      [poId, poRef, planDate, base + 12]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, item_type, item_type_text,
         quantity, unit, netsuite_received_qty, netsuite_active, location_id, location
       ) VALUES ($1, $2, $3, 'Link Target Item', 'LINK-TARGET-SKU', 'InvtPart',
         'Inventory Item', 10, 'EA', 0, true, 15, '12441')`,
      [poId, base + 301, itemId]
    );
    const poOptions = await getSalesOrderPoAllocationOptions(groupRef, { planDate });
    assert(poOptions.salesLines.length === 2 && poOptions.order.kind === "group",
      "Link PO must use the same grouped target resolver.", { poOptions });
    assert(poOptions.salesLines.every((line) => line.conversions.pieces === 1 && line.available.pieces > 0),
      "Link PO must expose the same converted unit controls as Link TO.", { poOptions });
    const poAllocations = await createSalesOrderPoAllocations({
      dispatchTargetRef: groupRef,
      poRef,
      planDate,
      targetSignature: poOptions.order.targetSignature,
      lines: poOptions.salesLines.map((line) => ({
        targetLineKey: line.targetLineKey,
        quantities: { pieces: line.available.pieces }
      })),
      createdBy: "dispatch-link-harness"
    });
    assert(poAllocations.length === 2 && poAllocations.every((allocation) => allocation.dispatchTargetRef === groupRef),
      "Grouped PO allocations must persist under the visible target.", { poAllocations });
    const specialOrderId = base + 4;
    const specialOrderRef = "LINK-SO-SPECIAL-" + suffix;
    const specialLine = await insertSalesOrder(specialOrderId, specialOrderRef, 5, base + 104);
    await query(
      "UPDATE sales_order_lines SET item_id = 2055, item_name = 'MBBS-Special', sku = 'MBBS-Special', "
        + "item_description = 'Custom coping - charcoal', item_type = 'NonInvtPart', item_type_text = 'Non-inventory Item', "
        + "unit = 'PC', pallet_qty = 2, layer_qty = 0, "
        + "section_qty = 0, piece_qty = 4, to_plt = NULL, to_lyr = NULL, to_sec = NULL, to_pcs = NULL, "
        + "pack_quantity_source = 'netsuite_manual' WHERE id = $1",
      [specialLine.id]
    );
    await query(
      "INSERT INTO sales_order_lines (sales_order_id, line_id, item_id, item_name, sku, item_type, item_type_text, "
        + "quantity, unit, netsuite_committed_qty, netsuite_backordered_qty, netsuite_active, location_id, location) "
        + "VALUES ($1, $2, 1987, 'Delivery Charge', 'Delivery Charge', 'OthCharge', 'Other Charge', "
        + "1, '', 0, 0, true, 15, '12441')",
      [specialOrderId, base + 109]
    );
    const specialPoLines = await query(
      "INSERT INTO purchase_order_lines (purchase_order_id, line_id, item_id, item_name, sku, item_type, "
        + "item_type_text, item_description, quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty, "
        + "pack_quantity_source, netsuite_received_qty, netsuite_active, location_id, location) VALUES "
        + "($1, $2, 2055, 'MBBS-Special', 'MBBS-Special', 'InvtPart', 'Inventory Item', "
        + "'Custom coping - charcoal', 5, 'PC', 2, 0, 0, 4, 'netsuite_manual', 0, true, 15, '12441'), "
        + "($1, $3, 2055, 'MBBS-Special', 'MBBS-Special', 'InvtPart', 'Inventory Item', "
        + "'Custom coping - manual override', 5, 'PC', 2, 0, 0, 4, 'netsuite_manual', 0, true, 15, '12441') "
        + ", ($1, $4, 2055, 'MBBS-Special', 'MBBS-Special', 'InvtPart', 'Inventory Item', "
        + "'Custom coping - charcoal', 5, 'SQFT', 2, 0, 0, 4, 'netsuite_manual', 0, true, 15, '12441') "
        + "RETURNING id, item_description, unit",
      [poId, base + 302, base + 303, base + 304]
    );
    const specialOptions = await getSalesOrderPoAllocationOptions(specialOrderRef, { planDate });
    assert(specialOptions.salesLines.length === 1
        && !specialOptions.salesLines.some((line) => /delivery charge/i.test(line.sku || line.itemName || "")),
      "Link PO options must exclude Delivery Charge and other non-operational lines.", { specialOptions });
    const specialSalesLine = specialOptions.salesLines[0];
    const harnessCandidates = specialSalesLine.poCandidates.filter((candidate) => candidate.poRef === poRef);
    const exactCandidate = harnessCandidates.find((candidate) => candidate.exactMatch);
    const mismatchCandidate = harnessCandidates.find((candidate) => !candidate.exactMatch);
    const uomMismatchLine = specialPoLines.rows.find((line) => line.unit === "SQFT");
    assert(specialSalesLine.isSpecial && specialSalesLine.salesQuantityOnly && !specialSalesLine.independentSalesQty,
      "MBBS-Special must expose sales quantity only.", { specialSalesLine });
    assert(Number(specialSalesLine.available.salesQty) === 5
        && ["pallets", "layers", "sections", "pieces"].every((field) => Number(specialSalesLine.available[field]) === 0),
      "MBBS-Special physical quantities must not be independently selectable in Link PO.", { specialSalesLine });
    assert(harnessCandidates.length === 2 && exactCandidate && mismatchCandidate,
      "MBBS-Special PO candidates must distinguish exact descriptions while retaining the same sales/purchase UOM.",
      { harnessCandidates, specialPoLines: specialPoLines.rows });
    assert(uomMismatchLine && !harnessCandidates.some((candidate) => Number(candidate.poLineId) === Number(uomMismatchLine.id)),
      "A different MBBS-Special purchase UOM must not be offered as a compatible candidate.",
      { harnessCandidates, uomMismatchLine });

    let missingLineRejected = false;
    try {
      await createSalesOrderPoAllocations({
        dispatchTargetRef: specialOrderRef,
        poRef,
        planDate,
        targetSignature: specialOptions.order.targetSignature,
        lines: [{ targetLineKey: specialSalesLine.targetLineKey, quantities: { salesQty: 5 } }],
        createdBy: "dispatch-link-harness"
      });
    } catch (error) {
      missingLineRejected = /exact PO line/i.test(error.message);
    }
    assert(missingLineRejected, "MBBS-Special linking must require an explicit PO line selection.");

    let physicalOnlyRejected = false;
    try {
      await createSalesOrderPoAllocations({
        dispatchTargetRef: specialOrderRef,
        poRef,
        planDate,
        targetSignature: specialOptions.order.targetSignature,
        lines: [{
          targetLineKey: specialSalesLine.targetLineKey,
          poLineId: exactCandidate.poLineId,
          quantities: { pallets: 1 }
        }],
        createdBy: "dispatch-link-harness"
      });
    } catch (error) {
      physicalOnlyRejected = /Sales Qty/i.test(error.message);
    }
    assert(physicalOnlyRejected, "MBBS-Special physical input without Sales Qty must be rejected.");

    let uomMismatchRejected = false;
    try {
      await createSalesOrderPoAllocations({
        dispatchTargetRef: specialOrderRef,
        poRef,
        planDate,
        targetSignature: specialOptions.order.targetSignature,
        lines: [{
          targetLineKey: specialSalesLine.targetLineKey,
          poLineId: uomMismatchLine.id,
          quantities: { salesQty: 5 }
        }],
        createdBy: "dispatch-link-harness"
      });
    } catch (error) {
      uomMismatchRejected = error.code === "DISPATCH_MBBS_SPECIAL_UOM_MISMATCH";
    }
    assert(uomMismatchRejected, "MBBS-Special linking must reject a different purchase UOM.");

    const specialAllocation = await createSalesOrderPoAllocations({
      dispatchTargetRef: specialOrderRef,
      poRef,
      planDate,
      targetSignature: specialOptions.order.targetSignature,
      lines: [{
        targetLineKey: specialSalesLine.targetLineKey,
        poLineId: mismatchCandidate.poLineId,
        quantities: { pallets: 2, pieces: 4, salesQty: 5 }
      }],
      createdBy: "dispatch-link-harness"
    });
    assert(specialAllocation.length === 1
        && Number(specialAllocation[0].poLineId) === Number(mismatchCandidate.poLineId)
        && Number(specialAllocation[0].salesQty) === 5
        && Number(specialAllocation[0].pallets) === 0
        && Number(specialAllocation[0].pieces) === 0,
      "A deliberate same-UOM description override must persist Sales Qty only, even from a stale client that submits physical fields.",
      { specialAllocation, mismatchCandidate });

    const [enrichedSpecial] = await enrichDispatchOrdersWithPoTargetAllocations([{
      id: specialOrderRef,
      type: "SO",
      sourceYard: "12441",
      pickupLocations: ["12441"],
      items: [{
        lineRowId: specialLine.id,
        itemId: 2055,
        sku: "MBBS-Special",
        itemName: "MBBS-Special",
        quantity: 5,
        salesQty: 5,
        unit: "PC",
        pallets: 2,
        layers: 0,
        sections: 0,
        pieces: 4
      }, {
        lineRowId: specialLine.id + 1,
        itemId: 1987,
        sku: "Delivery Charge",
        itemName: "Delivery Charge",
        itemType: "OthCharge",
        itemTypeText: "Other Charge",
        quantity: 1,
        salesQty: 1,
        unit: "",
        pallets: 0,
        layers: 0,
        sections: 0,
        pieces: 0
      }]
    }]);
    const enrichedSpecialLine = enrichedSpecial.items[0];
    const specialManifestLine = enrichedSpecial.poPickupManifest?.[0]?.items?.[0];
    assert(Number(enrichedSpecialLine.poAllocatedSalesQty) === 5
        && Number(enrichedSpecialLine.poAllocatedPallets) === 2
        && Number(enrichedSpecialLine.poAllocatedPieces) === 4,
      "Sales Qty coverage must move the same MBBS-Special line's operational physical quantities away from the source yard.",
      { enrichedSpecialLine });
    assert(Number(specialManifestLine?.quantity) === 5
        && Number(specialManifestLine?.pallets) === 0
        && Number(specialManifestLine?.pieces) === 0,
      "The vendor pickup manifest must display MBBS-Special Sales Qty/UOM instead of duplicate physical quantities.",
      { specialManifestLine });
    assert(JSON.stringify(requiredPickupLocations(enrichedSpecial)) === JSON.stringify(["Link Target Yard"]),
      "A fully PO-linked MBBS-Special line plus Delivery Charge must require only the vendor pickup, not 12441.",
      { pickupLocations: enrichedSpecial.pickupLocations, requiredPickupLocations: requiredPickupLocations(enrichedSpecial) });

    const normalOrderId = base + 5;
    const normalOrderRef = "LINK-SO-NORMAL-" + suffix;
    const normalFirstLine = await insertSalesOrder(normalOrderId, normalOrderRef, 4, base + 105);
    await query(
      "INSERT INTO sales_order_lines (sales_order_id, line_id, item_id, item_name, sku, item_type, item_type_text, "
        + "quantity, unit, netsuite_committed_qty, netsuite_backordered_qty, netsuite_active, location_id, location, to_pcs) "
        + "VALUES ($1, $2, $3, 'Link Target Item', 'LINK-TARGET-SKU', 'InvtPart', 'Inventory Item', "
        + "3, 'EA', 0, 3, true, 15, '12441', 1)",
      [normalOrderId, base + 106, itemId]
    );
    await query(
      "UPDATE dispatch_plan_snapshots SET orders = orders || $2::jsonb WHERE plan_id = $1",
      [plan.rows[0].id, JSON.stringify([{
        id: normalOrderRef,
        type: "SO",
        items: [snapshotItem(normalFirstLine, 4)]
      }])]
    );
    const normalTarget = await resolveDispatchSalesTarget({ dispatchTargetRef: normalOrderRef, planDate });
    assert(normalTarget.target.kind === "normal" && normalTarget.lines.length === 2,
      "Normal targets must use all active canonical lines instead of a stale dispatch snapshot.",
      { normalTarget });
    const firstSplit = await resolveDispatchSalesTarget({ dispatchTargetRef: splitRefs[0], planDate });
    const secondSplit = await resolveDispatchSalesTarget({ dispatchTargetRef: splitRefs[1], planDate });
    assert(firstSplit.target.kind === "split" && secondSplit.target.kind === "split",
      "Unmaterialized split targets must resolve as split orders.");
    assert(firstSplit.lines[0].quantity === 3 && secondSplit.lines[0].quantity === 7,
      "Split targets must retain their exact snapshot quantities.", { firstSplit, secondSplit });
    assert(firstSplit.lines[0].targetLineKey !== secondSplit.lines[0].targetLineKey,
      "Sibling split target keys must never share an allocation identity.");
  });
  console.log("Dispatch link target rollback harness passed.");
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await rollback.rollback();
  await closeDb();
}
