import { beginRollbackContext, closeDb, query } from "./db.js";
import { config } from "./config.js";
import {
  safeEstablishedDependencyUngroupingTargets,
  safeNormalDependencyGroupingRefs,
  safeNormalDependencyGroupingTargets
} from "./server.js";
import { matchNetSuiteLocation } from "./netsuite.js";
import { buildTransferDependencyRestPayload } from "./transfer-dependency-netsuite.js";
import {
  assertNoActiveOrderDependenciesByRefs,
  calculateTransferProposalPallets,
  completeDirectDependenciesForSalesOrderDrop,
  confirmTransferDependencyBatch,
  enrichDispatchOrdersWithDependencies,
  generateTransferDependencySuggestion,
  getTransferDependencyBatch,
  getDependencyInventoryMatrix,
  getDirectPickupDependencyExecutionBlock,
  getOrderDependencyOptions,
  getSalesOrderDependencyExecutionBlock,
  listOrderDependencies,
  listTransferDependencyCandidates,
  markDirectDependencyPickupCompleted,
  mergeTransferDependencyProposals,
  normalDispatchGroupTargets,
  prepareTransferDependencyPalletItem,
  removeTransferDependencyProposalLine,
  reopenTransferDependencyCandidate,
  sortTransferDependencyCandidatesByCompletedAt,
  reviewTransferDependencyCandidate,
  sortTransferDependencyCandidatesByCreatedAt,
  syncDirectDependencyOperatorProgress,
  syncOrderDependenciesForTransferOrder,
  syncOrderDependenciesFromDispatchPlan,
  transferProposalConversionSelection,
  updateTransferDependencyBatch,
  validateDispatchPlanDependencies
} from "./order-dependency-repository.js";
import {
  addTransferDependencyProposalLine,
  searchTransferDependencyProposalItems
} from "./transfer-dependency-manual-items.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "./order-sync-repository.js";
import { listReceivingOrders } from "./receiving-repository.js";
import { listDispatchOrders } from "./dispatch-repository.js";
import { listDeliveryOrders } from "./delivery-repository.js";

const suffix = Number(String(Date.now()).slice(-6));
const salesOrderId = 9871000000 + suffix;
const itemId = 9872000000 + suffix;
const palletItemId = itemId + 1;
const repeatedItemId = itemId + 2;
const manualItemId = itemId + 3;
const coveredItemId = itemId + 4;
const repeatedSalesOrderId = salesOrderId + 1;
const createdTransferIds = [9873000000 + suffix, 9874000000 + suffix];
const salesOrderRef = `TSTDEP-SO-HARNESS-${suffix}`;

function check(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function fakeHydrateTransferOrder(transferOrderId, proposal) {
  const tranid = `DEP-TO-${transferOrderId}`;
  const order = {
    id: transferOrderId,
    tranid,
    trandate: "2097-07-13",
    status: "B",
    status_text: "Transfer Order : Pending Fulfillment",
    source_location_id: proposal.fromLocationId,
    source_location: proposal.fromLocation,
    destination_location_id: proposal.toLocationId,
    destination_location: proposal.toLocation,
    memo: `Dependency fixture for ${salesOrderRef}`
  };
  const materialLines = proposal.lines.filter((line) => String(line.itemId) !== String(proposal.palletItemId));
  const lines = [...materialLines, {
    itemId: proposal.palletItemId,
    itemName: "PALLET",
    unit: "EACH",
    proposedQuantity: proposal.palletTransferQuantity,
    palletQty: 0,
    layerQty: 0,
    sectionQty: 0,
    pieceQty: proposal.palletTransferQuantity
  }].map((line, index) => ({
    line_id: Number(`${String(transferOrderId).slice(-5)}${index + 1}`),
    item_id: line.itemId,
    item_name: line.itemName,
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    quantity: line.proposedQuantity,
    unit: line.unit,
    pallet_qty: line.palletQty,
    layer_qty: line.layerQty,
    section_qty: line.sectionQty,
    piece_qty: line.pieceQty,
    to_plt: 1,
    to_lyr: 0,
    to_sec: 0,
    to_pcs: 1,
    netsuite_received_qty: 0,
    location_id: proposal.fromLocationId,
    location: proposal.fromLocation
  }));
  await upsertOutboundTransferOrders([order]);
  await upsertOutboundTransferOrderLines(transferOrderId, lines);
  await upsertInboundTransferOrders([order]);
  await upsertInboundTransferOrderLines(transferOrderId, lines.map((line) => ({
    ...line,
    location_id: proposal.toLocationId,
    location: proposal.toLocation
  })));
  return { id: transferOrderId, tranid, status: "B", statusText: "Transfer Order : Pending Fulfillment", pendingFulfillment: true };
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const createdSortFixture = sortTransferDependencyCandidatesByCreatedAt([
      { salesOrderRef: "SO-OLDER", dependencyBatchId: 10, transferCreatedAt: "2026-07-24T10:00:00.000Z" },
      { salesOrderRef: "SO-NEWEST", dependencyBatchId: 11, transferCreatedAt: "2026-07-24T12:00:00.000Z" },
      { salesOrderRef: "SO-MIDDLE", dependencyBatchId: 12, transferCreatedAt: "2026-07-24T11:00:00.000Z" }
    ]);
    check(
      createdSortFixture.map((order) => order.salesOrderRef).join(",") === "SO-NEWEST,SO-MIDDLE,SO-OLDER",
      "Created Auto Transfer candidates must sort by TO creation time, newest first.",
      { createdSortFixture }
    );
    const completedSortFixture = sortTransferDependencyCandidatesByCompletedAt([
      { salesOrderRef: "SO-OLDER", dependencyBatchId: 10, completedAt: "2026-07-24T10:00:00.000Z" },
      { salesOrderRef: "SO-NEWEST", dependencyBatchId: 11, completedAt: "2026-07-24T12:00:00.000Z" },
      { salesOrderRef: "SO-UNDATED", dependencyBatchId: 13, completedAt: null },
      { salesOrderRef: "SO-MIDDLE", dependencyBatchId: 12, completedAt: "2026-07-24T11:00:00.000Z" }
    ]);
    check(
      completedSortFixture.map((order) => order.salesOrderRef).join(",") === "SO-NEWEST,SO-MIDDLE,SO-OLDER,SO-UNDATED",
      "Completed Auto Transfer candidates must sort by completion time, newest first.",
      { completedSortFixture }
    );

    const normalStructure = {
      orders: [{ id: "SOM05091" }, { id: "SOM05092" }]
    };
    const groupedStructure = {
      orders: [{
        id: "GOM-5091-5092",
        childOrders: ["SOM05091", "SOM05092"],
        childOrderDetails: [{ id: "SOM05091" }, { id: "SOM05092" }]
      }]
    };
    const safeGroupingRefs = safeNormalDependencyGroupingRefs(normalStructure, groupedStructure);
    const safeGroupingTargets = safeNormalDependencyGroupingTargets(normalStructure, groupedStructure);
    check(safeGroupingRefs.includes("SOM05091") && safeGroupingRefs.includes("SOM05092"),
      "Only normal orders entering a new group should receive the safe dependency grouping exception.",
      { safeGroupingRefs });
    check(safeGroupingTargets.some((target) =>
      target.sourceOrderRef === "SOM05091" && target.groupRef === "GOM-5091-5092"),
    "Safe grouping metadata must preserve the exact canonical child-to-group relationship.",
    { safeGroupingTargets });
    check(safeNormalDependencyGroupingRefs(groupedStructure, normalStructure).length === 0,
      "Ungrouping must not receive the safe dependency grouping exception.");
    const safeUngroupingTargets = safeEstablishedDependencyUngroupingTargets(groupedStructure, normalStructure);
    check(
      safeUngroupingTargets.length === 2
      && safeUngroupingTargets.some((target) =>
        target.sourceOrderRef === "SOM05091" && target.groupRef === "GOM-5091-5092")
      && safeUngroupingTargets.some((target) =>
        target.sourceOrderRef === "SOM05092" && target.groupRef === "GOM-5091-5092"),
      "Safe ungrouping metadata must preserve every exact canonical child-to-established-group relationship.",
      { safeUngroupingTargets }
    );
    check(
      safeEstablishedDependencyUngroupingTargets(normalStructure, groupedStructure).length === 0,
      "Grouping must not receive the established dependency ungrouping exception."
    );
    check(safeNormalDependencyGroupingRefs(normalStructure, {
      orders: [{ id: "SOM05091-S1", originalOrderId: "SOM05091" }]
    }).length === 0, "Splitting must not receive the safe dependency grouping exception.");
    const groupedSplitStructure = {
      orders: [{
        id: "GOM-5091-SPLIT",
        childOrders: ["SOM05091-S1"],
        childOrderDetails: [{ id: "SOM05091-S1", originalOrderId: "SOM05091" }]
      }]
    };
    check(safeNormalDependencyGroupingRefs(normalStructure, groupedSplitStructure).length === 0,
      "Putting a split child into a group must not move the parent Sales Order dependency.");
    const ambiguousGroupTargets = normalDispatchGroupTargets({
      orders: [
        { id: "GOM-A", childOrders: ["SOM05091"], childOrderDetails: [{ id: "SOM05091" }] },
        { id: "GOM-B", childOrders: ["SOM05091"], childOrderDetails: [{ id: "SOM05091" }] }
      ]
    });
    check(!ambiguousGroupTargets.has("SOM05091"),
      "An order present in multiple groups must not receive an ambiguous dependency target.");

    const sandboxLocations = [
      { id: "1", name: "3445", fullname: "Mr Bin Building Supply LTD : 3445", isinactive: "F", subsidiary: "1" },
      { id: "13", name: "2967", fullname: "Brampton Stone : 2967", isinactive: "F", subsidiary: "6" },
      { id: "15", name: "12441", fullname: "Mr Bin Building Supply LTD : 12441", isinactive: "F", subsidiary: "1" },
      { id: "7", name: "150WBS", fullname: "Voyage Building Products Inc : 150WBS", isinactive: "F", subsidiary: "4" },
      { id: "28", name: "Unrelated sandbox location", fullname: "Unrelated sandbox location", isinactive: "F", subsidiary: "1" }
    ];
    check(matchNetSuiteLocation(sandboxLocations, { locationId: 28, code: "2967" }).id === "13",
      "NetSuite location matching must prefer the canonical yard code over an environment-specific numeric ID.");
    check(matchNetSuiteLocation(sandboxLocations, { locationId: 26, code: "150" }).id === "7",
      "The canonical 150 yard must match the sandbox 150WBS location alias.");
    const restPayload = buildTransferDependencyRestPayload({
      proposal: {
        id: 99,
        memo: "Dependency payload fixture",
        palletItemId: 9999,
        palletTransferQuantity: 2,
        lines: [{
          itemId: 1234,
          itemName: "Dependency Material",
          proposedQuantity: 65.31,
          palletQty: 1,
          layerQty: 2,
          sectionQty: 3,
          pieceQty: 4
        }]
      },
      batch: { id: 42, salesOrderRef: "SO-PAYLOAD-TEST" },
      locations: {
        source: { netsuiteLocationId: 1, subsidiaryId: 1 },
        destination: { netsuiteLocationId: 15, subsidiaryId: 1 },
        intercompany: false
      }
    });
    const materialPayloadLine = restPayload.item.items.find((line) => line.item.id === "1234");
    const palletPayloadLine = restPayload.item.items.find((line) => line.item.id === "9999");
    check(!Object.hasOwn(restPayload, "orderStatus"),
      "Auto Transfer creation must let NetSuite choose the initial order status.");
    check(restPayload.employee?.id === config.transferDependency.employeeId,
      "Auto Transfer must write the configured current-login employee.", { restPayload });
    check(restPayload.custbody3?.id === config.transferDependency.deliveryMethodId,
      "Auto Transfer must write the configured Delivery method.", { restPayload });
    check(materialPayloadLine?.custcol_plt === 1
      && materialPayloadLine?.custcol_lyr === 2
      && materialPayloadLine?.custcol_sec === 3
      && materialPayloadLine?.custcol_pcs === 4,
    "Auto Transfer must copy PLT/LYR/SEC/PCS quantities to each NetSuite TO material line.",
    { materialPayloadLine });
    check(palletPayloadLine?.custcol_pcs === 2,
      "The ancillary PALLET line must write its count to the NetSuite PCS column.",
      { palletPayloadLine });
    check(restPayload.memo.includes("MBBS dependency batch 42 proposal 99"),
      "Each NetSuite TO must carry a proposal-specific recovery marker.", { memo: restPayload.memo });
    const zeroPalletPayload = buildTransferDependencyRestPayload({
      proposal: {
        id: 100,
        memo: "Zero pallet dependency fixture",
        palletItemId: 9999,
        palletTransferQuantity: 0,
        lines: [{ itemId: 1234, itemName: "Bulk Bag", proposedQuantity: 2 }]
      },
      batch: { id: 42, salesOrderRef: "SO-ZERO-PALLET" },
      locations: {
        source: { netsuiteLocationId: 1, subsidiaryId: 1 },
        destination: { netsuiteLocationId: 15, subsidiaryId: 1 },
        intercompany: false
      }
    });
    check(zeroPalletPayload.item.items.length === 1
      && zeroPalletPayload.item.items[0].item.id === "1234"
      && zeroPalletPayload.item.items[0].quantity === 2,
    "A manual PALLET quantity of zero must create a material-only TO payload without a zero-quantity PALLET line.",
    { zeroPalletPayload });

    config.googleMapsApiKey = "";
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, item_type, item_type_text, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES ($1, 'Dependency Block', 'InvtPart', 'Inventory Item', 'EA', 1, 0, 0, 1, 50)`,
      [itemId]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, item_type, item_type_text, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES ($1, 'PALLET', 'InvtPart', 'Inventory Item', 'EACH', 0, 0, 0, 1, 0)`,
      [palletItemId]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, item_type, item_type_text,
         stock_unit, to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES ($1, 'MANUAL-EXTRA', 'Manual Extra Item', 'Autocomplete fixture',
                 'InvtPart', 'Inventory Item', 'EA', 5, 0, 0, 1, 20)`,
      [manualItemId]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, item_type, item_type_text, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES ($1, 'COVERED-ITEM', 'InvtPart', 'Inventory Item', 'EA', 1, 0, 0, 1, 10)`,
      [coveredItemId]
    );
    await query(
      `INSERT INTO inventory_balances (item_id, location_id, location, quantity_on_hand, quantity_available)
       VALUES ($1, 1, '3445', 6, 6), ($1, 28, '2967', 4, 4),
              ($1, 15, '12441', 0, 0), ($1, 26, '150', 0, 0)`,
      [itemId]
    );
    await query(
      `INSERT INTO inventory_balances (item_id, location_id, location, quantity_on_hand, quantity_available)
       VALUES ($1, 1, '3445', 100, 100), ($1, 28, '2967', 100, 100),
              ($1, 15, '12441', 100, 100), ($1, 26, '150', 100, 100)`,
      [palletItemId]
    );
    await query(
      `INSERT INTO inventory_balances (item_id, location_id, location, quantity_on_hand, quantity_available)
       VALUES ($1, 1, '3445', 20, 20), ($1, 28, '2967', 20, 20),
              ($1, 15, '12441', 0, 0), ($1, 26, '150', 20, 20)`,
      [manualItemId]
    );
    await query(
      `INSERT INTO inventory_balances (item_id, location_id, location, quantity_on_hand, quantity_available)
       VALUES ($1, 1, '3445', 5, 5), ($1, 28, '2967', 5, 5),
              ($1, 15, '12441', 20, 20), ($1, 26, '150', 5, 5)`,
      [coveredItemId]
    );
    check(calculateTransferProposalPallets([{ itemId: 1, itemName: "A", proposedQuantity: 1, toPlt: 1 }]).calculatedQuantity === 1,
      "One full PLT must require one PALLET.");
    check(calculateTransferProposalPallets([{ itemId: 1, itemName: "A", proposedQuantity: 1.1, toPlt: 1 }]).calculatedQuantity === 2,
      "A full PLT plus a loose remainder must require two PALLET items.");
    check(calculateTransferProposalPallets([
      { itemId: 1, itemName: "A", proposedQuantity: 0.1, toPlt: 1 },
      { itemId: 2, itemName: "B", proposedQuantity: 0.1, toPlt: 1 }
    ]).calculatedQuantity === 2, "Loose quantities from separate SKUs must each require a PALLET.");
    check(calculateTransferProposalPallets([{ itemId: 1, itemName: "A", proposedQuantity: 1, toPlt: 0 }]).complete === false,
      "An item without PLT conversion must require a manual PALLET quantity.");
    const roundedLayerSelection = transferProposalConversionSelection(69.721, { toLyr: 10 });
    check(roundedLayerSelection.quantities.layers === 7 && roundedLayerSelection.salesQty === 70,
      "Auto Transfer must round 6.9721 LYR to 7 and use 7 times the layer conversion as the transfer quantity.",
      { roundedLayerSelection });
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         fulfillment_status, operator_status, local_yard_order_status,
         dispatch_address, netsuite_active
       ) VALUES (
         $1, $2, DATE '2097-07-13', 'Dependency Harness', 'B', 'Pending Fulfillment',
         15, '12441', 'Delivery', 'open', 'open', 'Open',
         '100 Test Street, Toronto, ON', true
       )`,
      [salesOrderId, salesOrderRef]
    );
    const line = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         item_type_text, quantity, unit, pallet_qty, to_plt, to_pcs,
         netsuite_committed_qty, netsuite_backordered_qty, netsuite_active,
         location_id, location
       ) VALUES ($1, $3, $2, 'Dependency Block', 'DEP-BLOCK', 'InvtPart',
                 'Inventory Item', 10, 'EA', 10, 1, 1, 0, 10, true, 15, '12441')
       RETURNING id`,
      [salesOrderId, itemId, 9875000000 + suffix]
    );
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         item_type_text, quantity, unit, pallet_qty, to_plt, to_pcs,
         netsuite_committed_qty, netsuite_backordered_qty, netsuite_active,
         location_id, location
       ) VALUES ($1, $3, $2, 'Covered Item', 'COVERED-ITEM', 'InvtPart',
                 'Inventory Item', 5, 'EA', 5, 1, 1, 5, 0, true, 15, '12441')`,
      [salesOrderId, coveredItemId, 9875000001 + suffix]
    );

    const candidates = await listTransferDependencyCandidates({ salesOrderId });
    check(candidates.length === 1, "Backordered Sales Order should be a dependency candidate.", { candidates });
    check(candidates[0].uncoveredQuantity === 10, "Candidate should expose the exact NetSuite backordered quantity.", { candidate: candidates[0] });
    const inventoryMatrix = await getDependencyInventoryMatrix(salesOrderId);
    check(candidates[0].lines.length === 1
      && inventoryMatrix.orderLines.length === 2
      && inventoryMatrix.items.some((item) => Number(item.itemId) === coveredItemId)
      && inventoryMatrix.orderLines.some((orderLine) => Number(orderLine.itemId) === coveredItemId
        && orderLine.backorderedQuantity === 0
        && orderLine.unresolvedQuantity === 0),
    "Shortage & Inventory must expose fully committed material lines without adding them to shortage workflows.",
    { candidate: candidates[0], inventoryMatrix });

    const lifecycleBeforeReview = await query(
      `SELECT netsuite_active, fulfillment_status, operator_status, local_yard_order_status,
              dispatch_planned
         FROM sales_orders WHERE netsuite_id = $1`,
      [salesOrderId]
    );
    await reviewTransferDependencyCandidate({ salesOrderId, operatorId: "dependency-harness" });
    const openAfterReview = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "open" });
    const reviewedAfterReview = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "reviewed" });
    const completedAfterReview = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "completed" });
    const reviewedFromItemSearch = await listTransferDependencyCandidates({
      search: "DEP-BLOCK",
      salesOrderId,
      reviewStatus: "reviewed"
    });
    check(openAfterReview.length === 0 && reviewedAfterReview.length === 1 && completedAfterReview.length === 1,
      "Reviewed - No Transfer should move only the SCM candidate into the Completed queue.",
      { openAfterReview, reviewedAfterReview, completedAfterReview });
    check(reviewedFromItemSearch.length === 1,
      "Searching by one item must not change the complete-order shortage signature.",
      { reviewedFromItemSearch });
    const lifecycleAfterReview = await query(
      `SELECT netsuite_active, fulfillment_status, operator_status, local_yard_order_status,
              dispatch_planned
         FROM sales_orders WHERE netsuite_id = $1`,
      [salesOrderId]
    );
    check(JSON.stringify(lifecycleBeforeReview.rows[0]) === JSON.stringify(lifecycleAfterReview.rows[0]),
      "SCM review must not change Sales Order planning or operator lifecycle fields.",
      { before: lifecycleBeforeReview.rows[0], after: lifecycleAfterReview.rows[0] });
    await reopenTransferDependencyCandidate({ salesOrderId, operatorId: "dependency-harness" });
    check((await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "open" })).length === 1,
      "Undo Review should return the shortage to the Open queue.");

    await reviewTransferDependencyCandidate({ salesOrderId, operatorId: "dependency-harness" });
    await query("UPDATE sales_order_lines SET netsuite_backordered_qty = 9 WHERE id = $1", [line.rows[0].id]);
    const reopenedAfterChange = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "open" });
    check(reopenedAfterChange.length === 1 && reopenedAfterChange[0].reviewed === false,
      "A material shortage-signature change must automatically reopen a reviewed order.",
      { reopenedAfterChange });
    await query("UPDATE sales_order_lines SET netsuite_backordered_qty = 10 WHERE id = $1", [line.rows[0].id]);

    const savedNetSuiteConfig = { ...config.netsuite };
    await query("UPDATE sales_orders SET is_test_fixture = true, netsuite_active = false WHERE netsuite_id = $1", [salesOrderId]);
    await query("UPDATE sales_order_lines SET netsuite_active = false WHERE sales_order_id = $1", [salesOrderId]);
    config.netsuite.accountId = "TEST_SB1";
    config.netsuite.restBaseUrl = "https://example-sb1.suitetalk.api.netsuite.com";
    check((await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "all" })).length === 1,
      "Inactive test fixtures must remain visible in a sandbox Auto Transfer queue.");
    const fixtureDispatchOrders = await listDispatchOrders();
    const fixtureDeliveryOrders = await listDeliveryOrders({ locationId: 15, status: "active", orderType: "sales_order" });
    check(fixtureDispatchOrders.some((order) => order.id === salesOrderRef && order.testFixture === true),
      "Inactive test fixtures must be searchable in the sandbox dispatch order pool.");
    check(fixtureDeliveryOrders.some((order) => order.tranid === salesOrderRef && order.testFixture === true),
      "Inactive test fixtures must be available in sandbox Operator Delivery Prep.");
    config.netsuite.accountId = "TEST_PRODUCTION";
    config.netsuite.restBaseUrl = "https://example.suitetalk.api.netsuite.com";
    check((await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "all" })).length === 0,
      "Test fixtures must stay hidden when the active NetSuite account is production.");
    check(!(await listDispatchOrders()).some((order) => order.id === salesOrderRef),
      "Test fixtures must stay hidden from production Dispatch.");
    check(!(await listDeliveryOrders({ locationId: 15, status: "active", orderType: "sales_order" })).some((order) => order.tranid === salesOrderRef),
      "Test fixtures must stay hidden from production Operator Delivery Prep.");
    config.netsuite = savedNetSuiteConfig;
    await query("UPDATE sales_orders SET is_test_fixture = false, netsuite_active = true WHERE netsuite_id = $1", [salesOrderId]);
    await query("UPDATE sales_order_lines SET netsuite_active = true WHERE sales_order_id = $1", [salesOrderId]);

    let batch = await generateTransferDependencySuggestion({
      salesOrderId,
      mode: "direct_to_customer",
      operatorId: "dependency-harness"
    });
    check(batch.proposals.length === 2, "Suggestion should cover the shortage from two source yards.", { batch });
    check(batch.uncoveredShortageQuantity === 0, "Suggestion should fully cover the shortage.", { batch });
    check(batch.proposals.every((proposal) => proposal.lines.every((proposalLine) =>
      proposalLine.quantities?.pallets === proposalLine.proposedQuantity)),
    "Generated Auto Transfer proposals must default conversion-unit inputs to the suggested required quantity.",
    { proposals: batch.proposals });
    check(batch.proposals.every((proposal) => proposal.lines.every((proposalLine) =>
      Number(proposalLine.itemId) !== coveredItemId)),
    "Fully committed display-only order items must never be added to Transfer Order proposals.",
    { proposals: batch.proposals, coveredItemId });

    const mergeOriginals = [...batch.proposals];
    const mergeTarget = mergeOriginals[0];
    const mergeSource = mergeOriginals[1];
    const mergeProposalPayload = (proposal, overrides = {}) => ({
      id: proposal.id,
      mode: proposal.mode,
      fromLocationId: proposal.fromLocationId,
      toLocationId: proposal.toLocationId,
      memo: proposal.memo,
      palletTransferQuantity: proposal.palletQuantityOverridden
        ? proposal.palletTransferQuantity
        : undefined,
      lines: proposal.lines.map((proposalLine) => ({
        salesLineId: proposalLine.salesLineId,
        proposedQuantity: proposalLine.proposedQuantity,
        quantities: { ...proposalLine.quantities }
      })),
      ...overrides
    });
    const mergeProposalWithMixedUnits = (proposal, overrides = {}) => {
      const payload = mergeProposalPayload(proposal, overrides);
      return {
        ...payload,
        lines: payload.lines.map((proposalLine) => ({
          ...proposalLine,
          quantities: {
            ...proposalLine.quantities,
            pallets: Math.max(0, Number(proposalLine.quantities.pallets || 0) - 1),
            pieces: Number(proposalLine.quantities.pieces || 0) + 1
          }
        }))
      };
    };
    const mergeInput = {
      proposalIds: mergeOriginals.map((proposal) => proposal.id),
      targetProposalId: mergeTarget.id,
      proposals: [
        mergeProposalWithMixedUnits(mergeTarget),
        mergeProposalWithMixedUnits(mergeSource, { fromLocationId: mergeTarget.fromLocationId })
      ],
      allowIncompleteCoverage: batch.allowIncompleteCoverage
    };
    const preMergeQuantity = mergeOriginals
      .flatMap((proposal) => proposal.lines)
      .reduce((total, proposalLine) => total + Number(proposalLine.proposedQuantity || 0), 0);
    const expectedMergedUnits = mergeInput.proposals
      .flatMap((proposal) => proposal.lines)
      .reduce((totals, proposalLine) => {
        for (const unit of ["pallets", "layers", "sections", "pieces", "salesQty"]) {
          totals[unit] += Number(proposalLine.quantities?.[unit] || 0);
        }
        return totals;
      }, { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0 });
    const firstMergeResult = await mergeTransferDependencyProposals(
      batch.id,
      mergeInput,
      "dependency-harness"
    );
    const mergedDraft = firstMergeResult.batch;
    check(firstMergeResult.reused === false
      && firstMergeResult.sourceProposalIds.length === 2
      && mergedDraft.proposals.length === 1,
    "Merging matching proposed TOs must replace them with one visible draft proposal.",
    { mergedDraft, firstMergeResult });
    const mergedProposal = mergedDraft.proposals[0];
    check(String(firstMergeResult.mergedProposalId) === String(mergedProposal.id)
      && !mergeOriginals.some((proposal) => String(proposal.id) === String(mergedProposal.id))
      && mergedProposal.creationStatus === "draft",
    "A merge must create a fresh draft proposal rather than mutating either original proposal.",
    { mergeOriginals, mergedProposal, firstMergeResult });
    check(String(mergedProposal.fromLocationId) === String(mergeTarget.fromLocationId)
      && String(mergedProposal.toLocationId) === String(mergeTarget.toLocationId),
    "Atomic proposal edits must make the replacement use the selected common From and To yards.",
    { mergeTarget, mergeSource, mergedProposal });
    check(mergedProposal.lines.length === 1,
      "Two allocations for the same Sales Order line must collapse to one replacement proposal line.",
      { mergedProposal });
    const mergedLine = mergedProposal.lines[0];
    check(String(mergedLine.salesLineId) === String(mergeTarget.lines[0].salesLineId)
      && Number(mergedLine.proposedQuantity) === preMergeQuantity,
    "The merged line must retain its canonical Sales Order line link and sum both proposed quantities.",
    { mergedLine, preMergeQuantity });
    check(["pallets", "layers", "sections", "pieces", "salesQty"].every((unit) =>
      Number(mergedLine.quantities?.[unit] || 0) === expectedMergedUnits[unit]),
    "Merging a duplicate Sales Order line must add its exact PLT/LYR/SEC/PCS selections.",
    { mergedLine, expectedMergedUnits });
    const expectedMergedPallets = calculateTransferProposalPallets([mergedLine]);
    check(Number(mergedProposal.calculatedPalletQuantity) === expectedMergedPallets.calculatedQuantity
      && Number(mergedProposal.palletTransferQuantity) === expectedMergedPallets.recommendedQuantity
      && mergedProposal.palletQuantityOverridden === false,
    "The replacement must recalculate PALLET quantity from merged material instead of summing stale proposal headers.",
    { mergedProposal, expectedMergedPallets });
    check(Number(mergedDraft.uncoveredShortageQuantity) === Number(batch.uncoveredShortageQuantity),
      "Merging proposals with the same destination must not change shortage coverage.",
      { before: batch.uncoveredShortageQuantity, after: mergedDraft.uncoveredShortageQuantity });
    const mergeRows = await query(
      `SELECT id, creation_status
         FROM scm_transfer_dependency_proposals
        WHERE batch_id = $1
        ORDER BY id`,
      [batch.id]
    );
    const cancelledOriginalIds = mergeRows.rows
      .filter((proposal) => proposal.creation_status === "cancelled")
      .map((proposal) => String(proposal.id));
    check(mergeOriginals.every((proposal) => cancelledOriginalIds.includes(String(proposal.id)))
      && mergeRows.rows.filter((proposal) => proposal.creation_status === "draft").length === 1,
    "Both source proposals must remain as cancelled lineage while only the replacement stays active.",
    { mergeRows: mergeRows.rows, mergeOriginals });
    const lineageLines = await query(
      `SELECT proposal_id, sales_line_id
         FROM scm_transfer_dependency_proposal_lines
        WHERE proposal_id = ANY($1::bigint[])
        ORDER BY proposal_id`,
      [mergeOriginals.map((proposal) => Number(proposal.id))]
    );
    check(lineageLines.rows.length === mergeOriginals.length
      && lineageLines.rows.every((proposalLine) =>
        String(proposalLine.sales_line_id) === String(mergeTarget.lines[0].salesLineId)),
    "Cancelled originals must retain their source-line lineage after the replacement is created.",
    { lineageLines: lineageLines.rows, mergeOriginals });
    const activeMergedQuantity = await query(
      `SELECT COALESCE(SUM(pl.proposed_quantity), 0) AS proposed_quantity
         FROM scm_transfer_dependency_proposal_lines pl
         JOIN scm_transfer_dependency_proposals p ON p.id = pl.proposal_id
        WHERE p.batch_id = $1
          AND p.creation_status <> 'cancelled'`,
      [batch.id]
    );
    check(Number(activeMergedQuantity.rows[0]?.proposed_quantity) === preMergeQuantity,
      "Cancelled lineage must not double-count active proposal coverage.",
      { activeMergedQuantity: activeMergedQuantity.rows[0], preMergeQuantity });

    const replayMergeResult = await mergeTransferDependencyProposals(
      batch.id,
      mergeInput,
      "dependency-harness-replay"
    );
    const replayRows = await query(
      `SELECT id, creation_status
         FROM scm_transfer_dependency_proposals
        WHERE batch_id = $1
        ORDER BY id`,
      [batch.id]
    );
    check(replayMergeResult.reused === true
      && replayMergeResult.batch.proposals.length === 1
      && String(replayMergeResult.mergedProposalId) === String(mergedProposal.id)
      && String(replayMergeResult.batch.proposals[0].id) === String(mergedProposal.id)
      && replayRows.rows.length === mergeRows.rows.length,
    "Repeating an identical merge request must reuse the replacement without creating another proposal.",
    { replayMergeResult, replayRows: replayRows.rows, mergeRows: mergeRows.rows });

    batch = await generateTransferDependencySuggestion({
      salesOrderId,
      mode: "direct_to_customer",
      operatorId: "dependency-harness"
    });
    check(batch.proposals.length === 2,
      "Regenerating after a merge must restore the current two-source suggestion for later lifecycle tests.",
      { batch });

    const mismatchTarget = batch.proposals[0];
    const mismatchSource = batch.proposals[1];
    const mismatchInput = {
      proposalIds: [mismatchTarget.id, mismatchSource.id],
      targetProposalId: mismatchTarget.id,
      proposals: [mergeProposalPayload(mismatchTarget), mergeProposalPayload(mismatchSource)],
      allowIncompleteCoverage: batch.allowIncompleteCoverage
    };
    let routeMismatchBlocked = false;
    try {
      await mergeTransferDependencyProposals(batch.id, mismatchInput, "dependency-harness");
    } catch (error) {
      routeMismatchBlocked = error.status === 409 && /same.*from.*to/i.test(error.message);
    }
    const afterMismatch = await query(
      `SELECT id, creation_status, from_location_id, to_location_id
         FROM scm_transfer_dependency_proposals
        WHERE batch_id = $1
        ORDER BY id`,
      [batch.id]
    );
    check(routeMismatchBlocked
      && afterMismatch.rows.length === 2
      && afterMismatch.rows.every((proposal) => proposal.creation_status === "draft"),
    "A route-mismatched merge must fail atomically without cancelling or replacing either proposal.",
    { afterMismatch: afterMismatch.rows, mismatchInput });

    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'creating',
              from_location_id = $2, from_location = $3
        WHERE id = $1`,
      [mismatchSource.id, mismatchTarget.fromLocationId, mismatchTarget.fromLocation]
    );
    let nonDraftMergeBlocked = false;
    try {
      await mergeTransferDependencyProposals(batch.id, {
        ...mismatchInput,
        proposals: [
          mergeProposalPayload(mismatchTarget),
          mergeProposalPayload(mismatchSource, { fromLocationId: mismatchTarget.fromLocationId })
        ]
      }, "dependency-harness");
    } catch (error) {
      nonDraftMergeBlocked = error.status === 409 && /draft/i.test(error.message);
    }
    const afterNonDraft = await query(
      `SELECT id, creation_status
         FROM scm_transfer_dependency_proposals
        WHERE batch_id = $1
        ORDER BY id`,
      [batch.id]
    );
    check(nonDraftMergeBlocked
      && afterNonDraft.rows.length === 2
      && afterNonDraft.rows.some((proposal) => proposal.creation_status === "creating")
      && !afterNonDraft.rows.some((proposal) => proposal.creation_status === "cancelled"),
    "A non-draft proposal must make the entire merge fail without altering its sibling.",
    { afterNonDraft: afterNonDraft.rows });
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'draft',
              from_location_id = $2, from_location = $3
        WHERE id = $1`,
      [mismatchSource.id, mismatchSource.fromLocationId, mismatchSource.fromLocation]
    );

    batch = await generateTransferDependencySuggestion({
      salesOrderId,
      mode: "direct_to_customer",
      operatorId: "dependency-harness"
    });
    check(batch.proposals.length === 2,
      "Merge validation fixtures must leave the original proposal lifecycle test with two clean drafts.",
      { batch });
    const removableProposal = batch.proposals[0];
    const removableLine = removableProposal.lines[0];
    const removedDraft = await removeTransferDependencyProposalLine(
      batch.id,
      removableProposal.id,
      removableLine.id,
      "dependency-harness"
    );
    check(!removedDraft.proposals.some((proposal) => proposal.lines.some((line) => line.id === removableLine.id)),
      "Auto Transfer must allow a suggested order line to be removed instead of requiring a zero quantity.",
      { removableLine, removedDraft });
    check(removedDraft.uncoveredShortageQuantity >= removableLine.proposedQuantity,
      "Removing a suggested order line must restore its quantity to the uncovered total.",
      { removableLine, removedDraft });
    batch = await generateTransferDependencySuggestion({
      salesOrderId,
      mode: "direct_to_customer",
      operatorId: "dependency-harness"
    });
    const manualProposal = batch.proposals[0];
    const uncoveredBeforeManual = Number(batch.uncoveredShortageQuantity);
    const manualSearch = await searchTransferDependencyProposalItems(
      batch.id,
      manualProposal.id,
      { search: "Manual Extra", limit: 12 }
    );
    check(manualSearch.length === 1
      && Number(manualSearch[0].itemId) === manualItemId
      && Number(manualSearch[0].effectiveAvailable) === 20,
    "Manual proposal autocomplete must find a known NetSuite item with source-yard availability.",
    { manualSearch, manualProposal });
    await addTransferDependencyProposalLine(batch.id, manualProposal.id, {
      itemId: manualItemId,
      quantities: { pallets: 0, layers: 0, sections: 0, pieces: 2, salesQty: 0 }
    }, "dependency-harness");
    batch = await getTransferDependencyBatch(batch.id);
    let savedManualProposal = batch.proposals.find((proposal) => Number(proposal.id) === Number(manualProposal.id));
    let savedManualLine = savedManualProposal?.lines.find((proposalLine) => proposalLine.lineSource === "manual");
    check(savedManualLine
      && savedManualLine.salesLineId === null
      && Number(savedManualLine.itemId) === manualItemId
      && Number(savedManualLine.proposedQuantity) === 2
      && Number(batch.uncoveredShortageQuantity) === uncoveredBeforeManual,
    "A manually added item must remain ancillary and must not reduce Sales Order undercoverage.",
    { savedManualLine, before: uncoveredBeforeManual, after: batch.uncoveredShortageQuantity });
    batch = await updateTransferDependencyBatch(batch.id, {
      proposals: [{
        id: savedManualProposal.id,
        mode: savedManualProposal.mode,
        fromLocationId: savedManualProposal.fromLocationId,
        toLocationId: savedManualProposal.toLocationId,
        memo: savedManualProposal.memo,
        lines: [{
          proposalLineId: savedManualLine.id,
          salesLineId: null,
          quantities: { pallets: 0, layers: 0, sections: 0, pieces: 3, salesQty: 0 }
        }]
      }]
    }, "dependency-harness");
    savedManualProposal = batch.proposals.find((proposal) => Number(proposal.id) === Number(manualProposal.id));
    savedManualLine = savedManualProposal?.lines.find((proposalLine) => proposalLine.lineSource === "manual");
    check(Number(savedManualLine?.proposedQuantity) === 3
      && Number(batch.uncoveredShortageQuantity) === uncoveredBeforeManual,
    "Manual proposal quantities must save by proposal-line ID without changing shortage coverage.",
    { savedManualLine, batch });
    const manualPayload = buildTransferDependencyRestPayload({
      proposal: savedManualProposal,
      batch,
      locations: {
        source: { netsuiteLocationId: 1, subsidiaryId: 1 },
        destination: { netsuiteLocationId: 15, subsidiaryId: 1 },
        intercompany: false
      }
    });
    check(manualPayload.item.items.some((payloadLine) =>
      Number(payloadLine.item.id) === manualItemId && Number(payloadLine.quantity) === 3),
    "A manually added proposal item must be included in the NetSuite Transfer Order payload.",
    { manualPayload });
    batch = await removeTransferDependencyProposalLine(
      batch.id,
      savedManualProposal.id,
      savedManualLine.id,
      "dependency-harness"
    );
    check(!batch.proposals.some((proposal) => proposal.lines.some((proposalLine) => proposalLine.lineSource === "manual"))
      && Number(batch.uncoveredShortageQuantity) === uncoveredBeforeManual,
    "Removing a manual item must leave Sales Order undercoverage unchanged.",
    { batch, uncoveredBeforeManual });
    const editableProposal = batch.proposals[0];
    const editableLine = editableProposal.lines[0];
    const originalQuantity = editableLine.proposedQuantity;
    const convertedDraft = await updateTransferDependencyBatch(batch.id, {
      proposals: [{
        id: editableProposal.id,
        mode: editableProposal.mode,
        fromLocationId: editableProposal.fromLocationId,
        toLocationId: editableProposal.toLocationId,
        memo: editableProposal.memo,
        lines: [{
          salesLineId: editableLine.salesLineId,
          quantities: { pallets: 1, layers: 0, sections: 0, pieces: 2, salesQty: 0 }
        }]
      }]
    }, "dependency-harness");
    const convertedLine = convertedDraft.proposals.find((proposal) => proposal.id === editableProposal.id)?.lines[0];
    check(convertedLine?.proposedQuantity === 3 && convertedLine?.quantities?.pallets === 1 && convertedLine?.quantities?.pieces === 2,
      "Auto Transfer proposal unit inputs must persist their exact PLT/LYR/SEC/PCS selection and converted sales quantity.",
      { convertedLine });
    const surplusDraft = await updateTransferDependencyBatch(batch.id, {
      proposals: [{
        id: editableProposal.id,
        mode: "yard_replenishment",
        fromLocationId: editableProposal.fromLocationId,
        toLocationId: editableProposal.toLocationId,
        memo: editableProposal.memo,
        lines: [{
          salesLineId: editableLine.salesLineId,
          quantities: { pallets: 10, layers: 0, sections: 0, pieces: 0, salesQty: 0 }
        }]
      }]
    }, "dependency-harness");
    const surplusLine = surplusDraft.proposals.find((proposal) => proposal.id === editableProposal.id)?.lines[0];
    check(surplusLine?.proposedQuantity === 10 && surplusLine?.quantities?.pallets === 10,
      "Saving a proposal draft must preserve an SCM surplus override instead of restoring the generated shortage quantity.",
      { surplusLine });
    batch = await updateTransferDependencyBatch(batch.id, {
      proposals: [{
        id: editableProposal.id,
        mode: editableProposal.mode,
        fromLocationId: editableProposal.fromLocationId,
        toLocationId: editableProposal.toLocationId,
        memo: editableProposal.memo,
        lines: [{
          salesLineId: editableLine.salesLineId,
          quantities: { pallets: originalQuantity, layers: 0, sections: 0, pieces: 0, salesQty: 0 }
        }]
      }]
    }, "dependency-harness");
    const manualCreationProposal = batch.proposals.find((proposal) => Number(proposal.id) === Number(editableProposal.id));
    await addTransferDependencyProposalLine(batch.id, manualCreationProposal.id, {
      itemId: manualItemId,
      quantities: { pallets: 0, layers: 0, sections: 0, pieces: 2, salesQty: 0 }
    }, "dependency-harness");
    batch = await prepareTransferDependencyPalletItem(
      batch.id,
      { itemId: palletItemId, itemName: "PALLET" },
      "dependency-harness"
    );

    await query("UPDATE sales_orders SET is_test_fixture = true WHERE netsuite_id = $1", [salesOrderId]);
    const sandboxConfigForCreation = { ...config.netsuite };
    config.netsuite.accountId = "TEST_PRODUCTION";
    config.netsuite.restBaseUrl = "https://example.suitetalk.api.netsuite.com";
    let productionFixtureBlocked = false;
    try {
      await confirmTransferDependencyBatch(batch.id, {
        operatorId: "dependency-harness",
        createTransferOrder: async () => ({ id: createdTransferIds[0] }),
        hydrateTransferOrder: fakeHydrateTransferOrder
      });
    } catch (error) {
      productionFixtureBlocked = /only while the active NetSuite account is sandbox/i.test(error.message);
    }
    config.netsuite = sandboxConfigForCreation;
    await query("UPDATE sales_orders SET is_test_fixture = false WHERE netsuite_id = $1", [salesOrderId]);
    check(productionFixtureBlocked, "Backend TO creation must reject test fixtures in production.");

    const singleProposalResult = await confirmTransferDependencyBatch(batch.id, {
      operatorId: "dependency-harness",
      proposalId: batch.proposals[0].id,
      createTransferOrder: async () => ({ id: createdTransferIds[0] }),
      hydrateTransferOrder: fakeHydrateTransferOrder
    });
    check(singleProposalResult.results.filter((entry) => entry.status === "created").length === 1
      && singleProposalResult.batch.status === "partially_created"
      && singleProposalResult.batch.proposals.some((proposal) => proposal.creationStatus === "draft"),
    "Creating one proposed TO must leave sibling proposals editable for separate creation.", { singleProposalResult });
    const createdManualTransfer = await query(
      `SELECT dl.sales_line_id, dl.item_id, dl.allocated_quantity, dl.line_role
         FROM order_dependency_lines dl
         JOIN order_dependencies d ON d.id = dl.dependency_id
        WHERE d.sales_order_id = $1
          AND dl.line_role = 'manual_transfer'
        ORDER BY dl.id
        LIMIT 1`,
      [salesOrderId]
    );
    check(createdManualTransfer.rowCount === 1
      && createdManualTransfer.rows[0].sales_line_id === null
      && Number(createdManualTransfer.rows[0].item_id) === manualItemId
      && Number(createdManualTransfer.rows[0].allocated_quantity) === 2,
    "A created TO must track a manual proposal item as ancillary manual_transfer inventory, not as SO coverage.",
    { createdManualTransfer: createdManualTransfer.rows[0] });
    const firstResult = await confirmTransferDependencyBatch(batch.id, {
      operatorId: "dependency-harness",
      createTransferOrder: async () => { throw new Error("Intentional fake NetSuite failure"); },
      hydrateTransferOrder: fakeHydrateTransferOrder
    });
    check(firstResult.results.filter((entry) => entry.status === "failed").length === 1,
      "A later failed proposal must be retained without changing the already-created TO.", { firstResult });
    check(firstResult.batch.proposals.filter((proposal) => proposal.creationStatus === "created").length === 1,
      "Successful NetSuite TO must survive a later sibling proposal failure.", { firstResult });

    const createdAllocation = await query(
      `SELECT dl.id, dl.allocated_quantity
         FROM order_dependency_lines dl
         JOIN order_dependencies d ON d.id = dl.dependency_id
        WHERE d.sales_order_id = $1 AND dl.line_role = 'sales_allocation'
        ORDER BY dl.id LIMIT 1`,
      [salesOrderId]
    );
    await query("UPDATE order_dependency_lines SET allocated_quantity = 10 WHERE id = $1", [createdAllocation.rows[0].id]);
    await query("UPDATE scm_transfer_dependency_batches SET status = 'attention' WHERE id = $1", [batch.id]);
    const attentionProposal = firstResult.batch.proposals.find((proposal) => proposal.creationStatus === "failed");
    check(Boolean(attentionProposal), "Fixture must retain one failed proposal for the manual-review attention regression.");
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'attention', netsuite_transfer_order_id = $2,
              netsuite_transfer_order_ref = $3, updated_at = now()
        WHERE id = $1`,
      [attentionProposal.id, createdTransferIds[1], `DEP-TO-${createdTransferIds[1]}`]
    );
    const createdAfterTransferCreation = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "created" });
    check(createdAfterTransferCreation.length === 1
      && createdAfterTransferCreation[0].completionType === "transfer_created"
      && Boolean(createdAfterTransferCreation[0].transferCreatedAt),
    "A created NetSuite TO must remain in Created until approval and source-yard printing are complete.",
    { createdAfterTransferCreation });
    const proposalStatesBeforeManualReview = await query(
      `SELECT id, creation_status, netsuite_transfer_order_id
         FROM scm_transfer_dependency_proposals
        WHERE id = ANY($1::bigint[])
        ORDER BY id`,
      [firstResult.batch.proposals.map((proposal) => proposal.id)]
    );
    const dependenciesBeforeManualReview = await query(
      "SELECT COUNT(*)::int AS count FROM order_dependencies WHERE sales_order_id = $1",
      [salesOrderId]
    );
    const manualReview = await reviewTransferDependencyCandidate({ salesOrderId, operatorId: "dependency-harness" });
    const completedAfterManualReview = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "completed" });
    const proposalStatesAfterManualReview = await query(
      `SELECT id, creation_status, netsuite_transfer_order_id
         FROM scm_transfer_dependency_proposals
        WHERE id = ANY($1::bigint[])
        ORDER BY id`,
      [firstResult.batch.proposals.map((proposal) => proposal.id)]
    );
    const dependenciesAfterManualReview = await query(
      "SELECT COUNT(*)::int AS count FROM order_dependencies WHERE sales_order_id = $1",
      [salesOrderId]
    );
    const manualReviewAudit = await query(
      `SELECT action
         FROM dispatch_audit_log
        WHERE entity_type = 'sales_order'
          AND entity_id = $1
          AND action = 'scm.transfer_dependency.transfer_manually_reviewed'
        ORDER BY id DESC
        LIMIT 1`,
      [String(salesOrderId)]
    );
    check(manualReview.workflowStage === "completed"
      && manualReview.completionType === "transfer_manually_reviewed"
      && completedAfterManualReview.length === 1
      && completedAfterManualReview[0].completionType === "transfer_manually_reviewed",
    "A Created candidate must support explicit manual review into Completed.", { manualReview, completedAfterManualReview });
    check(JSON.stringify(proposalStatesAfterManualReview.rows) === JSON.stringify(proposalStatesBeforeManualReview.rows)
      && dependenciesAfterManualReview.rows[0].count === dependenciesBeforeManualReview.rows[0].count,
    "Manual completion must not cancel or mutate created/attention proposals or their dependency.", {
      before: proposalStatesBeforeManualReview.rows,
      after: proposalStatesAfterManualReview.rows,
      dependenciesBeforeManualReview: dependenciesBeforeManualReview.rows[0],
      dependenciesAfterManualReview: dependenciesAfterManualReview.rows[0]
    });
    check(manualReviewAudit.rowCount === 1,
      "Manual completion of a Created candidate must write its distinct audit action.", { manualReviewAudit: manualReviewAudit.rows });
    const reopenedCreatedReview = await reopenTransferDependencyCandidate({ salesOrderId, operatorId: "dependency-harness" });
    const createdAfterManualReopen = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "created" });
    check(reopenedCreatedReview.workflowStage === "created"
      && reopenedCreatedReview.completionType === "transfer_created"
      && createdAfterManualReopen.length === 1,
    "Undo Review for a manually completed transfer must return the candidate to Created.", {
      reopenedCreatedReview,
      createdAfterManualReopen
    });
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'failed', netsuite_transfer_order_id = NULL,
              netsuite_transfer_order_ref = NULL, updated_at = now()
        WHERE id = $1`,
      [attentionProposal.id]
    );
    const printedJob = await query(
      `INSERT INTO scm_print_jobs (
         job_key, location_id, document_type, document_name, document_path,
         document_sha256, status, queued_at, started_at, printed_at
       ) VALUES ($1, $2, 'transfer_dependency_picking_ticket', $3, $4, $5, 'printed', now(), now(), now())
       RETURNING id`,
      [`dependency-harness:${suffix}`, singleProposalResult.batch.proposals[0].fromLocationId,
        `DEP-TO-${createdTransferIds[0]}.pdf`, `/tmp/dependency-harness-${suffix}.pdf`, String(suffix).padStart(64, "0").slice(0, 64)]
    );
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET quantity_verification_status = 'verified', approval_status = 'approved',
              print_job_id = $2, approved_at = now()
        WHERE id = $1`,
      [singleProposalResult.batch.proposals[0].id, printedJob.rows[0].id]
    );
    const completedAfterPrint = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "completed" });
    check(completedAfterPrint.length === 1
      && completedAfterPrint[0].completionType === "transfer_approved_printed",
    "A fully allocated TO must move to Completed only after approval and a confirmed printed job.",
    { completedAfterPrint });
    await query("UPDATE order_dependency_lines SET allocated_quantity = $2 WHERE id = $1",
      [createdAllocation.rows[0].id, createdAllocation.rows[0].allocated_quantity]);
    await query("UPDATE scm_transfer_dependency_batches SET status = $2 WHERE id = $1", [batch.id, firstResult.batch.status]);

    const dependency = (await listOrderDependencies({ salesOrderRef }))[0];
    check(dependency?.mode === "direct_to_customer", "Created proposal should produce a direct dependency.", { dependency });
    check(dependency.lines.length === 3,
      "Dependency should preserve Sales Order allocation, a manual transfer item, and ancillary PALLET quantity.",
      { dependency });
    check(dependency.lines.some((line) => line.lineRole === "manual_transfer"
      && Number(line.itemId) === manualItemId
      && line.salesLineId === null),
    "Manual TO material must remain visible in dependency execution without being linked to an SO line.",
    { dependency });
    check(dependency.lines.some((line) => line.lineRole === "pallet" && line.itemName === "PALLET"),
      "Generated PALLET quantity must be represented as an ancillary dependency line.", { dependency });

    const enriched = await enrichDispatchOrdersWithDependencies([
      { id: salesOrderRef, type: "SO", sourceYard: "12441", pickupLocations: ["12441"], items: [] },
      { id: dependency.transferOrderRef, type: "TO", items: [] }
    ]);
    const enrichedSales = enriched.find((order) => order.id === salesOrderRef);
    const enrichedTransfer = enriched.find((order) => order.id === dependency.transferOrderRef);
    check(enrichedSales.directPickupManifest.length === 1, "SO should receive a source-yard direct pickup manifest.", { enrichedSales });
    check(enrichedTransfer.dependencyHidden === true, "Direct linked TO should be hidden from independent planning.", { enrichedTransfer });
    check(enrichedTransfer.dependencyLabels?.[0] === `Link with ${salesOrderRef}`,
      "Direct linked TO should use one clear link label.", { enrichedTransfer });

    const groupRef = `GOA-DEP-${suffix}`;
    const groupedEnriched = await enrichDispatchOrdersWithDependencies([{
      id: groupRef,
      type: "SO",
      childOrders: [salesOrderRef],
      childOrderDetails: [{ id: salesOrderRef, type: "SO" }],
      sourceYard: "12441",
      pickupLocations: ["12441"],
      items: []
    }]);
    check(groupedEnriched[0].directPickupManifest?.[0]?.salesOrderRef === salesOrderRef,
      "Grouped SO should inherit its canonical child's dependency manifest.", { groupedEnriched });

    await query("UPDATE order_dependencies SET dependency_mode = 'yard_replenishment' WHERE id = $1", [dependency.id]);
    const replenishmentDeliveryOrders = await listDeliveryOrders({
      locationId: 15,
      status: "active",
      orderType: "sales_order"
    });
    check(replenishmentDeliveryOrders.some((order) => order.tranid === salesOrderRef),
      "A backordered Sales Order with an active yard-replenishment dependency must remain in Operator Delivery Prep.",
      { salesOrderRef, dependencyId: dependency.id });
    const replenishmentBlock = await getSalesOrderDependencyExecutionBlock([salesOrderRef]);
    check(replenishmentBlock?.transferOrderRef === dependency.transferOrderRef,
      "Unreceived replenishment dependency must block SO driver execution.", { replenishmentBlock });
    const dependencyPlanOrders = [
      { id: salesOrderRef, pickupLocations: ["12441"] },
      { id: dependency.transferOrderRef, pickupLocations: [dependency.sourceLocation] }
    ];
    const salesOnlyConflicts = await validateDispatchPlanDependencies({
      id: 0,
      planDate: "2097-07-13",
      orders: dependencyPlanOrders,
      trucks: [{
        plate: "DEP-TRUCK",
        loads: [{
          id: "DEP-L1",
          name: "Load 1",
          timing: { start: 420, finish: 600 },
          stops: [
            { id: "so-pick", type: "pick", orderId: salesOrderRef, location: "12441", timing: { arrival: 440, depart: 460 } },
            { id: "so-drop", type: "drop", orderId: salesOrderRef, location: "Customer", timing: { arrival: 500, depart: 520 } }
          ]
        }]
      }]
    });
    check(salesOnlyConflicts.some((message) => message.includes(dependency.transferOrderRef)),
      "Replenishment SO must not be plannable without its prerequisite TO.", { salesOnlyConflicts });
    const reversedConflicts = await validateDispatchPlanDependencies({
      id: 0,
      planDate: "2097-07-13",
      orders: dependencyPlanOrders,
      trucks: [{
        plate: "DEP-TRUCK",
        loads: [{
          id: "DEP-L1",
          name: "Load 1",
          timing: { start: 420, finish: 650 },
          stops: [
            { id: "so-pick", type: "pick", orderId: salesOrderRef, location: "12441", timing: { arrival: 440, depart: 460 } },
            { id: "so-drop", type: "drop", orderId: salesOrderRef, location: "Customer", timing: { arrival: 500, depart: 520 } },
            { id: "to-pick", type: "pick", orderId: dependency.transferOrderRef, location: dependency.sourceLocation, timing: { arrival: 540, depart: 560 } },
            { id: "to-drop", type: "drop", orderId: dependency.transferOrderRef, location: "12441", timing: { arrival: 600, depart: 620 } }
          ]
        }]
      }]
    });
    check(reversedConflicts.some((message) => message.includes(dependency.transferOrderRef)),
      "Replenishment SO must not be planned before its TO in the same load.", { reversedConflicts });
    const liveInsertionConflicts = await validateDispatchPlanDependencies({
      id: 0,
      planDate: "2097-07-13",
      orders: dependencyPlanOrders,
      trucks: [{
        plate: "DEP-TRUCK",
        loads: [{
          id: "DEP-L1",
          name: "Load 1",
          timing: { start: 420, finish: 650 },
          stops: [
            { id: "so-pick-live", type: "pick", orderId: salesOrderRef, location: "12441", timing: { arrival: 420, depart: 440 } },
            { id: "to-pick-live", type: "pick", orderId: dependency.transferOrderRef, location: dependency.sourceLocation, timing: { arrival: 450, depart: 470 } },
            { id: "to-drop-live", type: "drop", orderId: dependency.transferOrderRef, location: "12441", timing: { arrival: 500, depart: 510 } },
            { id: "so-drop-live", type: "drop", orderId: salesOrderRef, location: "Customer", timing: { arrival: 550, depart: 570 } }
          ]
        }]
      }]
    });
    check(liveInsertionConflicts.some((message) => message.includes(dependency.transferOrderRef)),
      "A TO inserted before the SO drop but after the SO pickup must remain invalid.",
      { liveInsertionConflicts });
    const orderedConflicts = await validateDispatchPlanDependencies({
      id: 0,
      planDate: "2097-07-13",
      orders: dependencyPlanOrders,
      trucks: [{
        plate: "DEP-TRUCK",
        loads: [{
          id: "DEP-L1",
          name: "Load 1",
          timing: { start: 420, finish: 650 },
          stops: [
            { id: "to-pick", type: "pick", orderId: dependency.transferOrderRef, location: dependency.sourceLocation, timing: { arrival: 420, depart: 440 } },
            { id: "to-drop", type: "drop", orderId: dependency.transferOrderRef, location: "12441", timing: { arrival: 470, depart: 480 } },
            { id: "so-pick", type: "pick", orderId: salesOrderRef, location: "12441", timing: { arrival: 490, depart: 510 } },
            { id: "so-drop", type: "drop", orderId: salesOrderRef, location: "Customer", timing: { arrival: 550, depart: 570 } }
          ]
        }]
      }]
    });
    check(orderedConflicts.length === 0,
      "Replenishment TO before SO pickup in the same load should be valid.", { orderedConflicts });

    const groupedDependencyRef = `${groupRef}-NONFIRST`;
    const groupedDependencyPlanOrders = [
      {
        id: groupedDependencyRef,
        type: "SO",
        pickupLocations: ["12441"],
        childOrders: [`${salesOrderRef}-UNRELATED`, salesOrderRef],
        childOrderDetails: [
          { id: `${salesOrderRef}-UNRELATED`, type: "SO" },
          { id: salesOrderRef, type: "SO" }
        ]
      },
      { id: dependency.transferOrderRef, pickupLocations: [dependency.sourceLocation] }
    ];
    const groupedMissingTransferConflicts = await validateDispatchPlanDependencies({
      id: 0,
      planDate: "2097-07-13",
      orders: groupedDependencyPlanOrders,
      trucks: [{
        plate: "DEP-GROUP-TRUCK",
        loads: [{
          id: "DEP-GROUP-L1",
          name: "Grouped Load 1",
          stops: [
            { id: "group-pick", type: "pick", orderId: groupedDependencyRef, location: "12441" },
            { id: "group-drop", type: "drop", orderId: groupedDependencyRef, location: "Customer" }
          ]
        }]
      }]
    });
    check(groupedMissingTransferConflicts.some((message) => message.includes(dependency.transferOrderRef)),
      "A dependency on a non-first grouped SO child must block planning when its TO is missing.",
      { groupedMissingTransferConflicts });
    const groupedOrderedConflicts = await validateDispatchPlanDependencies({
      id: 0,
      planDate: "2097-07-13",
      orders: groupedDependencyPlanOrders,
      trucks: [{
        plate: "DEP-GROUP-TRUCK",
        loads: [{
          id: "DEP-GROUP-L1",
          name: "Grouped Load 1",
          stops: [
            { id: "group-to-pick", type: "pick", orderId: dependency.transferOrderRef, location: dependency.sourceLocation },
            { id: "group-to-drop", type: "drop", orderId: dependency.transferOrderRef, location: "12441" },
            { id: "group-pick", type: "pick", orderId: groupedDependencyRef, location: "12441" },
            { id: "group-drop", type: "drop", orderId: groupedDependencyRef, location: "Customer" }
          ]
        }]
      }]
    });
    check(groupedOrderedConflicts.length === 0,
      "A grouped SO should be valid when its TO completes before the group pickup in the same load.",
      { groupedOrderedConflicts });

    const sharedTruckPlan = {
      id: 0,
      planDate: "2097-07-13",
      orders: dependencyPlanOrders,
      trucks: [{
        id: "PARENT-A",
        plate: "PARENT-A",
        loads: [{
          id: "DEP-TO-LOAD",
          name: "Transfer first",
          truckPlate: "SHARED-V2",
          driverLogin: "driver-a",
          driverSequence: 0,
          stops: [
            { id: "to-pick-v2", type: "pick", orderId: dependency.transferOrderRef, location: dependency.sourceLocation },
            { id: "to-drop-v2", type: "drop", orderId: dependency.transferOrderRef, location: "12441" }
          ]
        }]
      }, {
        id: "PARENT-B",
        plate: "PARENT-B",
        loads: [{
          id: "DEP-SO-LOAD",
          name: "Sales second",
          truckPlate: "SHARED-V2",
          driverLogin: "driver-b",
          driverSequence: 0,
          stops: [
            { id: "so-pick-v2", type: "pick", orderId: salesOrderRef, location: "12441" },
            { id: "so-drop-v2", type: "drop", orderId: salesOrderRef, location: "Customer" }
          ]
        }]
      }]
    };
    const sharedTruckConflicts = await validateDispatchPlanDependencies(sharedTruckPlan);
    check(sharedTruckConflicts.length === 0,
      "Per-load driver sequences must not replace the physical truck load order for replenishment dependencies.", { sharedTruckConflicts });
    const reversedSharedTruckPlan = structuredClone(sharedTruckPlan);
    reversedSharedTruckPlan.trucks.reverse();
    const reversedSharedTruckConflicts = await validateDispatchPlanDependencies(reversedSharedTruckPlan);
    check(reversedSharedTruckConflicts.some((message) => message.includes(dependency.transferOrderRef)),
      "A Sales load before its replenishment load on the same per-load truck must remain blocked.", { reversedSharedTruckConflicts });

    const reversedTimeSharedTruckPlan = structuredClone(sharedTruckPlan);
    reversedTimeSharedTruckPlan.trucks[0].loads[0].plannedStartMinute = 420;
    reversedTimeSharedTruckPlan.trucks[0].loads[0].plannedFinishMinute = 600;
    reversedTimeSharedTruckPlan.trucks[1].loads[0].plannedStartMinute = 490;
    reversedTimeSharedTruckPlan.trucks[1].loads[0].plannedFinishMinute = 650;
    reversedTimeSharedTruckPlan.trucks[1].loads[0].stops[0].timing = { arrival: 500, depart: 515 };
    const reversedTimeSharedTruckConflicts = await validateDispatchPlanDependencies(reversedTimeSharedTruckPlan);
    check(reversedTimeSharedTruckConflicts.some((message) => message.includes(dependency.transferOrderRef)),
      "Comparable V2 timing must block a cross-driver transfer that finishes after the Sales pickup on the same truck.",
      { reversedTimeSharedTruckConflicts });

    const orderedTimeSharedTruckPlan = structuredClone(reversedTimeSharedTruckPlan);
    orderedTimeSharedTruckPlan.trucks[0].loads[0].plannedFinishMinute = 480;
    const orderedTimeSharedTruckConflicts = await validateDispatchPlanDependencies(orderedTimeSharedTruckPlan);
    check(orderedTimeSharedTruckConflicts.length === 0,
      "Comparable V2 timing should allow a cross-driver transfer that finishes before the Sales pickup on the same truck.",
      { orderedTimeSharedTruckConflicts });

    await query(
      `UPDATE order_dependencies
          SET status = 'attention', attention_reason = 'Grouping attention fixture'
        WHERE id = $1`,
      [dependency.id]
    );
    let safeNormalGroupingBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef],
        "group these orders",
        { allowNormalGroupingRefs: [salesOrderRef] }
      );
    } catch {
      safeNormalGroupingBlocked = true;
    }
    check(!safeNormalGroupingBlocked,
      "An unstarted normal yard-replenishment dependency in attention should allow its Sales Order to enter a group.");

    await query(
      `UPDATE order_dependency_lines
          SET loaded_quantity = 1
        WHERE id = (
          SELECT id FROM order_dependency_lines WHERE dependency_id = $1 ORDER BY id LIMIT 1
        )`,
      [dependency.id]
    );
    let progressedGroupingBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef],
        "group these orders",
        { allowNormalGroupingRefs: [salesOrderRef] }
      );
    } catch (error) {
      progressedGroupingBlocked = error.code === "ORDER_DEPENDENCY_STRUCTURE_LOCK";
    }
    check(progressedGroupingBlocked,
      "Dependency grouping must remain blocked after execution progress starts.");
    await query("UPDATE order_dependency_lines SET loaded_quantity = 0 WHERE dependency_id = $1", [dependency.id]);
    await query(
      `UPDATE order_dependencies
          SET status = 'active', attention_reason = null
        WHERE id = $1`,
      [dependency.id]
    );

    const groupedPlanFixture = {
      planDate: "2097-07-13",
      orders: [{
        id: groupRef,
        type: "SO",
        childOrders: [salesOrderRef],
        childOrderDetails: [{ id: salesOrderRef, type: "SO" }]
      }],
      trucks: []
    };
    const firstGroupSync = await syncOrderDependenciesFromDispatchPlan(groupedPlanFixture);
    check(firstGroupSync.remapped.some((entry) =>
      String(entry.dependencyId) === String(dependency.id)
      && entry.sourceOrderRef === salesOrderRef
      && entry.groupRef === groupRef
    ), "Grouping a normal SO must move its unstarted yard dependency to the group.", { firstGroupSync });
    const movedHeader = await query(
      `SELECT sales_order_id, sales_order_ref, dispatch_target_ref, dispatch_target_kind,
              transfer_order_id, transfer_order_ref, dependency_mode, status
         FROM order_dependencies
        WHERE id = $1`,
      [dependency.id]
    );
    check(
      Number(movedHeader.rows[0].sales_order_id) === Number(dependency.salesOrderId)
      && movedHeader.rows[0].sales_order_ref === salesOrderRef
      && movedHeader.rows[0].dispatch_target_ref === groupRef
      && movedHeader.rows[0].dispatch_target_kind === "group"
      && Number(movedHeader.rows[0].transfer_order_id) === Number(dependency.transferOrderId)
      && movedHeader.rows[0].transfer_order_ref === dependency.transferOrderRef
      && movedHeader.rows[0].dependency_mode === "yard_replenishment"
      && movedHeader.rows[0].status === "active",
      "Dependency grouping must preserve the canonical SO, TO, mode, and status while moving only dispatch ownership.",
      { movedHeader: movedHeader.rows[0] }
    );
    const movedLines = await query(
      `SELECT line_role, sales_line_id, dispatch_target_line_key
         FROM order_dependency_lines
        WHERE dependency_id = $1
        ORDER BY id`,
      [dependency.id]
    );
    check(
      movedLines.rows
        .filter((line) => line.line_role === "sales_allocation")
        .every((line) => line.dispatch_target_line_key === `${groupRef}::${salesOrderRef}::${line.sales_line_id}`)
      && movedLines.rows
        .filter((line) => line.line_role !== "sales_allocation")
        .every((line) => line.dispatch_target_line_key === null),
      "Grouping must rewrite only Sales allocation target keys and preserve ancillary/manual line identities.",
      { movedLines: movedLines.rows }
    );
    const listedByGroup = await listOrderDependencies({ salesOrderRef: groupRef });
    check(listedByGroup.filter((entry) => String(entry.id) === String(dependency.id)).length === 1,
      "The moved dependency must be listed exactly once under its group.", { listedByGroup });
    const secondGroupSync = await syncOrderDependenciesFromDispatchPlan(groupedPlanFixture);
    check(secondGroupSync.remapped.length === 0,
      "Repeating grouped-plan synchronization must not move the same dependency twice.", { secondGroupSync });
    const moveAudit = await query(
      `SELECT COUNT(*)::int AS count
         FROM dispatch_audit_log
        WHERE action = 'dispatch.order_dependency.group_target_moved'
          AND entity_id = $1`,
      [String(dependency.id)]
    );
    check(moveAudit.rows[0].count === 1,
      "Dependency grouping must write one idempotent ownership audit event.", { moveAudit: moveAudit.rows[0] });
    const historicalPlanStructure = {
      orders: [{ id: salesOrderRef }]
    };
    const historicalCatchupTargets = safeNormalDependencyGroupingTargets(
      historicalPlanStructure,
      groupedPlanFixture
    );
    let historicalCatchupBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef, groupRef],
        "save this historical plan",
        {
          allowNormalGroupingRefs: historicalCatchupTargets.map((target) => target.sourceOrderRef),
          allowEstablishedGroupTargets: historicalCatchupTargets
        }
      );
    } catch {
      historicalCatchupBlocked = true;
    }
    check(!historicalCatchupBlocked,
      "A historical plan may adopt an already-established dependency group without treating it as a new grouping operation.",
      { historicalCatchupTargets });
    let mismatchedHistoricalGroupBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef, groupRef],
        "save this historical plan",
        {
          allowNormalGroupingRefs: historicalCatchupTargets.map((target) => target.sourceOrderRef),
          allowEstablishedGroupTargets: historicalCatchupTargets.map((target) => ({
            ...target,
            groupRef: `${target.groupRef}-WRONG`
          }))
        }
      );
    } catch (error) {
      mismatchedHistoricalGroupBlocked = error.code === "ORDER_DEPENDENCY_STRUCTURE_LOCK";
    }
    check(mismatchedHistoricalGroupBlocked,
      "The historical-plan exception must not allow a dependency to move to a different group.");
    await query(
      `UPDATE order_dependency_lines
          SET loaded_quantity = 1
        WHERE id = (
          SELECT id FROM order_dependency_lines WHERE dependency_id = $1 ORDER BY id LIMIT 1
        )`,
      [dependency.id]
    );
    let progressedHistoricalCatchupBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef, groupRef],
        "save this historical plan",
        {
          allowNormalGroupingRefs: historicalCatchupTargets.map((target) => target.sourceOrderRef),
          allowEstablishedGroupTargets: historicalCatchupTargets
        }
      );
    } catch (error) {
      progressedHistoricalCatchupBlocked = error.code === "ORDER_DEPENDENCY_STRUCTURE_LOCK";
    }
    check(progressedHistoricalCatchupBlocked,
      "The historical-plan exception must remain locked after dependency execution starts.");
    await query("UPDATE order_dependency_lines SET loaded_quantity = 0 WHERE dependency_id = $1", [dependency.id]);

    const ungroupedPlanFixture = {
      planDate: "2097-07-13",
      orders: [{ id: salesOrderRef, type: "SO" }],
      trucks: []
    };
    const establishedUngroupTargets = safeEstablishedDependencyUngroupingTargets(
      groupedPlanFixture,
      ungroupedPlanFixture
    );
    check(
      establishedUngroupTargets.length === 1
      && establishedUngroupTargets[0].sourceOrderRef === salesOrderRef
      && establishedUngroupTargets[0].groupRef === groupRef,
      "Ungrouping must identify the exact established group ownership that can return to the canonical SO.",
      { establishedUngroupTargets }
    );
    let safeUngroupBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef, groupRef],
        "ungroup these orders",
        { allowEstablishedUngroupTargets: establishedUngroupTargets }
      );
    } catch {
      safeUngroupBlocked = true;
    }
    check(!safeUngroupBlocked,
      "An unstarted yard-replenishment dependency should allow its established group to be ungrouped.");
    const ungroupSync = await syncOrderDependenciesFromDispatchPlan(ungroupedPlanFixture, {
      allowEstablishedUngroupTargets: establishedUngroupTargets
    });
    check(ungroupSync.released.some((entry) =>
      String(entry.dependencyId) === String(dependency.id)
      && entry.sourceOrderRef === salesOrderRef
      && entry.previousGroupRef === groupRef
    ), "Safe ungrouping must atomically release dependency ownership back to the canonical SO.", { ungroupSync });
    const releasedHeader = await query(
      `SELECT dispatch_target_ref, dispatch_target_kind
         FROM order_dependencies
        WHERE id = $1`,
      [dependency.id]
    );
    check(
      releasedHeader.rows[0].dispatch_target_ref === salesOrderRef
      && releasedHeader.rows[0].dispatch_target_kind === "normal",
      "Safe ungrouping did not restore canonical dependency ownership.",
      { releasedHeader: releasedHeader.rows[0] }
    );
    const releasedLines = await query(
      `SELECT sales_line_id, dispatch_target_line_key
         FROM order_dependency_lines
        WHERE dependency_id = $1
          AND line_role = 'sales_allocation'
        ORDER BY id`,
      [dependency.id]
    );
    check(
      releasedLines.rows.every((line) =>
        line.dispatch_target_line_key === `${salesOrderRef}::${salesOrderRef}::${line.sales_line_id}`),
      "Safe ungrouping did not restore canonical Sales allocation target keys.",
      { releasedLines: releasedLines.rows }
    );
    const releaseAudit = await query(
      `SELECT COUNT(*)::int AS count
         FROM dispatch_audit_log
        WHERE action = 'dispatch.order_dependency.group_target_released'
          AND entity_id = $1`,
      [String(dependency.id)]
    );
    check(releaseAudit.rows[0].count === 1,
      "Safe ungrouping must write one ownership-release audit event.", { releaseAudit: releaseAudit.rows[0] });

    const regroupSync = await syncOrderDependenciesFromDispatchPlan(groupedPlanFixture);
    check(regroupSync.remapped.some((entry) => String(entry.dependencyId) === String(dependency.id)),
      "The direct/progressed ungroup guards require the dependency to be re-established under its group.",
      { regroupSync });
    await query(
      "UPDATE order_dependencies SET dependency_mode = 'direct_to_customer' WHERE id = $1",
      [dependency.id]
    );
    let directUngroupBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef, groupRef],
        "ungroup these orders",
        { allowEstablishedUngroupTargets: establishedUngroupTargets }
      );
    } catch (error) {
      directUngroupBlocked = error.code === "ORDER_DEPENDENCY_STRUCTURE_LOCK";
    }
    check(directUngroupBlocked,
      "A direct-pickup dependency must remain structurally locked during ungrouping.");
    const directUngroupSync = await syncOrderDependenciesFromDispatchPlan(ungroupedPlanFixture, {
      allowEstablishedUngroupTargets: establishedUngroupTargets
    });
    check(directUngroupSync.released.length === 0,
      "Ungroup synchronization must not release a direct-pickup dependency.", { directUngroupSync });
    await query(
      "UPDATE order_dependencies SET dependency_mode = 'yard_replenishment' WHERE id = $1",
      [dependency.id]
    );
    await query(
      `UPDATE order_dependency_lines
          SET loaded_quantity = 1
        WHERE id = (
          SELECT id FROM order_dependency_lines WHERE dependency_id = $1 ORDER BY id LIMIT 1
        )`,
      [dependency.id]
    );
    let progressedUngroupBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef, groupRef],
        "ungroup these orders",
        { allowEstablishedUngroupTargets: establishedUngroupTargets }
      );
    } catch (error) {
      progressedUngroupBlocked = error.code === "ORDER_DEPENDENCY_STRUCTURE_LOCK";
    }
    check(progressedUngroupBlocked,
      "A progressed replenishment dependency must remain structurally locked during ungrouping.");
    const progressedUngroupSync = await syncOrderDependenciesFromDispatchPlan(ungroupedPlanFixture, {
      allowEstablishedUngroupTargets: establishedUngroupTargets
    });
    check(progressedUngroupSync.released.length === 0,
      "Ungroup synchronization must not release a progressed dependency.", { progressedUngroupSync });
    const stillGroupedHeader = await query(
      "SELECT dispatch_target_ref, dispatch_target_kind FROM order_dependencies WHERE id = $1",
      [dependency.id]
    );
    check(
      stillGroupedHeader.rows[0].dispatch_target_ref === groupRef
      && stillGroupedHeader.rows[0].dispatch_target_kind === "group",
      "A blocked direct/progressed ungroup attempt changed dependency ownership.",
      { stillGroupedHeader: stillGroupedHeader.rows[0] }
    );
    await query("UPDATE order_dependency_lines SET loaded_quantity = 0 WHERE dependency_id = $1", [dependency.id]);
    await query(
      `UPDATE order_dependencies
          SET dispatch_target_ref = sales_order_ref, dispatch_target_kind = 'normal'
        WHERE id = $1`,
      [dependency.id]
    );
    await query(
      `UPDATE order_dependency_lines
          SET dispatch_target_line_key = $2 || '::' || $2 || '::' || sales_line_id::text
        WHERE dependency_id = $1
          AND line_role = 'sales_allocation'`,
      [dependency.id, salesOrderRef]
    );
    await syncOrderDependenciesFromDispatchPlan({
      planDate: "2097-07-13",
      orders: [{
        id: `${groupRef}-SPLIT`,
        childOrders: [`${salesOrderRef}-S1`],
        childOrderDetails: [{ id: `${salesOrderRef}-S1`, originalOrderId: salesOrderRef }]
      }],
      trucks: []
    });
    const afterSplitGroupSync = await query(
      "SELECT dispatch_target_ref, dispatch_target_kind FROM order_dependencies WHERE id = $1",
      [dependency.id]
    );
    check(
      afterSplitGroupSync.rows[0].dispatch_target_ref === salesOrderRef
      && afterSplitGroupSync.rows[0].dispatch_target_kind === "normal",
      "Grouping a split child must not move its parent Sales Order dependency.",
      { afterSplitGroupSync: afterSplitGroupSync.rows[0] }
    );

    await query("UPDATE transfer_orders SET receiving_status = 'received' WHERE netsuite_id = $1", [dependency.transferOrderId]);
    await syncOrderDependenciesForTransferOrder(dependency.transferOrderId);
    const completedReplenishment = (await listOrderDependencies({ salesOrderRef }))[0];
    check(completedReplenishment.status === "delivered",
      "A fully received replenishment TO must complete its dependency.", { completedReplenishment });
    const completedReplenishmentBlock = await getSalesOrderDependencyExecutionBlock([salesOrderRef]);
    check(completedReplenishmentBlock === null,
      "A received replenishment TO must release SO driver execution.", { completedReplenishmentBlock });
    await query("UPDATE transfer_orders SET receiving_status = 'open' WHERE netsuite_id = $1", [dependency.transferOrderId]);
    await query("UPDATE order_dependencies SET status = 'active', reconciliation_status = 'pending' WHERE id = $1", [dependency.id]);
    const palletOutboundLine = await query(
      `SELECT transfer_outbound_line_id, allocated_quantity
         FROM order_dependency_lines
        WHERE dependency_id = $1 AND line_role = 'pallet'
        LIMIT 1`,
      [dependency.id]
    );
    check(palletOutboundLine.rowCount === 1,
      "The dependency fixture must contain an ancillary PALLET line.", { palletOutboundLine: palletOutboundLine.rows });
    await query("UPDATE transfer_order_lines SET quantity = $2 WHERE id = $1", [
      palletOutboundLine.rows[0].transfer_outbound_line_id,
      Math.max(0, Number(palletOutboundLine.rows[0].allocated_quantity) - 1)
    ]);
    const ancillaryPalletSync = await syncOrderDependenciesForTransferOrder(dependency.transferOrderId);
    const ancillaryPalletDependency = (await listOrderDependencies({ salesOrderRef }))[0];
    check(ancillaryPalletSync[0]?.attention === false && ancillaryPalletDependency.status === "active",
      "An ancillary PALLET count mismatch must not report a linked Sales Order material shortage.",
      { ancillaryPalletSync, ancillaryPalletDependency });
    await query("UPDATE transfer_order_lines SET quantity = $2 WHERE id = $1", [
      palletOutboundLine.rows[0].transfer_outbound_line_id,
      palletOutboundLine.rows[0].allocated_quantity
    ]);
    await query("UPDATE order_dependencies SET dependency_mode = 'direct_to_customer' WHERE id = $1", [dependency.id]);

    const outboundLine = await query(
      "SELECT transfer_outbound_line_id, allocated_quantity FROM order_dependency_lines WHERE dependency_id = $1 AND line_role = 'sales_allocation' AND item_id = $2",
      [dependency.id, itemId]
    );
    await query("UPDATE transfer_order_lines SET quantity = $2 WHERE id = $1", [
      outboundLine.rows[0].transfer_outbound_line_id,
      Number(outboundLine.rows[0].allocated_quantity) - 1
    ]);
    const reducedSync = await syncOrderDependenciesForTransferOrder(dependency.transferOrderId);
    check(reducedSync[0]?.attention === true, "Reduced NetSuite TO quantity must put its dependency into attention.", { reducedSync });
    await query("UPDATE transfer_order_lines SET quantity = $2 WHERE id = $1", [
      outboundLine.rows[0].transfer_outbound_line_id,
      outboundLine.rows[0].allocated_quantity
    ]);
    const restoredSync = await syncOrderDependenciesForTransferOrder(dependency.transferOrderId);
    const restoredDependency = (await listOrderDependencies({ salesOrderRef }))[0];
    check(restoredSync[0]?.attention === false && restoredDependency.status === "active",
      "Corrected NetSuite TO quantity should clear attention and resume the dependency.", { restoredSync, restoredDependency });

    const transferFixture = await query(
      `SELECT netsuite_id AS id, tranid, trandate::text, from_location_id AS source_location_id,
              from_location AS source_location, to_location_id AS destination_location_id,
              to_location AS destination_location, memo
         FROM transfer_orders
        WHERE netsuite_id = $1`,
      [dependency.transferOrderId]
    );
    const closedTransfer = {
      ...transferFixture.rows[0],
      status: "H",
      status_text: "Closed"
    };
    await upsertOutboundTransferOrders([closedTransfer]);
    const closedDependencies = await listOrderDependencies({ salesOrderRef, includeCancelled: true });
    const closedDependency = closedDependencies.find((row) => String(row.id) === String(dependency.id));
    check(closedDependency?.status === "cancelled",
      "A header-only NetSuite sync must automatically unlink a closed, unstarted TO dependency.", { closedDependency });
    check((await listOrderDependencies({ salesOrderRef })).every((row) => String(row.id) !== String(dependency.id)),
      "An automatically cancelled dependency must no longer be returned as an active SO link.");
    const automaticAudit = await query(
      `SELECT COUNT(*)::int AS count
         FROM dispatch_audit_log
        WHERE action = 'dispatch.order_dependency.unlinked'
          AND source = 'netsuite_sync'
          AND entity_id = $1
          AND details @> '{"automatic": true}'::jsonb`,
      [String(dependency.id)]
    );
    check(automaticAudit.rows[0].count === 1,
      "Automatic closed-TO unlink must write exactly one audit event.", { automaticAudit: automaticAudit.rows[0] });
    check((await syncOrderDependenciesForTransferOrder(dependency.transferOrderId)).length === 0,
      "Repeated closed-TO synchronization must be idempotent after the dependency is cancelled.");
    const closedOptions = await getOrderDependencyOptions({
      salesOrderRef,
      transferOrderRef: dependency.transferOrderRef,
      planDate: "2097-07-13"
    });
    check(closedOptions.matchError.includes("cannot be linked")
        && !closedOptions.transferOrders.some((row) => row.ref === dependency.transferOrderRef),
      "Closed TOs must be excluded from dependency choices and rejected when requested directly.", { closedOptions });

    await query(
      `UPDATE transfer_orders SET status = 'B', status_text = 'Pending Fulfillment' WHERE netsuite_id = $1`,
      [dependency.transferOrderId]
    );
    await query(
      `UPDATE order_dependencies
          SET status = 'active', attention_reason = null,
              reconciliation_status = 'pending', reconciled_at = null
        WHERE id = $1`,
      [dependency.id]
    );
    await query(
      `UPDATE order_dependency_lines
          SET loaded_quantity = CASE WHEN id = (
            SELECT MIN(id) FROM order_dependency_lines WHERE dependency_id = $1
          ) THEN 1 ELSE 0 END
        WHERE dependency_id = $1`,
      [dependency.id]
    );
    await upsertOutboundTransferOrders([closedTransfer]);
    const progressedClosedDependency = (await listOrderDependencies({ salesOrderRef }))[0];
    check(progressedClosedDependency?.status === "attention",
      "A closed TO with execution progress must stay linked in attention for manual review.", { progressedClosedDependency });

    await query(
      `UPDATE transfer_orders SET status = 'B', status_text = 'Pending Fulfillment' WHERE netsuite_id = $1`,
      [dependency.transferOrderId]
    );
    await query(
      `UPDATE order_dependencies
          SET status = 'active', attention_reason = null,
              reconciliation_status = 'pending', reconciled_at = null
        WHERE id = $1`,
      [dependency.id]
    );
    await query("UPDATE order_dependency_lines SET loaded_quantity = 0 WHERE dependency_id = $1", [dependency.id]);

    const unloadedPickupBlock = await getDirectPickupDependencyExecutionBlock([dependency.transferOrderRef]);
    check(unloadedPickupBlock?.transferOrderRef === dependency.transferOrderRef,
      "Direct pickup must wait for the source-yard operator load.", { unloadedPickupBlock });

    const receiving = await listReceivingOrders({ orderType: "transfer_order", destinationLocationId: 15 });
    check(!receiving.some((order) => order.tranid === dependency.transferOrderRef), "Direct TO must not appear in destination Receiving.", { receiving });

    let structureBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs(
        [salesOrderRef],
        "split this order",
        { allowNormalGroupingRefs: [salesOrderRef] }
      );
    } catch (error) {
      structureBlocked = error.code === "ORDER_DEPENDENCY_STRUCTURE_LOCK";
    }
    check(structureBlocked, "Direct dependencies must remain blocked from group/split structural changes.");

    const planId = 9876000000 + suffix;
    const loadId = `DEP-LOAD-${suffix}`;
    await query(
      `INSERT INTO dispatch_plans (id, plan_date, status, note)
       VALUES ($1, DATE '2097-07-13', 'confirmed', 'Dependency rollback harness')`,
      [planId]
    );
    await syncOrderDependenciesFromDispatchPlan({
      id: planId,
      planDate: "2097-07-13",
      orders: [{ id: groupRef, type: "SO", childOrders: [salesOrderRef], childOrderDetails: [{ id: salesOrderRef, type: "SO" }] }],
      trucks: [{ plate: "DEP-TRUCK", loads: [{ id: loadId, name: "Load 1", stops: [{ id: "dep-drop", type: "drop", orderId: groupRef }] }] }]
    });
    const groupedAssignment = (await listOrderDependencies({ salesOrderRef }))[0];
    check(groupedAssignment.plannedLoadId === loadId, "Grouped SO plan assignment must update its child's dependency.", { groupedAssignment });
    await query(
      `UPDATE transfer_order_lines
          SET loaded_qty = quantity
        WHERE id IN (
          SELECT transfer_outbound_line_id FROM order_dependency_lines
           WHERE dependency_id = $1 AND transfer_outbound_line_id IS NOT NULL
        )`,
      [dependency.id]
    );
    const loadedProgress = await syncDirectDependencyOperatorProgress(dependency.transferOrderId);
    check(loadedProgress[0]?.status === "loaded", "Source-yard operator load must advance the direct dependency to loaded.", { loadedProgress });
    const readyPickupBlock = await getDirectPickupDependencyExecutionBlock([dependency.transferOrderRef]);
    check(readyPickupBlock === null, "Loaded direct dependency must allow the driver pickup to start.", { readyPickupBlock });
    await markDirectDependencyPickupCompleted({ transferOrderRefs: [dependency.transferOrderRef], driverJobId: `dep-pick-${suffix}` });
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
         load_id, load_name, stop_id, stop_type, order_refs, photo_data_urls,
         status, started_at, completed_at
       ) VALUES ($1, $2, DATE '2097-07-13', 'dependency-driver', 'DEP-TRUCK', 'DEP-TRUCK',
                 $3, 'Load 1', 'dep-drop', 'dropoff', $4::jsonb, '[]'::jsonb,
                 'complete', now() - interval '1 minute', now())`,
      [`dep-drop-${suffix}`, planId, loadId, JSON.stringify([salesOrderRef])]
    );
    const inventoryBefore = await query(
      "SELECT quantity_available FROM inventory_balances WHERE item_id = $1 AND location_id = 15",
      [itemId]
    );
    const receipt = await completeDirectDependenciesForSalesOrderDrop({
      salesOrderRefs: [salesOrderRef],
      driverJobId: `dep-drop-${suffix}`,
      planId,
      planDate: "2097-07-13",
      truckPlate: "DEP-TRUCK",
      loadId,
      loadName: "Load 1"
    });
    check(receipt.completed.length === 1, "Customer drop should create one local direct receipt.", { receipt });
    const repeated = await completeDirectDependenciesForSalesOrderDrop({
      salesOrderRefs: [salesOrderRef],
      driverJobId: `dep-drop-${suffix}`,
      planId,
      planDate: "2097-07-13",
      truckPlate: "DEP-TRUCK",
      loadId,
      loadName: "Load 1"
    });
    check(repeated.completed.length === 0 && repeated.alreadyCompleted.length === 1, "Repeated customer drop must be idempotent.", { repeated });
    const inventoryAfter = await query(
      "SELECT quantity_available FROM inventory_balances WHERE item_id = $1 AND location_id = 15",
      [itemId]
    );
    check(Number(inventoryBefore.rows[0].quantity_available) === Number(inventoryAfter.rows[0].quantity_available), "Direct local receipt must not increase destination inventory.");
    const receiptCount = await query(
      "SELECT COUNT(*)::int AS count FROM order_dependency_receipts WHERE dependency_id = $1",
      [dependency.id]
    );
    check(receiptCount.rows[0].count === 1, "Direct receipt history must be written exactly once.", { receiptCount: receiptCount.rows[0] });

    await query(
      `UPDATE transfer_order_lines
          SET netsuite_received_qty = quantity
        WHERE id IN (
          SELECT transfer_receiving_line_id FROM order_dependency_lines
           WHERE dependency_id = $1 AND transfer_receiving_line_id IS NOT NULL
        )`,
      [dependency.id]
    );
    const reconciliation = await syncOrderDependenciesForTransferOrder(dependency.transferOrderId);
    check(reconciliation[0]?.reconciled === true, "NetSuite receipt catch-up should reconcile the local dependency.", { reconciliation });

    const block = await getSalesOrderDependencyExecutionBlock([salesOrderRef]);
    check(block === null, "Direct dependency must not block SO execution as a replenishment prerequisite.", { block });
    check(Number(line.rows[0].id) > 0, "Fixture Sales Order line should remain canonical.");

    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, item_type, item_type_text, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES ($1, 'Repeated Dependency Block', 'InvtPart', 'Inventory Item', 'EA', 1, 0, 0, 1, 50)`,
      [repeatedItemId]
    );
    await query(
      `INSERT INTO inventory_balances (item_id, location_id, location, quantity_on_hand, quantity_available)
       VALUES ($1, 1, '3445', 6, 6), ($1, 28, '2967', 4, 4),
              ($1, 15, '12441', 0, 0), ($1, 26, '150', 0, 0)`,
      [repeatedItemId]
    );
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         fulfillment_status, operator_status, local_yard_order_status,
         dispatch_address, netsuite_active
       ) VALUES (
         $1, $2, DATE '2097-07-13', 'Repeated Item Harness', 'B', 'Pending Fulfillment',
         15, '12441', 'Delivery', 'open', 'open', 'Open',
         '100 Test Street, Toronto, ON', true
       )`,
      [repeatedSalesOrderId, `${salesOrderRef}-REPEATED`]
    );
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         item_type_text, quantity, unit, pallet_qty, to_plt, to_pcs,
         netsuite_committed_qty, netsuite_backordered_qty, netsuite_active,
         location_id, location
       ) VALUES
         ($1, $3, $2, 'Repeated Dependency Block', 'DEP-REPEATED', 'InvtPart',
          'Inventory Item', 6, 'EA', 6, 1, 1, 0, 6, true, 15, '12441'),
         ($1, $4, $2, 'Repeated Dependency Block', 'DEP-REPEATED', 'InvtPart',
          'Inventory Item', 6, 'EA', 6, 1, 1, 0, 6, true, 15, '12441')`,
      [repeatedSalesOrderId, repeatedItemId, 9875001000 + suffix, 9875002000 + suffix]
    );
    const repeatedBatch = await generateTransferDependencySuggestion({
      salesOrderId: repeatedSalesOrderId,
      mode: "direct_to_customer",
      operatorId: "dependency-harness"
    });
    const repeatedProposedQuantity = repeatedBatch.proposals
      .flatMap((proposal) => proposal.lines)
      .filter((proposalLine) => String(proposalLine.itemId) === String(repeatedItemId))
      .reduce((total, proposalLine) => total + Number(proposalLine.proposedQuantity || 0), 0);
    check(repeatedProposedQuantity === 10 && repeatedBatch.uncoveredShortageQuantity === 2,
      "Repeated SO lines for one item must share the same source-yard availability and leave the true item-level undercoverage.",
      { repeatedProposedQuantity, repeatedBatch });
  });
  console.log("Order dependency rollback harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
