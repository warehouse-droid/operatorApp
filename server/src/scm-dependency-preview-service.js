import { query } from "./db.js";
import { driverActivityOrderRefs } from "./driver-co-pickup-evidence.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from './dispatch-fleet-status.js';
import { lockDispatchPlanEditLease, lockDispatchPlanEditLeaseDate } from './dispatch-plan-lease-repository.js';
import { lockConsolidatedLoadOrders } from "./consolidation-load-locks.js";
import { completedCoArrivalSql, coSourcePackingActivityRefs, coSourcePackingOrders } from "./co-source-packing-handoff.js";
import { getDispatchPlan } from "./dispatch-plan-repository.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";
import { listClosedNetSuiteOrders } from "./netsuite-closed-order-repository.js";
import { completedOrderDependencyUnlinkAllowed } from "./order-dependency-repository.js";
import {
  evaluateDependencyMutationBlockers,
  normalizeDependencyMutationAction
} from "./scm-dependency-management-policy.js";

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, details });
}

function activeWorkStatus(value) {
  return ["preparing", "confirmed", "packed", "loaded", "fulfilled", "shipped", "received", "complete", "completed"]
    .includes(text(value).toLowerCase());
}

async function relationshipContext(command = {}) {
  const action = text(command.action);
  const payload = command.payload || {};
  if (["unlink_to", "change_mode"].includes(action)) {
    const dependencyId = Number(payload.dependencyId || command.dependencyId);
    const result = await query(
      `SELECT dependency.id, dependency.dispatch_target_ref, dependency.sales_order_ref,
              dependency.transfer_order_ref, dependency.dependency_mode,
              dependency.planned_plan_id, dependency.planned_date::text AS planned_date,
              dependency.status
         FROM order_dependencies dependency
        WHERE dependency.id = $1`,
      [dependencyId]
    );
    if (!result.rowCount) {throw statusError(404, "ORDER_DEPENDENCY_NOT_FOUND", "The transfer dependency was not found.");}
    return { dependency: result.rows[0] };
  }
  if (action === "unlink_po") {
    const allocationId = Number(payload.allocationId || command.allocationId);
    const result = await query(
      `SELECT id, dispatch_target_ref, sales_order_ref, po_order_ref, status
         FROM dispatch_so_po_allocations
        WHERE id = $1`,
      [allocationId]
    );
    if (!result.rowCount) {throw statusError(404, "PO_ALLOCATION_NOT_FOUND", "The PO relationship was not found.");}
    return { poAllocation: result.rows[0] };
  }
  return {};
}

async function closedOrderRefs(refs = []) {
  if (!refs.length) {return [];}
  const conflicts = await listClosedNetSuiteOrders(refs);
  return [...new Set(conflicts
    .map((conflict) => text(conflict.requestedRef || conflict.canonicalRef))
    .filter(Boolean))];
}

// Match createOrderDependency's key-first, legacy-ID fallback exactly. Only a
// fully resolved explicit selection can narrow the existing whole-order guard.
function selectedSalesLineIds(action, allocations, lines) {
  if (action !== "link_to" || !Array.isArray(allocations) || !allocations.length) {return null;}
  const byKey = new Map(lines.map((line) => [line.targetLineKey, line]));
  const selected = allocations.map((allocation) => (
    byKey.get(text(allocation?.targetLineKey))
    || lines.find((line) => Number(line.salesLineId) === Number(allocation?.salesLineId))
  ));
  if (selected.some((line) => !line || !Number.isSafeInteger(line.salesLineId) || line.salesLineId <= 0)) {return null;}
  return [...new Set(selected.map((line) => line.salesLineId))];
}

function salesStatusBlocks(value, salesLineIds) {
  // Packed/confirmed summarize other lines too; preparation and execution do not.
  return activeWorkStatus(value)
    && !(salesLineIds && ["confirmed", "packed"].includes(text(value).toLowerCase()));
}

async function lockDependencyOperatorOrders(salesRefs, transferRefs) {
  const orders = await query(
    `SELECT netsuite_id FROM sales_orders WHERE tranid = ANY($1::text[])
     UNION SELECT netsuite_id FROM transfer_orders WHERE tranid = ANY($2::text[])`,
    [salesRefs, transferRefs]
  );
  const sourceCos = await coSourcePackingOrders(salesRefs);
  await lockConsolidatedLoadOrders([
    ...orders.rows.map((row) => row.netsuite_id),
    ...sourceCos.map((row) => row.delivery_order_id).filter(Boolean)
  ]);
  // Advisory locks serialize normal Operator mutations. Row locks also fence
  // direct canonical-row writers until the dependency transaction commits.
  for (const [header, lineTable, parent, refs] of [
    ["sales_orders", "sales_order_lines", "sales_order_id", salesRefs],
    ["transfer_orders", "transfer_order_lines", "transfer_order_id", transferRefs]
  ]) {
    await query(`SELECT netsuite_id FROM ${header} WHERE tranid = ANY($1::text[])
      ORDER BY netsuite_id FOR UPDATE`, [refs]);
    await query(`SELECT line.id FROM ${lineTable} line JOIN ${header} header ON header.netsuite_id = line.${parent}
      WHERE header.tranid = ANY($1::text[]) ORDER BY line.id FOR UPDATE OF line`, [refs]);
  }
  const currentCos = await coSourcePackingOrders(salesRefs);
  if (JSON.stringify(currentCos.map(row => [row.id, row.delivery_order_id]).sort())
    !== JSON.stringify(sourceCos.map(row => [row.id, row.delivery_order_id]).sort())) {
    throw statusError(409, "CO_SOURCE_PACKING_CHANGED", "A source CO changed while linking. Refresh and try again.");
  }
  const coIds = sourceCos.map((row) => row.id);
  await query("SELECT id FROM local_co_orders WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [coIds]);
  await query("SELECT id FROM local_co_order_lines WHERE co_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [coIds]);
}

async function operatorActivityRefs({ salesRefs = [], transferRefs = [], salesLineIds = null, allowReceivedCo = false } = {}) {
  const refs = [];
  if (salesRefs.length) {
    refs.push(...await coSourcePackingActivityRefs(salesRefs, salesLineIds, { allowReceivedCo }));
    const sales = await query(
      `SELECT DISTINCT sales.tranid AS ref, sales.operator_status,
              sales.local_yard_order_status, sales.preparing_operator_id,
              sales.preparing_started_at,
              bool_or(COALESCE(line.loaded_qty, 0) > 0) AS order_loaded,
              bool_or(($2::bigint[] IS NULL OR line.id = ANY($2::bigint[])) AND (
                COALESCE(line.confirmed, false)
                OR ($2::bigint[] IS NOT NULL AND line.confirmed_at IS NOT NULL)
                OR COALESCE(line.packed_pallet_qty, 0) > 0
                OR COALESCE(line.packed_layer_qty, 0) > 0
                OR COALESCE(line.packed_section_qty, 0) > 0
                OR COALESCE(line.packed_piece_qty, 0) > 0
                OR COALESCE(line.packed_sales_qty, 0) > 0
                OR COALESCE(line.loaded_qty, 0) > 0
              )) AS line_started
         FROM sales_orders sales
         LEFT JOIN sales_order_lines line ON line.sales_order_id = sales.netsuite_id
        WHERE sales.tranid = ANY($1::text[])
        GROUP BY sales.netsuite_id`,
      [salesRefs, salesLineIds]
    );
    refs.push(...sales.rows.filter((row) => (
      text(row.preparing_operator_id)
      || row.preparing_started_at
      || salesStatusBlocks(row.operator_status, salesLineIds)
      || salesStatusBlocks(row.local_yard_order_status, salesLineIds)
      || row.order_loaded === true
      || row.line_started === true
    )).map((row) => text(row.ref)));
  }
  if (transferRefs.length) {
    const transfers = await query(
      `SELECT DISTINCT transfer.tranid AS ref, transfer.outbound_operator_status,
              transfer.local_yard_order_status, transfer.preparing_operator_id,
              transfer.preparing_started_at,
              bool_or(
                COALESCE(line.confirmed, false)
                OR COALESCE(line.packed_pallet_qty, 0) > 0
                OR COALESCE(line.packed_layer_qty, 0) > 0
                OR COALESCE(line.packed_section_qty, 0) > 0
                OR COALESCE(line.packed_piece_qty, 0) > 0
                OR COALESCE(line.packed_sales_qty, 0) > 0
                OR COALESCE(line.loaded_qty, 0) > 0
              ) AS line_started
         FROM transfer_orders transfer
         LEFT JOIN transfer_order_lines line
           ON line.transfer_order_id = transfer.netsuite_id AND line.line_stage = 'outbound'
        WHERE transfer.tranid = ANY($1::text[])
        GROUP BY transfer.netsuite_id`,
      [transferRefs]
    );
    refs.push(...transfers.rows.filter((row) => (
      text(row.preparing_operator_id)
      || row.preparing_started_at
      || activeWorkStatus(row.outbound_operator_status)
      || activeWorkStatus(row.local_yard_order_status)
      || row.line_started === true
    )).map((row) => text(row.ref)));
  }
  return [...new Set(refs.filter(Boolean))];
}

async function receivingActivityRefs({ purchaseRefs = [], transferRefs = [] } = {}) {
  const refs = [];
  if (purchaseRefs.length) {
    const purchase = await query(
      `SELECT purchase.tranid AS ref
         FROM purchase_orders purchase
         LEFT JOIN purchase_order_lines line ON line.purchase_order_id = purchase.netsuite_id
        WHERE purchase.tranid = ANY($1::text[])
        GROUP BY purchase.netsuite_id
       HAVING bool_or(
         line.confirmed_at IS NOT NULL
         OR COALESCE(line.received_pallet_qty, 0) > 0
         OR COALESCE(line.received_layer_qty, 0) > 0
         OR COALESCE(line.received_section_qty, 0) > 0
         OR COALESCE(line.received_piece_qty, 0) > 0
         OR COALESCE(line.received_sales_qty, 0) > 0
         OR COALESCE(line.netsuite_received_qty, 0) > COALESCE(line.netsuite_received_baseline_qty, 0)
       )`,
      [purchaseRefs]
    );
    refs.push(...purchase.rows.map((row) => text(row.ref)));
  }
  if (transferRefs.length) {
    const transfer = await query(
      `SELECT transfer.tranid AS ref
         FROM transfer_orders transfer
         LEFT JOIN transfer_order_lines line
           ON line.transfer_order_id = transfer.netsuite_id AND line.line_stage = 'receiving'
        WHERE transfer.tranid = ANY($1::text[])
        GROUP BY transfer.netsuite_id
       HAVING bool_or(
         line.confirmed_at IS NOT NULL
         OR COALESCE(line.received_pallet_qty, 0) > 0
         OR COALESCE(line.received_layer_qty, 0) > 0
         OR COALESCE(line.received_section_qty, 0) > 0
         OR COALESCE(line.received_piece_qty, 0) > 0
         OR COALESCE(line.received_sales_qty, 0) > 0
         OR COALESCE(line.netsuite_received_qty, 0) > 0
       )`,
      [transferRefs]
    );
    refs.push(...transfer.rows.map((row) => text(row.ref)));
  }
  return [...new Set(refs.filter(Boolean))];
}

async function dependencyExecutionIds({ dependencyIds = [], transferRefs = [] } = {}) {
  if (!dependencyIds.length && !transferRefs.length) {return [];}
  const result = await query(
    `SELECT DISTINCT dependency.id
       FROM order_dependencies dependency
       LEFT JOIN order_dependency_lines line ON line.dependency_id = dependency.id
      WHERE (
          dependency.id = ANY($1::bigint[])
          OR dependency.transfer_order_ref = ANY($2::text[])
        )
        AND (
          dependency.status NOT IN ('active', 'attention', 'cancelled')
          OR COALESCE(line.loaded_quantity, 0) > 0
          OR COALESCE(line.delivered_quantity, 0) > 0
          OR COALESCE(line.locally_received_quantity, 0) > 0
        )`,
    [dependencyIds, transferRefs]
  );
  return result.rows.map((row) => Number(row.id));
}

async function driverActivity({ refs = [] } = {}) {
  if (!refs.length) {return [];}
  const result = await query(
    `SELECT record.*, snapshot.orders AS snapshot_orders, snapshot.trucks AS snapshot_trucks
       FROM driver_job_records record
       LEFT JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = record.plan_id
      WHERE order_refs ?| $1::text[]
        AND (
          started_at IS NOT NULL
          OR completed_at IS NOT NULL
          OR lower(COALESCE(status, '')) IN ('in_progress', 'in-progress', 'started', 'complete', 'completed')
        )
      ORDER BY record.id`,
    [refs]
  );
  if (!result.rowCount) {return [];}
  const corrections = await query(`SELECT correction.co_ref, correction.proof, co.status, co.from_location,
    ${completedCoArrivalSql()} AS completion_at
    FROM dispatch_driver_co_identity_corrections correction JOIN local_co_orders co ON co.co_ref=correction.co_ref
    WHERE correction.proof->>'planId'=ANY($1::text[])`,
  [[...new Set(result.rows.map(row => String(row.plan_id)))]]);
  return result.rows.filter(row => driverActivityOrderRefs(row, corrections.rows).some(ref => refs.includes(ref)))
    .map(row => row.job_id || String(row.id));
}

async function offlineEvidence({ planId = null } = {}) {
  if (!planId) {return [];}
  const result = await query(
    `SELECT DISTINCT event.event_id
       FROM driver_offline_events event
       JOIN driver_offline_manifests manifest ON manifest.manifest_id = event.manifest_id
       LEFT JOIN driver_offline_event_photos photo ON photo.event_record_id = event.id
      WHERE manifest.plan_id = $1
        AND (
          event.status NOT IN ('applied', 'evidence_only', 'rejected')
          OR (photo.id IS NOT NULL AND photo.status <> 'durably_received')
        )
      ORDER BY event.event_id`,
    [planId]
  );
  return result.rows.map((row) => row.event_id);
}

async function activeForeignLease(planDate, actor = {}) {
  if (!text(planDate)) {return null;}
  const result = await query(
    `SELECT operator_id, operator_name, session_id, expires_at
       FROM dispatch_plan_edit_leases
      WHERE plan_date = $1::date AND expires_at > now()
        AND ($2 = '' OR session_id <> $2)
      LIMIT 1`,
    [planDate, text(actor.sessionId)]
  );
  const row = result.rows[0];
  return row ? {
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    sessionId: row.session_id,
    expiresAt: row.expires_at
  } : null;
}

export async function previewScmDependencyMutation(command = {}, actor = {}, { lock = false } = {}) {
  if (lock) {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    if (actor.editLease) {await lockDispatchPlanEditLease(actor.editLease);}
    else if (command.planDate) {await lockDispatchPlanEditLeaseDate(command.planDate);}
  }
  const relation = await relationshipContext(command);
  const action = text(command.action);
  const payload = command.payload || {};
  const targetRef = text(
    command.targetRef
    || relation.dependency?.dispatch_target_ref
    || relation.dependency?.sales_order_ref
    || relation.poAllocation?.dispatch_target_ref
    || relation.poAllocation?.sales_order_ref
  );
  if (!targetRef) {throw statusError(400, "DISPATCH_TARGET_REQUIRED", "A Dispatch Sales Order target is required.");}
  if (lock) {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`scm-dependency:${targetRef.toLowerCase()}`]);
  }

  let resolved = null;
  try {
    resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: targetRef, planDate: command.planDate || "" });
  } catch (error) {
    if (["unlink_to", "unlink_po"].includes(action)) {
      resolved = {
        target: {
          ref: targetRef,
          kind: "historical",
          planId: relation.dependency?.planned_plan_id || null,
          planDate: relation.dependency?.planned_date || command.planDate || "",
          memberRefs: [relation.dependency?.sales_order_ref || relation.poAllocation?.sales_order_ref].filter(Boolean)
        },
        signature: "",
        lines: []
      };
    } else {
      throw error;
    }
  }

  const requestedTransferRef = text(payload.transferOrderRef || relation.dependency?.transfer_order_ref);
  const transferRef = requestedTransferRef
    ? (await query("SELECT tranid FROM transfer_orders WHERE UPPER(tranid) = $1", [requestedTransferRef.toUpperCase()])).rows[0]?.tranid || requestedTransferRef
    : "";
  const purchaseRef = text(payload.poRef || relation.poAllocation?.po_order_ref);
  const dependencyIds = [relation.dependency?.id, payload.dependencyId]
    .map(Number).filter(Number.isInteger);
  let existingDependency = null;
  if (action === "link_to" && transferRef) {
    const existing = await query(
      `SELECT id, dispatch_target_ref, dependency_mode
         FROM order_dependencies
        WHERE transfer_order_ref = $1 AND status <> 'cancelled'
        ORDER BY id LIMIT 1`,
      [transferRef]
    );
    if (existing.rowCount) {existingDependency = {
      id: Number(existing.rows[0].id),
      targetRef: existing.rows[0].dispatch_target_ref,
      mode: existing.rows[0].dependency_mode
    };}
  }
  let normalizedAction = { action, effectiveAction: action };
  let relationshipBlocker = null;
  try {
    normalizedAction = normalizeDependencyMutationAction({
      action,
      targetRef: resolved.target.ref,
      mode: payload.mode || command.mode,
      existing: existingDependency
    });
  } catch (error) {
    relationshipBlocker = {
      code: error.code || "DEPENDENCY_MUTATION_BLOCKED",
      message: error.message,
      details: error.details || {}
    };
  }

  // Dispatch sends the open board's plan id with every dependency command, even
  // when the target is only in that board's unassigned order pool. A relationship
  // changes a Driver route only when the resolved target is actually assigned to
  // that route (or an existing relationship retains a historical planned plan).
  const planId = Number(resolved.target.planId || relation.dependency?.planned_plan_id) || null;
  if (lock && !actor.editLease && !command.planDate && resolved.target.planDate) {await lockDispatchPlanEditLeaseDate(resolved.target.planDate);}
  if (lock && planId) {await query("SELECT id FROM dispatch_plans WHERE id = $1 FOR UPDATE", [planId]);}
  const plan = planId ? await getDispatchPlan(planId) : null;
  if (lock && actor.editLease && plan && text(actor.editLease.planDate).slice(0, 10) !== plan.planDate) {
    throw statusError(409, 'DISPATCH_PLAN_EDIT_LEASE_REQUIRED', 'Enter Edit Mode on the affected plan date before changing its dependency.');
  }
  if (lock && actor.editLease && plan && (command.expectedPlanRevision === null
    || command.expectedPlanRevision === undefined || command.expectedPlanRevision === ''
    || !Number.isFinite(Number(command.expectedPlanRevision)) || !text(command.expectedPlanDigest))) {
    throw statusError(409, 'DISPATCH_PLAN_FENCE_REQUIRED', 'Refresh the affected plan before changing its dependency.');
  }
  const salesLineIds = selectedSalesLineIds(action, payload.allocations, resolved.lines);
  const memberRefs = [...new Set([
    resolved.target.ref,
    ...(salesLineIds ? resolved.lines.map((line) => line.sourceOrderRef) : []),
    ...(resolved.target.memberRefs || []),
    relation.dependency?.sales_order_ref,
    relation.poAllocation?.sales_order_ref
  ].map(text).filter(Boolean))];
  const transferRefs = transferRef ? [transferRef] : [];
  const purchaseRefs = purchaseRef ? [purchaseRef] : [];
  const affectedRefs = [...new Set([...memberRefs, ...transferRefs, ...purchaseRefs])];
  // Unlink is metadata removal, not a rewind of the completed transfer. Keep
  // every target/lease/revision/offline guard; exempt only that finished TO.
  const completedUnlink = action === "unlink_to"
    && await completedOrderDependencyUnlinkAllowed(relation.dependency.id);
  const guardedTransferRefs = completedUnlink ? [] : transferRefs;
  const guardedRefs = [...new Set([...memberRefs, ...guardedTransferRefs, ...purchaseRefs])];
  // Preview often runs under the command transaction's row/advisory locks.
  // Keep these reads sequential because pg clients do not support concurrent
  // queries on the same transaction connection.
  if (lock && salesLineIds) {await lockDependencyOperatorOrders(memberRefs, guardedTransferRefs);}
  const closed = await closedOrderRefs(guardedRefs);
  const operatorRefs = await operatorActivityRefs({ salesRefs: memberRefs, transferRefs: guardedTransferRefs, salesLineIds,
    allowReceivedCo: action === "link_to" && Boolean(salesLineIds?.length) });
  const receivingRefs = await receivingActivityRefs({ purchaseRefs, transferRefs: guardedTransferRefs });
  const executionIds = completedUnlink ? [] : await dependencyExecutionIds({ dependencyIds, transferRefs });
  const jobIds = await driverActivity({ refs: guardedRefs });
  const evidenceIds = await offlineEvidence({ planId });
  const lease = await activeForeignLease(
    plan?.planDate || command.planDate || resolved.target.planDate,
    actor
  );

  const targetChanged = Boolean(command.targetSignature && command.targetSignature !== resolved.signature);
  const planChanged = Boolean(plan && (
    (command.expectedPlanRevision !== null && command.expectedPlanRevision !== undefined
      && number(command.expectedPlanRevision) !== number(plan.revision))
    || (text(command.expectedPlanDigest) && text(command.expectedPlanDigest) !== text(plan.digest))
  ));
  const baseBlockers = evaluateDependencyMutationBlockers({
    closedOrders: closed,
    targetChanged,
    targetSignature: resolved.signature,
    planChanged,
    expectedPlanRevision: command.expectedPlanRevision,
    actualPlanRevision: plan?.revision,
    editLease: lease,
    operatorActivity: operatorRefs.length ? { refs: operatorRefs } : null,
    receivingActivity: receivingRefs.length ? { refs: receivingRefs } : null,
    dependencyExecution: executionIds.length ? { dependencyIds: executionIds } : null,
    driverActivity: jobIds.length ? { jobIds } : null,
    offlineEvidence: evidenceIds.length ? { eventIds: evidenceIds } : null,
    planTerminal: ["completed", "cancelled"].includes(text(plan?.status).toLowerCase()) ? plan.status : ""
  });

  // Dependency changes that do not touch an actually started Driver job must
  // not wait for a PWA screen/heartbeat. A started affected job is already a
  // hard blocker above. On an allowed confirmed-plan commit, the command
  // transaction still supersedes every old manifest and grant, so a stale
  // offline event is retained for review and cannot mutate the revised route.
  const devices = [];
  const readiness = { required: false, ready: true, blockers: [] };
  const blockers = [
    ...(relationshipBlocker ? [relationshipBlocker] : []),
    ...baseBlockers,
    ...readiness.blockers
  ];
  return {
    allowed: blockers.length === 0,
    action,
    effectiveAction: normalizedAction.effectiveAction,
    blockers,
    target: resolved.target,
    targetSignature: resolved.signature,
    lines: resolved.lines,
    relationship: relation,
    affectedOrderRefs: affectedRefs,
    affectedPlan: plan,
    affectedDriverDevices: devices,
    routeReadiness: readiness
  };
}
