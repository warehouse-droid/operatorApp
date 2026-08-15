import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  activeSalesOrderFamilyDraft,
  isBilledSalesOrderIdentifier,
  listBilledSalesOrderFamilyRefs,
  reconcileSalesOrderFromNetSuite,
  salesOrderFamilyIdentity
} from "./sales-order-reconciliation-repository.js";
import {
  createScmReconciliationRun,
  finishScmReconciliationRun,
  getScmReconciliationRunDetails,
  getScmReconciliationRunDecisionSummary,
  initializeScmReconciliationRunTargets,
  markScmReconciliationRunRunning,
  updateScmReconciliationRunTarget,
  updateScmReconciliationRunTargetDecision
} from "./scm-reconciliation-repository.js";
import { listDispatchOrders } from "./dispatch-repository.js";
import { listDeliveryOrders } from "./delivery-repository.js";
import {
  cleanupBilledSalesOrderFamiliesFromDispatchPlan,
  restoreDispatchPlanSnapshot
} from "./dispatch-plan-repository.js";

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const sourceId = 9_913_116_645;
    const splitId = -9_913_116_645;
    const sourceRef = "TST-SOB116645";
    const splitRef = `${sourceRef}-S1`;
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, status, status_text, customer, outbound_location_id,
         outbound_location, sales_order_type, operator_status,
         local_yard_order_status, fulfillment_status, netsuite_active, synced_at
       ) VALUES
         ($1, $2, 'B', 'Sales Order : Pending Fulfillment', 'Test Customer', 15,
          '12441', 'Delivery', 'preparing', 'Open', 'not_fulfilled', true, now()),
         ($3, $4, 'B', 'Sales Order : Pending Fulfillment', 'Test Customer', 15,
          '12441', 'Delivery', 'open', 'Open', 'not_fulfilled', true, now())`,
      [sourceId, sourceRef, splitId, splitRef]
    );
    await query(
      `INSERT INTO dispatch_scm_so_splits (
         source_so_id, source_so_ref, split_so_id, split_so_ref, status, details
       ) VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)`,
      [sourceId, sourceRef, splitId, splitRef]
    );
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, item_type, quantity, unit,
         pallet_qty, layer_qty, packed_sales_qty, pack_quantity_source,
         netsuite_active, synced_at
       ) VALUES ($1, 7001, 25, 'MBBS-Special', 'Assembly', 1088, 'PCs', 12, 2, 12,
                 'netsuite_manual', true, now()),
                ($1, 7002, 26, 'Delivery Charge', 'Service', 1, 'Each', 0, 0, 0,
                 'sales_only', true, now()),
                ($1, 7003, 27, 'Valid Inventory With Sparse Type', 'InvtPart', 5, 'EA', 1, 0, 0,
                 'netsuite_manual', true, now()),
                ($2, 7101, 25, 'MBBS-Special', 'Assembly', 1088, 'PCs', 12, 2, 0,
                 'netsuite_manual', true, now())`,
      [sourceId, splitId]
    );

    const absentSourceId = 9_913_102_036;
    assert.equal(
      await salesOrderFamilyIdentity({ orderId: absentSourceId, orderRef: "SO10236" }),
      null,
      "A NetSuite SO that is absent from sales_orders must not acquire a fabricated local family."
    );
    await assert.rejects(
      reconcileSalesOrderFromNetSuite({
        order: {
          id: absentSourceId,
          kind: "SO",
          tranid: "SO10236",
          status: "B",
          statusText: "Sales Order : Pending Fulfillment",
          lines: []
        },
        source: "manual",
        dryRun: true
      }),
      (error) => error?.code === "SO_RECONCILIATION_LOCAL_SOURCE_MISSING"
        && error?.status === 404,
      "A NetSuite-only SO must be rejected before proposal or apply can write local reconciliation data."
    );

    const skipRun = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "SO",
      soOrderType: "delivery",
      dryRun: true,
      requestedBy: "so-reconciliation-harness"
    });
    const initializedTargets = await initializeScmReconciliationRunTargets(skipRun.id, [
      { kind: "SO", id: sourceId, tranid: sourceRef },
      { kind: "SO", id: absentSourceId, tranid: "SO10236" }
    ]);
    assert.equal(initializedTargets, 1,
      "A new run manifest must refuse an SO that is absent from sales_orders.");
    const legacyOrphan = await query(
      `INSERT INTO scm_reconciliation_run_targets (
         run_id, order_kind, netsuite_order_id, order_ref, status,
         proposed_change, updated_at
       ) VALUES (
         $1, 'SO', $2, 'SO10236', 'review',
         '{"orderKind":"SO","reconciliationStatus":"review"}'::jsonb,
         now()
       )
       RETURNING id, updated_at`,
      [skipRun.id, absentSourceId]
    );
    const skipWorker = await markScmReconciliationRunRunning(skipRun.id);
    await updateScmReconciliationRunTarget(skipRun.id, {
      kind: "SO",
      id: sourceId,
      tranid: sourceRef
    }, {
      status: "review",
      proposedChange: {
        orderKind: "SO",
        sourceOrderId: sourceId,
        sourceOrderRef: sourceRef,
        reconciliationStatus: "review",
        reason: "Harness review"
      },
      workerLeaseToken: skipWorker.checkpoint.workerLeaseToken
    });
    await finishScmReconciliationRun(skipRun.id, {
      status: "succeeded",
      summary: { reviewOrders: 1 },
      expectedWorkerLeaseToken: skipWorker.checkpoint.workerLeaseToken
    });
    const skipDetails = await getScmReconciliationRunDetails(skipRun.id);
    assert.equal(skipDetails.targetCount, 1,
      "Legacy NetSuite-only SO targets must be hidden from actionable run details.");
    assert.equal(skipDetails.targets.some((target) => target.orderRef === "SO10236"), false);
    assert.equal(skipDetails.run.reviewDecisionSummary.reviewTargets, 1,
      "Decision counts must include only DB-backed SO targets.");
    assert.deepEqual(await getScmReconciliationRunDecisionSummary(skipRun.id), {
      reviewTargets: 1,
      decidedTargets: 0,
      pendingTargets: 1,
      skippedTargets: 0,
      acceptedTargets: 0,
      keptReviewTargets: 0
    });
    await assert.rejects(
      updateScmReconciliationRunTargetDecision({
        runId: skipRun.id,
        targetId: legacyOrphan.rows[0].id,
        decision: "skip",
        note: "A legacy NetSuite-only target must not be actionable.",
        actor: "so-reconciliation-harness",
        expectedUpdatedAt: legacyOrphan.rows[0].updated_at
      }),
      (error) => error?.status === 404,
      "A legacy NetSuite-only SO target must not accept a review decision."
    );
    const skipTarget = skipDetails.targets[0];
    const skipped = await updateScmReconciliationRunTargetDecision({
      runId: skipRun.id,
      targetId: skipTarget.id,
      decision: "skip",
      note: "Harness verifies SO Skip persistence.",
      actor: "so-reconciliation-harness",
      expectedUpdatedAt: skipTarget.updatedAt
    });
    assert.equal(skipped.target.reviewDecision, "skip");
    const skippedState = await query(
      `SELECT order_kind, broad_reconciliation_skipped
         FROM scm_reconciliation_order_state
        WHERE order_kind = 'SO'
          AND source_order_netsuite_id = $1`,
      [sourceId]
    );
    assert.equal(skippedState.rowCount, 1,
      "Skipping a local SO must persist one reconciliation state row.");
    assert.equal(skippedState.rows[0].broad_reconciliation_skipped, true);

    const family = await salesOrderFamilyIdentity({ orderRef: splitRef });
    assert.equal(family.sourceOrderId, sourceId);
    assert.deepEqual(family.familyRefs, [sourceRef, splitRef]);
    assert.equal((await activeSalesOrderFamilyDraft(family)).blocked, true);

    const authoritative = {
      id: sourceId,
      kind: "SO",
      tranid: sourceRef,
      status: "G",
      statusText: "Sales Order : Billed",
      entityId: 44,
      entity: "Test Customer",
      sourceLocationId: 15,
      sourceLocation: "12441",
      deliveryMethodId: 2,
      deliveryMethod: "Delivery",
      lines: [
        {
          sourceLineKey: "7001",
          itemId: 25,
          itemName: "MBBS-Special",
          itemType: "Assembly",
          quantity: 1088,
          cumulativeProgressQuantity: 1088,
          unit: "PCs",
          locationId: 15,
          location: "12441",
          palletQty: 12,
          layerQty: 2,
          toPlt: 102.3,
          toLyr: 12.79
        },
        {
          sourceLineKey: "7002",
          itemId: 26,
          itemName: "Delivery Charge",
          itemType: "Service",
          quantity: 1,
          cumulativeProgressQuantity: 0,
          unit: "Each",
          locationId: 15,
          location: "12441"
        },
        {
          sourceLineKey: "7003",
          itemId: 27,
          itemName: "Valid Inventory With Sparse Type",
          itemType: "",
          itemTypeText: "",
          quantity: 5,
          cumulativeProgressQuantity: 0,
          unit: "EA",
          locationId: 15,
          location: "12441",
          palletQty: 1
        }
      ]
    };

    const blocked = await reconcileSalesOrderFromNetSuite({
      order: authoritative,
      source: "manual",
      dryRun: false
    });
    assert.equal(blocked.reconciliationStatus, "review");
    assert.equal(blocked.blockedByActiveDraft, true);
    assert.equal((await query("SELECT status FROM sales_orders WHERE netsuite_id = $1", [sourceId])).rows[0].status, "B");

    const closedWhileDraft = await reconcileSalesOrderFromNetSuite({
      order: {
        ...authoritative,
        status: "H",
        statusText: "Sales Order : Closed",
        lines: authoritative.lines.map((line) => ({
          ...line,
          cumulativeProgressQuantity: line.sourceLineKey === "7001" ? 400 : 0
        }))
      },
      source: "manual",
      dryRun: false
    });
    assert.equal(closedWhileDraft.closed, true);
    assert.equal(closedWhileDraft.blockedByActiveDraft, false,
      "A terminal NetSuite Closed header must override an unfinished local packing draft.");
    assert.equal(closedWhileDraft.applicationStatus, "Completed");
    assert.deepEqual({
      ordered: closedWhileDraft.quantities.ordered,
      fulfilled: closedWhileDraft.quantities.fulfilled,
      abandoned: closedWhileDraft.quantities.abandoned,
      remaining: closedWhileDraft.quantities.remaining
    }, {
      ordered: 1088,
      fulfilled: 400,
      abandoned: 688,
      remaining: 0
    });
    const closedCalculation = await query(
      `SELECT netsuite_terminal_state, application_status, ordered_qty,
              fulfilled_qty, abandoned_qty, remaining_qty
         FROM scm_reconciliation_order_state
        WHERE order_kind = 'SO'
          AND source_order_netsuite_id = $1`,
      [sourceId]
    );
    assert.deepEqual({
      terminalState: closedCalculation.rows[0].netsuite_terminal_state,
      applicationStatus: closedCalculation.rows[0].application_status,
      ordered: Number(closedCalculation.rows[0].ordered_qty),
      fulfilled: Number(closedCalculation.rows[0].fulfilled_qty),
      abandoned: Number(closedCalculation.rows[0].abandoned_qty),
      remaining: Number(closedCalculation.rows[0].remaining_qty)
    }, {
      terminalState: "closed",
      applicationStatus: "Completed",
      ordered: 1088,
      fulfilled: 400,
      abandoned: 688,
      remaining: 0
    });

    await query(
      `UPDATE sales_orders
          SET operator_status = 'open', preparing_operator_id = NULL
        WHERE netsuite_id = $1`,
      [sourceId]
    );
    await query(
      `UPDATE sales_order_lines
          SET packed_sales_qty = 0, confirmed = false
        WHERE sales_order_id = $1`,
      [sourceId]
    );
    const queuedAuthoritative = {
      ...authoritative,
      status: "B",
      statusText: "Sales Order : Pending Fulfillment",
      lines: authoritative.lines.map((line) => ({
        ...line,
        cumulativeProgressQuantity: 0
      }))
    };
    await assert.rejects(
      reconcileSalesOrderFromNetSuite({
        order: { ...queuedAuthoritative, lines: [] },
        source: "manual",
        dryRun: false
      }),
      /complete authoritative order with item lines/,
      "An incomplete NetSuite response must fail closed before deactivating source lines."
    );
    const afterIncompleteSource = await query(
      `SELECT count(*) FILTER (WHERE netsuite_active)::int AS active_lines,
              max(pallet_qty) FILTER (WHERE line_id = 7001) AS pallet_qty,
              max(layer_qty) FILTER (WHERE line_id = 7001) AS layer_qty
         FROM sales_order_lines
        WHERE sales_order_id = $1`,
      [sourceId]
    );
    assert.equal(afterIncompleteSource.rows[0].active_lines, 3);
    assert.equal(Number(afterIncompleteSource.rows[0].pallet_qty), 12);
    assert.equal(Number(afterIncompleteSource.rows[0].layer_qty), 2);
    const queued = await reconcileSalesOrderFromNetSuite({
      order: queuedAuthoritative,
      source: "manual",
      dryRun: false
    });
    assert.equal(queued.billed, false);
    assert.equal(queued.applicationStatus, "Queued");
    assert.equal(queued.quantities.ordered, 1088);
    assert.equal(queued.quantities.fulfilled, 0);
    assert.equal(queued.quantities.remaining, 1088);
    const fulfilledHeaderProposal = await reconcileSalesOrderFromNetSuite({
      order: {
        ...queuedAuthoritative,
        status: "F",
        statusText: "Sales Order : Pending Billing"
      },
      source: "manual",
      dryRun: true
    });
    assert.equal(fulfilledHeaderProposal.applicationStatus, "Completed");
    assert.equal(fulfilledHeaderProposal.quantities.fulfilled, 1088,
      "An exact fully fulfilled SO header must override stale zero line progress.");
    assert.equal(fulfilledHeaderProposal.quantities.remaining, 0);
    const queuedLines = await query(
      `SELECT line_id, quantity, unit, pallet_qty, layer_qty,
              pack_quantity_source, netsuite_active
         FROM sales_order_lines
        WHERE sales_order_id = $1
        ORDER BY line_id`,
      [sourceId]
    );
    assert.equal(queuedLines.rows.length, 3);
    assert.deepEqual(
      queuedLines.rows.map((line) => [Number(line.line_id), line.netsuite_active]),
      [[7001, true], [7002, true], [7003, true]],
      "Calculation filtering must never deactivate an authoritative source line, including a valid inventory line with sparse type metadata."
    );
    assert.equal(Number(queuedLines.rows[0].quantity), 1088);
    assert.equal(queuedLines.rows[0].unit, "PCs");
    assert.equal(Number(queuedLines.rows[0].pallet_qty), 12,
      "SO reconciliation must preserve the authoritative 12 PLT value.");
    assert.equal(Number(queuedLines.rows[0].layer_qty), 2,
      "SO reconciliation must preserve the authoritative 2 LYR value.");
    assert.equal(queuedLines.rows[0].pack_quantity_source, "netsuite_manual");
    const queuedCalculation = await query(
      `SELECT state.application_status,
              state.reconciliation_status,
              state.ordered_qty,
              state.fulfilled_qty,
              state.remaining_qty,
              count(line.*) FILTER (WHERE line.netsuite_active = true) AS calculated_line_count
         FROM scm_reconciliation_order_state state
         LEFT JOIN scm_reconciliation_order_line_state line
           ON line.order_state_id = state.id
        WHERE state.order_kind = 'SO'
          AND state.source_order_netsuite_id = $1
        GROUP BY state.id`,
      [sourceId]
    );
    assert.equal(queuedCalculation.rows[0].application_status, "Queued");
    assert.equal(queuedCalculation.rows[0].reconciliation_status, "current");
    assert.equal(Number(queuedCalculation.rows[0].ordered_qty), 1088);
    assert.equal(Number(queuedCalculation.rows[0].fulfilled_qty), 0);
    assert.equal(Number(queuedCalculation.rows[0].remaining_qty), 1088);
    assert.equal(Number(queuedCalculation.rows[0].calculated_line_count), 1,
      "Only lines accepted by the calculation policy belong in the separate SO calculation projection.");

    const calculationOnlyCompleted = await reconcileSalesOrderFromNetSuite({
      order: authoritative,
      source: "manual",
      dryRun: false
    });
    assert.equal(calculationOnlyCompleted.calculatedApplicationStatus, "Completed");
    const canonicalAfterCalculation = await query(
      `SELECT status, status_text, fulfillment_status, operator_status,
              local_yard_order_status, netsuite_active
         FROM sales_orders
        WHERE netsuite_id = $1`,
      [sourceId]
    );
    assert.deepEqual(canonicalAfterCalculation.rows[0], {
      status: "B",
      status_text: "Sales Order : Pending Fulfillment",
      fulfillment_status: "not_fulfilled",
      operator_status: "open",
      local_yard_order_status: "Open",
      netsuite_active: true
    }, "SO calculation must not write any canonical header field.");
    const canonicalLinesAfterCalculation = await query(
      `SELECT line_id, pallet_qty, layer_qty, netsuite_active
         FROM sales_order_lines
        WHERE sales_order_id = $1
        ORDER BY line_id`,
      [sourceId]
    );
    assert.deepEqual(
      canonicalLinesAfterCalculation.rows.map((line) => [
        Number(line.line_id), Number(line.pallet_qty), Number(line.layer_qty), line.netsuite_active
      ]),
      [[7001, 12, 2, true], [7002, 0, 0, true], [7003, 1, 0, true]],
      "SO calculation must not rewrite or deactivate canonical source lines."
    );

    // Model the independent normal NetSuite source-sync phase. Reconciliation
    // may consume this Billed header, but it must not be the writer that sets it.
    await query(
      `UPDATE sales_orders
          SET status = 'G',
              status_text = 'Sales Order : Billed',
              synced_at = now()
        WHERE netsuite_id = $1`,
      [sourceId]
    );

    await query(
      `INSERT INTO dispatch_trucks (plate, active)
       SELECT 'TST-SO-RECON', true
        WHERE NOT EXISTS (
          SELECT 1 FROM dispatch_trucks WHERE upper(BTRIM(plate)) = 'TST-SO-RECON'
        )`
    );
    const fixtureTruck = (await query(
      `UPDATE dispatch_trucks
          SET active = true
        WHERE upper(BTRIM(plate)) = 'TST-SO-RECON'
        RETURNING id, plate`
    )).rows[0];

    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ('2099-11-29', 'draft', 'SO billed reconciliation harness')
       ON CONFLICT (plan_date) DO UPDATE SET note = EXCLUDED.note
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
       VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb, now())
       ON CONFLICT (plan_id) DO UPDATE SET orders = EXCLUDED.orders, trucks = EXCLUDED.trucks,
         summary = EXCLUDED.summary, saved_at = now()`,
      [
        plan.rows[0].id,
        JSON.stringify([
          { id: sourceRef, type: "SO" },
          { id: splitRef, type: "SO", originalOrderId: sourceRef },
          { id: "TST-SOB-OTHER", type: "SO" }
        ]),
        JSON.stringify([{
          id: String(fixtureTruck.id),
          plate: fixtureTruck.plate,
          loads: [{
            id: "LOAD-2",
            stops: [
              { id: "STOP-12441", type: "pick", orderId: sourceRef },
              { id: "STOP-OTHER", type: "drop", orderId: "TST-SOB-OTHER" }
            ]
          }]
        }])
      ]
    );

    const activeJobId = `TST-SO-BILLED-${sourceId}`;
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, load_id, stop_id, stop_type,
         order_refs, status, started_at, completed_at
       ) VALUES ($1, $2, '2099-11-29', 'so-reconcile-harness', 'LOAD-2',
                 'STOP-12441', 'pickup', $3::jsonb, 'in_progress', now(), NULL)`,
      [activeJobId, plan.rows[0].id, JSON.stringify([])]
    );
    const applied = await reconcileSalesOrderFromNetSuite({
      order: authoritative,
      source: "manual",
      dryRun: false
    });
    assert.equal(applied.billed, true);
    assert.equal(applied.blockedByActiveDraft, false);
    assert.equal(applied.quantities.ordered, 1088);
    assert.equal(applied.quantities.fulfilled, 1088);
    assert.equal(applied.quantities.remaining, 0);
    assert.equal(applied.planCleanup.deferred, true);
    assert.equal(applied.planCleanup.changedPlans.length, 0);
    const deferredPlan = await query(
      `SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1`,
      [plan.rows[0].id]
    );
    assert.deepEqual(
      deferredPlan.rows[0].orders.map((order) => order.id),
      [sourceRef, splitRef, "TST-SOB-OTHER"],
      "An in-progress driver job must preserve the live route."
    );
    await query(
      `UPDATE driver_job_records
          SET status = 'complete', completed_at = now()
        WHERE job_id = $1`,
      [activeJobId]
    );
    const postDriverCleanup = await cleanupBilledSalesOrderFamiliesFromDispatchPlan({
      planId: plan.rows[0].id,
      actor: "so-reconciliation-harness-driver-complete"
    });
    assert.equal(postDriverCleanup.familyCount, 1);
    assert.equal(postDriverCleanup.deferredFamilies.length, 0);
    assert.equal(postDriverCleanup.changedPlans.length, 1);

    const headers = await query(
      `SELECT netsuite_id, status, status_text, netsuite_active,
              fulfillment_status, operator_status, local_yard_order_status
         FROM sales_orders
        WHERE netsuite_id = ANY($1::bigint[])
        ORDER BY netsuite_id`,
      [[sourceId, splitId]]
    );
    assert.equal(headers.rows.length, 2);
    const splitHeader = headers.rows.find((header) => Number(header.netsuite_id) === splitId);
    const sourceHeader = headers.rows.find((header) => Number(header.netsuite_id) === sourceId);
    assert.equal(sourceHeader.status, "G",
      "The separate normal source-sync phase must own the NetSuite header.");
    assert.equal(sourceHeader.status_text, "Sales Order : Billed");
    assert.equal(sourceHeader.netsuite_active, true);
    assert.equal(sourceHeader.fulfillment_status, "not_fulfilled",
      "Calculated fulfillment belongs in reconciliation state, not the canonical source field.");
    assert.equal(sourceHeader.operator_status, "open");
    assert.equal(sourceHeader.local_yard_order_status, "Open");
    assert.equal(splitHeader.status, "B",
      "A calculation must not rewrite a local split header as if NetSuite returned it.");
    assert.equal(splitHeader.status_text, "Sales Order : Pending Fulfillment");
    assert.equal(splitHeader.netsuite_active, true);
    assert.equal(splitHeader.fulfillment_status, "not_fulfilled");
    const completedCalculation = await query(
      `SELECT application_status, ordered_qty, fulfilled_qty, remaining_qty
         FROM scm_reconciliation_order_state
        WHERE order_kind = 'SO'
          AND source_order_netsuite_id = $1`,
      [sourceId]
    );
    assert.equal(completedCalculation.rows[0].application_status, "Completed");
    assert.equal(Number(completedCalculation.rows[0].ordered_qty), 1088);
    assert.equal(Number(completedCalculation.rows[0].fulfilled_qty), 1088);
    assert.equal(Number(completedCalculation.rows[0].remaining_qty), 0);
    assert.equal(await isBilledSalesOrderIdentifier(sourceId), true);
    assert.equal(await isBilledSalesOrderIdentifier(splitRef), true);
    const dispatchOrders = await listDispatchOrders({ type: "SO", search: sourceRef });
    assert.equal(
      dispatchOrders.some((order) => [sourceRef, splitRef].includes(order.id)),
      false,
      "Billed SO families must be absent from the dispatch pool."
    );
    const operatorOrders = await listDeliveryOrders({
      locationId: 15,
      status: "active",
      orderType: "sales_order"
    });
    assert.equal(
      operatorOrders.some((order) => [sourceRef, splitRef].includes(order.tranid)),
      false,
      "Billed SO families must be absent from the operator pool."
    );
    const lines = await query(
      `SELECT line_id, quantity, unit, pallet_qty, layer_qty,
              pack_quantity_source, netsuite_active
         FROM sales_order_lines
        WHERE sales_order_id = $1
        ORDER BY line_id`,
      [sourceId]
    );
    assert.equal(lines.rows.length, 3);
    const inventoryLine = lines.rows.find((line) => Number(line.line_id) === 7001);
    const deliveryChargeLine = lines.rows.find((line) => Number(line.line_id) === 7002);
    const sparseInventoryLine = lines.rows.find((line) => Number(line.line_id) === 7003);
    assert.equal(Number(inventoryLine.quantity), 1088);
    assert.equal(inventoryLine.unit, "PCs");
    assert.equal(Number(inventoryLine.pallet_qty), 12);
    assert.equal(Number(inventoryLine.layer_qty), 2);
    assert.equal(inventoryLine.pack_quantity_source, "netsuite_manual");
    assert.equal(inventoryLine.netsuite_active, true);
    assert.equal(deliveryChargeLine.netsuite_active, true);
    assert.equal(sparseInventoryLine.netsuite_active, true,
      "A valid inventory source line excluded from calculation must remain active.");

    const currentPlan = await query(
      `SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1`,
      [plan.rows[0].id]
    );
    assert.deepEqual(currentPlan.rows[0].orders.map((order) => order.id), ["TST-SOB-OTHER"]);
    assert.deepEqual(
      currentPlan.rows[0].trucks[0].loads[0].stops.map((stop) => stop.id),
      ["STOP-OTHER"]
    );
    const history = await query(
      `SELECT id, archive_reason, orders
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [plan.rows[0].id]
    );
    assert.equal(history.rows[0].archive_reason, "before_billed_so_reconciliation");
    assert.deepEqual(history.rows[0].orders.map((order) => order.id), [sourceRef, splitRef, "TST-SOB-OTHER"]);

    const restored = await restoreDispatchPlanSnapshot(history.rows[0].id, {
      sessionId: "so-reconciliation-harness-restore"
    });
    assert.deepEqual(
      restored.plan.orders.map((order) => order.id),
      ["TST-SOB-OTHER"],
      "Restoring an archived snapshot must not resurrect a Billed SO family."
    );
    assert.deepEqual(
      restored.plan.trucks[0].loads[0].stops.map((stop) => stop.id),
      ["STOP-OTHER"]
    );

    await query(
      `UPDATE sales_orders
          SET status = 'B',
              status_text = CASE
                WHEN netsuite_id = $1 THEN 'Sales   Order :  Billed'
                ELSE 'Sales Order : Pending Fulfillment'
              END
        WHERE netsuite_id = ANY($2::bigint[])`,
      [sourceId, [sourceId, splitId]]
    );
    assert.equal(
      await isBilledSalesOrderIdentifier(splitRef),
      true,
      "A split must stay hidden when its canonical NetSuite SO is Billed."
    );
    assert.deepEqual(
      (await listBilledSalesOrderFamilyRefs())
        .filter((entry) => [sourceRef, splitRef].includes(entry.ref))
        .map((entry) => entry.ref)
        .sort(),
      [sourceRef, splitRef].sort(),
      "Billed-family suppression must include both canonical and split references."
    );
    await query(
      `UPDATE sales_orders
          SET netsuite_active = true,
              operator_status = 'open',
              local_yard_order_status = 'Open',
              fulfillment_status = 'not_fulfilled'
        WHERE netsuite_id = $1`,
      [splitId]
    );
    await query(
      `UPDATE sales_order_lines
          SET netsuite_active = true
        WHERE sales_order_id = $1`,
      [splitId]
    );
    assert.equal(
      (await listDispatchOrders({ type: "SO", search: splitRef }))
        .some((order) => order.id === splitRef),
      false,
      "A locally open split must stay out of dispatch when its canonical NetSuite SO is Billed."
    );
    assert.equal(
      (await listDeliveryOrders({
        locationId: 15,
        status: "active",
        orderType: "sales_order"
      })).some((order) => order.tranid === splitRef),
      false,
      "A locally open split must stay out of the operator pool when its canonical NetSuite SO is Billed."
    );
  });
  console.log("Sales-order reconciliation integration harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
