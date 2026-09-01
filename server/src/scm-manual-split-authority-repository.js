import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";

const MANUAL_SPLIT_INITIAL_STATUS = "Hold";
const REPAIR_REPLACEMENT_STATUSES = new Set(["Hold", "Planned"]);

function text(value) {
  return String(value ?? "").trim();
}

function repairError(message, code) {
  return Object.assign(new Error(message), { status: 409, code });
}

function normalizedCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : null;
}

function normalizedTargetRefs(value) {
  const rawRefs = Array.isArray(value)
    ? value
    : (text(value) ? text(value).split(",") : []);
  const refs = rawRefs.map(text);
  if (refs.some((ref) => !ref)) {
    throw Object.assign(
      new Error("Target child refs must be non-empty exact order references."),
      { status: 400, code: "SCM_MANUAL_SPLIT_REPAIR_TARGET_INPUT_INVALID" }
    );
  }
  const keys = refs.map((ref) => ref.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    throw Object.assign(
      new Error("Target child refs must be unique."),
      { status: 400, code: "SCM_MANUAL_SPLIT_REPAIR_TARGET_INPUT_INVALID" }
    );
  }
  return refs;
}

function beforeState(row) {
  return {
    initialScmStatus: text(row.initial_scm_status),
    status: text(row.schedule_status),
    dropoffPoint: text(row.schedule_dropoff),
    reconciliationBlocked: row.reconciliation_blocked === true
  };
}

export async function repairScmManualSplitFamilyAuthority({
  sourcePoRef = "",
  expectedActiveChildren = null,
  childRefs = [],
  expectedCurrentStatus = "",
  replacementStatus = MANUAL_SPLIT_INITIAL_STATUS,
  actor = "",
  dryRun = true
} = {}) {
  const sourceRef = text(sourcePoRef);
  const cleanActor = text(actor);
  const expectedCount = normalizedCount(expectedActiveChildren);
  const requestedChildRefs = normalizedTargetRefs(childRefs);
  const expectedStatus = text(expectedCurrentStatus);
  const cleanReplacementStatus = text(replacementStatus) || MANUAL_SPLIT_INITIAL_STATUS;
  if (!REPAIR_REPLACEMENT_STATUSES.has(cleanReplacementStatus)) {
    throw Object.assign(
      new Error("Replacement status must be Hold or Planned."),
      { status: 400, code: "SCM_MANUAL_SPLIT_REPAIR_REPLACEMENT_STATUS_INVALID" }
    );
  }
  if (!sourceRef || !cleanActor || expectedCount === null) {
    throw Object.assign(
      new Error("Source PO ref, repair actor, and a positive expected active-child count are required."),
      { status: 400, code: "SCM_MANUAL_SPLIT_REPAIR_INPUT_REQUIRED" }
    );
  }

  return withTransaction(async () => {
    const sourceResult = await query(
      `SELECT netsuite_id, tranid
         FROM purchase_orders
        WHERE netsuite_id > 0
          AND lower(tranid) = lower($1)
        ORDER BY netsuite_active DESC, synced_at DESC NULLS LAST, netsuite_id DESC
        LIMIT 2
        FOR UPDATE`,
      [sourceRef]
    );
    if (sourceResult.rowCount !== 1) {
      throw repairError(
        `Expected one exact source PO ${sourceRef} but found ${sourceResult.rowCount}.`,
        "SCM_MANUAL_SPLIT_REPAIR_SOURCE_MISMATCH"
      );
    }
    const source = sourceResult.rows[0];
    const familyResult = await query(
      `SELECT split.id AS split_id,
              split.split_po_id,
              split.split_po_ref,
              split.details->>'destinationLocationId' AS confirmed_location_id,
              split.details->>'destinationLocation' AS confirmed_location,
              child.initial_scm_status,
              child.destination_location_id::text AS child_location_id,
              child.destination_location AS child_location,
              schedule.id AS schedule_id,
              schedule.status AS schedule_status,
              schedule.dropoff_point AS schedule_dropoff,
              COALESCE(schedule.reconciliation_blocked, false) AS reconciliation_blocked,
              EXISTS (
                SELECT 1
                  FROM dispatch_plan_order_assignments assignment
                  JOIN dispatch_plans plan
                    ON plan.id = assignment.plan_id
                   AND plan.status <> 'cancelled'
                 WHERE lower(assignment.order_ref) = lower(split.split_po_ref)
                    OR lower(NULLIF(assignment.planned_order_ref, '')) = lower(split.split_po_ref)
              ) AS has_active_plan
         FROM dispatch_scm_po_splits split
         JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
         LEFT JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split.split_po_ref)
        WHERE split.source_po_id = $1
          AND split.status = 'active'
        ORDER BY split.created_at, split.id
        FOR UPDATE OF split, child`,
      [source.netsuite_id]
    );
    if (familyResult.rowCount !== expectedCount) {
      throw repairError(
        `Expected ${expectedCount} active split children but found ${familyResult.rowCount}.`,
        "SCM_MANUAL_SPLIT_REPAIR_COUNT_MISMATCH"
      );
    }
    const refs = new Set();
    const rowsByRef = new Map();
    for (const row of familyResult.rows) {
      const orderRef = text(row.split_po_ref);
      const refKey = orderRef.toLowerCase();
      if (!orderRef || refs.has(refKey)) {
        throw repairError(
          `Active split references for ${source.tranid} are missing or duplicated.`,
          "SCM_MANUAL_SPLIT_REPAIR_REF_MISMATCH"
        );
      }
      refs.add(refKey);
      rowsByRef.set(refKey, row);
    }
    const missingRefs = requestedChildRefs.filter((ref) => !rowsByRef.has(ref.toLowerCase()));
    if (missingRefs.length) {
      throw repairError(
        `Requested active split children ${missingRefs.join(", ")} were not found in ${source.tranid}.`,
        "SCM_MANUAL_SPLIT_REPAIR_TARGET_MISMATCH"
      );
    }
    const targetRows = requestedChildRefs.length
      ? requestedChildRefs.map((ref) => rowsByRef.get(ref.toLowerCase()))
      : familyResult.rows;
    for (const row of targetRows) {
      const orderRef = text(row.split_po_ref);
      const confirmedLocationId = text(row.confirmed_location_id);
      const confirmedLocation = text(row.confirmed_location);
      if (
        !confirmedLocationId
        || !confirmedLocation
        || confirmedLocationId !== text(row.child_location_id)
        || confirmedLocation !== text(row.child_location)
      ) {
        throw repairError(
          `Confirmed destination for ${orderRef} does not match its child PO mirror.`,
          "SCM_MANUAL_SPLIT_REPAIR_DESTINATION_MISMATCH"
        );
      }
      if (
        expectedStatus
        && text(row.schedule_status).toLowerCase() !== expectedStatus.toLowerCase()
      ) {
        throw repairError(
          `Active split child ${orderRef} expected current status ${expectedStatus} but found ${text(row.schedule_status) || "missing"}.`,
          "SCM_MANUAL_SPLIT_REPAIR_STATUS_MISMATCH"
        );
      }
      if (cleanReplacementStatus === "Planned" && row.has_active_plan !== true) {
        throw repairError(
          `Active split child ${orderRef} requires an exact active dispatch assignment before Planned can be restored.`,
          "SCM_MANUAL_SPLIT_REPAIR_ACTIVE_PLAN_REQUIRED"
        );
      }
    }

    const changes = [];
    for (const row of targetRows) {
      const orderRef = text(row.split_po_ref);
      const before = beforeState(row);
      const after = {
        initialScmStatus: MANUAL_SPLIT_INITIAL_STATUS,
        status: cleanReplacementStatus,
        dropoffPoint: text(row.confirmed_location),
        reconciliationBlocked: false
      };
      if (
        row.schedule_id
        && before.initialScmStatus === after.initialScmStatus
        && before.status === after.status
        && before.dropoffPoint === after.dropoffPoint
        && before.reconciliationBlocked === after.reconciliationBlocked
      ) {
        continue;
      }
      await query(
        `UPDATE purchase_orders
            SET initial_scm_status = $2
          WHERE netsuite_id = $1`,
        [row.split_po_id, MANUAL_SPLIT_INITIAL_STATUS]
      );
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, order_ref, status, dropoff_point,
           reconciliation_blocked, updated_by, created_by,
           created_at, updated_at
         ) VALUES (
           'PO', $1, $2, $3, false, $4, $4,
           clock_timestamp(), clock_timestamp()
         )
         ON CONFLICT (order_kind, order_ref) DO UPDATE SET
           status = EXCLUDED.status,
           dropoff_point = EXCLUDED.dropoff_point,
           reconciliation_blocked = false,
           updated_by = EXCLUDED.updated_by,
           updated_at = clock_timestamp()`,
        [orderRef, cleanReplacementStatus, after.dropoffPoint, cleanActor]
      );
      await writeDispatchAudit({
        action: "scm.manual_split_authority_repaired",
        entityType: "purchase_order",
        entityId: orderRef,
        orderId: orderRef,
        operatorName: cleanActor,
        source: "manual-split-authority-repair",
        before,
        after,
        details: {
          sourcePoRef: source.tranid,
          sourcePoId: Number(source.netsuite_id),
          splitId: Number(row.split_id),
          repairVersion: 3,
          targetedRepair: requestedChildRefs.length > 0,
          replacementStatus: cleanReplacementStatus
        }
      });
      changes.push({ orderRef, before, after });
    }
    return {
      dryRun: dryRun === true,
      sourcePoRef: source.tranid,
      sourcePoId: Number(source.netsuite_id),
      activeChildCount: familyResult.rowCount,
      targetChildCount: targetRows.length,
      changedCount: changes.length,
      unchangedCount: targetRows.length - changes.length,
      changes
    };
  }, { rollback: dryRun === true });
}
