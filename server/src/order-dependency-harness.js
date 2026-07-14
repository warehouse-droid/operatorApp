import { beginRollbackContext, closeDb, query } from "./db.js";
import { config } from "./config.js";
import { matchNetSuiteLocation } from "./netsuite.js";
import {
  assertNoActiveOrderDependenciesByRefs,
  calculateTransferProposalPallets,
  completeDirectDependenciesForSalesOrderDrop,
  confirmTransferDependencyBatch,
  enrichDispatchOrdersWithDependencies,
  generateTransferDependencySuggestion,
  getDirectPickupDependencyExecutionBlock,
  getSalesOrderDependencyExecutionBlock,
  listOrderDependencies,
  listTransferDependencyCandidates,
  markDirectDependencyPickupCompleted,
  prepareTransferDependencyPalletItem,
  reopenTransferDependencyCandidate,
  reviewTransferDependencyCandidate,
  syncDirectDependencyOperatorProgress,
  syncOrderDependenciesForTransferOrder,
  syncOrderDependenciesFromDispatchPlan,
  validateDispatchPlanDependencies
} from "./order-dependency-repository.js";
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

    const candidates = await listTransferDependencyCandidates({ salesOrderId });
    check(candidates.length === 1, "Backordered Sales Order should be a dependency candidate.", { candidates });
    check(candidates[0].uncoveredQuantity === 10, "Candidate should expose the exact NetSuite backordered quantity.", { candidate: candidates[0] });

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

    const batch = await generateTransferDependencySuggestion({
      salesOrderId,
      mode: "direct_to_customer",
      operatorId: "dependency-harness"
    });
    check(batch.proposals.length === 2, "Suggestion should cover the shortage from two source yards.", { batch });
    check(batch.uncoveredShortageQuantity === 0, "Suggestion should fully cover the shortage.", { batch });
    await prepareTransferDependencyPalletItem(batch.id, { itemId: palletItemId, itemName: "PALLET" }, "dependency-harness");

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

    let createAttempt = 0;
    const firstResult = await confirmTransferDependencyBatch(batch.id, {
      operatorId: "dependency-harness",
      createTransferOrder: async () => {
        const index = createAttempt;
        createAttempt += 1;
        if (index === 1) throw new Error("Intentional fake NetSuite failure");
        return { id: createdTransferIds[index] };
      },
      hydrateTransferOrder: fakeHydrateTransferOrder
    });
    check(firstResult.results.filter((entry) => entry.status === "created").length === 1, "Successful NetSuite TO must survive a later proposal failure.", { firstResult });
    check(firstResult.results.filter((entry) => entry.status === "failed").length === 1, "Failed proposal must be retained for retry.", { firstResult });

    const createdAllocation = await query(
      `SELECT dl.id, dl.allocated_quantity
         FROM order_dependency_lines dl
         JOIN order_dependencies d ON d.id = dl.dependency_id
        WHERE d.sales_order_id = $1 AND dl.line_role = 'sales_allocation'
        ORDER BY dl.id LIMIT 1`,
      [salesOrderId]
    );
    await query("UPDATE order_dependency_lines SET allocated_quantity = 10 WHERE id = $1", [createdAllocation.rows[0].id]);
    await query("UPDATE scm_transfer_dependency_batches SET status = 'created' WHERE id = $1", [batch.id]);
    const completedAfterTransferCreation = await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "completed" });
    check(completedAfterTransferCreation.length === 1
      && completedAfterTransferCreation[0].completionType === "transfer_created",
    "A fully allocated created batch must remain visible in the Completed queue.",
    { completedAfterTransferCreation });
    await query("UPDATE order_dependency_lines SET allocated_quantity = $2 WHERE id = $1",
      [createdAllocation.rows[0].id, createdAllocation.rows[0].allocated_quantity]);
    await query("UPDATE scm_transfer_dependency_batches SET status = $2 WHERE id = $1", [batch.id, firstResult.batch.status]);

    const dependency = (await listOrderDependencies({ salesOrderRef }))[0];
    check(dependency?.mode === "direct_to_customer", "Created proposal should produce a direct dependency.", { dependency });
    check(dependency.lines.length === 2, "Dependency should preserve material allocation and ancillary PALLET quantity.", { dependency });
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

    const unloadedPickupBlock = await getDirectPickupDependencyExecutionBlock([dependency.transferOrderRef]);
    check(unloadedPickupBlock?.transferOrderRef === dependency.transferOrderRef,
      "Direct pickup must wait for the source-yard operator load.", { unloadedPickupBlock });

    const receiving = await listReceivingOrders({ orderType: "transfer_order", destinationLocationId: 15 });
    check(!receiving.some((order) => order.tranid === dependency.transferOrderRef), "Direct TO must not appear in destination Receiving.", { receiving });

    let structureBlocked = false;
    try {
      await assertNoActiveOrderDependenciesByRefs([salesOrderRef], "split this order");
    } catch (error) {
      structureBlocked = error.code === "ORDER_DEPENDENCY_STRUCTURE_LOCK";
    }
    check(structureBlocked, "Active dependency must block group/split structural changes.");

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
  });
  console.log("Order dependency rollback harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
