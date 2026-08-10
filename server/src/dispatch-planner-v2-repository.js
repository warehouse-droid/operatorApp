import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";
import { syncDispatchDeliveryGroupsFromPlan } from "./dispatch-delivery-group-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { assertNoDriverPwaCompletedDispatchRefs } from "./dispatch-history-mode.js";
import {
  applyDispatchPlanCommand,
  buildCompactDispatchSnapshot,
  clearCancelledTransitCoMetadata,
  createDispatchCommandReceiptStore,
  digestDispatchPlan,
  dispatchPlanBoard,
  evaluateExecutedPrefixPolicy
} from "./dispatch-planner-performance.js";

const SNAPSHOT_SCHEMA_VERSION = 2;

function text(value) {
  return String(value ?? "").trim();
}

function planDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {return value.toISOString().slice(0, 10);}
  return text(value).slice(0, 10);
}

function stableValue(value) {
  if (Array.isArray(value)) {return value.map(stableValue);}
  if (!value || typeof value !== "object") {return value;}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, candidate]) => candidate !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidate]) => [key, stableValue(candidate)])
  );
}

function requestHash(command = {}) {
  const submittedHash = text(command.sourceRequestHash).toLowerCase();
  if (/^[a-f0-9]{64}$/u.test(submittedHash)) {return submittedHash;}
  return crypto.createHash("sha256").update(JSON.stringify(stableValue({
    commandId: text(command.commandId),
    baseRevision: Number(command.baseRevision),
    baseDigest: text(command.baseDigest),
    commandType: text(command.commandType || command.type),
    payload: command.payload || {}
  }))).digest("hex");
}

function commandError(message, code, status = 409, details = {}) {
  return Object.assign(new Error(message), { code, status, ...details });
}

function rowPlan(row = {}) {
  return {
    id: text(row.id || row.plan_id),
    planId: text(row.id || row.plan_id),
    planDate: planDate(row.plan_date),
    status: row.status || "draft",
    note: row.note || "",
    revision: Number(row.revision || 0),
    savedAt: row.saved_at || row.updated_at || null,
    orders: Array.isArray(row.orders) ? row.orders : [],
    trucks: Array.isArray(row.trucks) ? row.trucks : [],
    summary: row.summary && typeof row.summary === "object" ? row.summary : {}
  };
}

function slimAssignedOrder(order = {}) {
  const keys = [
    "id", "orderId", "orderRef", "tranid", "refNumber", "type", "status", "statusText",
    "customOrderId", "customOrder", "localDispatchStatus",
    "customer", "customerName", "address", "pickupAddress", "pickupAddressOverride",
    "sourceAddress", "defaultSourceAddress", "dropoffLocation", "pickupLocation",
    "pickupLocations", "sourceYard", "destinationYard", "destinationAddress", "destinationLocationId",
    "expectedDeliveryDate", "windowStart", "windowEnd", "items", "pallets", "layers",
    "salesQty", "salesQuantities", "committedQty", "packed", "weight", "totalWeightLbs",
    "unloadMinutes", "travelMinutes", "stopMinutes", "instructions", "notes",
    "originalOrderId", "sourceOrderId", "relatedSoId", "originalPoRef", "childOrders",
    "childOrderDetails", "groupAliases", "transitCo", "transitOriginalPickupLocations",
    "transitOriginalSourceYard", "poPickupManifest", "orderDependencies", "dependencyLabels",
    "dependencyDirectPickup", "dependencyWaitingForTransfer", "dependencyAttention",
    "dependencyUncovered", "dependencyUncoveredQuantity", "planOwned", "isSplit", "isGrouped",
    "groupPlanId", "groupPlanDate",
    "sourceTable", "netsuiteId", "dispatchRef", "dependency", "dependencies", "mbt",
    "historicalReconciliationComplete", "historicalPlanDate"
  ];
  const slim = Object.fromEntries(keys.filter((key) => order[key] !== undefined).map((key) => [key, order[key]]));
  const identity = text(slim.id);
  for (const duplicateKey of ["orderId", "orderRef", "tranid", "refNumber"]) {
    if (identity && text(slim[duplicateKey]) === identity) {delete slim[duplicateKey];}
  }
  return slim;
}

function publicPlan(plan = {}) {
  const compact = buildCompactDispatchSnapshot(plan);
  const digest = digestDispatchPlan(plan);
  return {
    exists: true,
    id: text(plan.id || plan.planId),
    planId: text(plan.id || plan.planId),
    planDate: planDate(plan.planDate),
    status: plan.status || "draft",
    note: plan.note || "",
    revision: Number(plan.revision || 0),
    savedAt: plan.savedAt || null,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    digest,
    summary: compact.summary || {},
    trucks: compact.trucks || [],
    assignedOrderSnapshots: (compact.orders || []).map(slimAssignedOrder),
    board: dispatchPlanBoard(compact)
  };
}

function planTransitCoRefs(orders = []) {
  const refs = new Set();
  const visit = (order = {}) => {
    const ref = text(order.transitCo?.id);
    if (ref) {refs.add(ref);}
    for (const child of Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []) {
      visit(child);
    }
  };
  for (const order of orders || []) {visit(order);}
  return [...refs];
}

async function reconcileCancelledLocalCos(plan) {
  if (!plan) {return null;}
  const refs = planTransitCoRefs(plan.orders);
  if (!refs.length) {return plan;}
  const cancelled = await query(
    `SELECT co_ref, from_location, to_location
       FROM local_co_orders
      WHERE status = 'cancelled'
        AND co_ref = ANY($1::text[])`,
    [refs]
  );
  if (!cancelled.rows.length) {return plan;}
  const byRef = new Map(cancelled.rows.map((row) => [
    text(row.co_ref).toLowerCase(),
    { fromYard: text(row.from_location), toYard: text(row.to_location) }
  ]));
  const orders = (plan.orders || []).map((order) => clearCancelledTransitCoMetadata(order, byRef));
  return orders.some((order, index) => order !== plan.orders[index]) ? { ...plan, orders } : plan;
}

async function selectPlan({ planId = "", date = "", lock = false } = {}) {
  const cleanId = text(planId);
  const cleanDate = planDate(date);
  const params = [];
  const clauses = [];
  if (cleanId) {
    params.push(cleanId);
    clauses.push(`p.id = $${params.length}`);
  }
  if (cleanDate) {
    params.push(cleanDate);
    clauses.push(`p.plan_date = $${params.length}::date`);
  }
  if (!clauses.length) {throw commandError("A plan ID or plan date is required.", "DISPATCH_PLAN_SELECTOR_REQUIRED", 400);}
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.note, p.revision,
            p.created_at, p.updated_at, s.saved_at, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE ${clauses.join(" AND ")}
      LIMIT 1
      ${lock ? "FOR UPDATE OF p" : ""}`,
    params
  );
  return result.rows[0] ? reconcileCancelledLocalCos(rowPlan(result.rows[0])) : null;
}

export async function getDispatchV2Bootstrap({ planId = "", date = "" } = {}) {
  const plan = await selectPlan({ planId, date });
  if (!plan) {
    return {
      exists: false,
      plan: {
        exists: false,
        id: null,
        planId: null,
        planDate: planDate(date),
        revision: 0,
        digest: "",
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        trucks: [],
        assignedOrderSnapshots: [],
        board: { orderRefs: [], truckCount: 0, loadCount: 0, stopCount: 0 }
      }
    };
  }
  return { exists: true, plan: publicPlan(plan) };
}

async function existingReceipt(commandId, hash) {
  const result = await query(
    `SELECT command_id, request_hash, result
       FROM dispatch_plan_commands
      WHERE command_id = $1
      LIMIT 1`,
    [commandId]
  );
  const row = result.rows[0];
  if (!row) {return null;}
  if (row.request_hash !== hash) {
    throw commandError(
      "This command ID was already used for a different change.",
      "DISPATCH_COMMAND_ID_REUSED",
      409
    );
  }
  return row.result;
}

export async function getDispatchV2CommandReplay({ command = {} } = {}) {
  const commandId = text(command.commandId);
  if (!commandId) {return null;}
  const payload = await existingReceipt(commandId, requestHash(command));
  return payload ? { payload, replay: true } : null;
}

function plannedRows(plan = {}) {
  const rows = [];
  const seen = new Set();
  for (const truck of plan.trucks || []) {
    for (const load of truck?.loads || []) {
      for (const stop of load?.stops || []) {
        const refs = [...new Set([
          stop.orderId,
          stop.order_id,
          stop.orderRef,
          ...(Array.isArray(stop.orderRefs) ? stop.orderRefs : [])
        ].map(text).filter(Boolean))];
        for (const ref of refs) {
          const key = ref.toLowerCase();
          if (seen.has(key)) {continue;}
          seen.add(key);
          rows.push({ orderRef: ref, loadId: text(load.id), stopId: text(stop.id) });
        }
      }
    }
  }
  return rows;
}

async function syncOrderAssignments(plan = {}) {
  const rows = plannedRows(plan);
  await query("DELETE FROM dispatch_plan_order_assignments WHERE plan_id = $1", [plan.id]);
  if (!rows.length) {return;}
  await query(
    `INSERT INTO dispatch_plan_order_assignments (
       plan_id, plan_date, order_ref, load_id, stop_id, updated_at
     )
     SELECT $1, $2::date, source.order_ref, source.load_id, source.stop_id, now()
       FROM jsonb_to_recordset($3::jsonb) AS source(order_ref text, load_id text, stop_id text)
     ON CONFLICT (plan_id, order_ref) DO UPDATE
       SET plan_date = EXCLUDED.plan_date,
           load_id = EXCLUDED.load_id,
           stop_id = EXCLUDED.stop_id,
           updated_at = now()`,
    [plan.id, plan.planDate, JSON.stringify(rows.map((row) => ({
      order_ref: row.orderRef,
      load_id: row.loadId,
      stop_id: row.stopId
    })))]
  );
}

async function otherDateAssignment(plan, orderReference) {
  const materialized = await query(
    `SELECT assignment.plan_id::text AS plan_id, assignment.plan_date::text AS plan_date,
            assignment.load_id, assignment.stop_id
       FROM dispatch_plan_order_assignments assignment
       JOIN dispatch_plans p ON p.id = assignment.plan_id
      WHERE assignment.plan_id <> $1
        AND p.status <> 'cancelled'
        AND lower(assignment.order_ref) = lower($2)
      ORDER BY assignment.plan_date DESC
      LIMIT 1`,
    [plan.id, orderReference]
  );
  if (materialized.rows[0]) {return materialized.rows[0];}
  const fallback = await query(
    `SELECT p.id::text AS plan_id, p.plan_date::text AS plan_date
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id <> $1
        AND p.status <> 'cancelled'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(COALESCE(s.trucks, '[]'::jsonb)) truck(value)
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value -> 'loads', '[]'::jsonb)) load(value)
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value -> 'stops', '[]'::jsonb)) stop(value)
           WHERE lower(COALESCE(stop.value ->> 'orderId', stop.value ->> 'order_id', stop.value ->> 'orderRef', '')) = lower($2)
              OR EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(stop.value -> 'orderRefs') = 'array'
                      THEN stop.value -> 'orderRefs' ELSE '[]'::jsonb END
                  ) ref(value)
                 WHERE lower(ref.value) = lower($2)
              )
        )
      ORDER BY p.plan_date DESC
      LIMIT 1`,
    [plan.id, orderReference]
  );
  return fallback.rows[0] || null;
}

async function assertAssignmentDateAvailable(plan, command) {
  const commandType = text(command.commandType || command.type);
  let refs = [];
  if (commandType === "assign_order") {
    refs = [text(command.payload?.orderRef)].filter(Boolean);
  } else if (commandType === "replace_plan") {
    const previousRefs = new Set(dispatchPlanBoard(plan).orderRefs.map((ref) => text(ref).toLowerCase()));
    refs = dispatchPlanBoard({ trucks: command.payload?.trucks || [] }).orderRefs
      .map(text)
      .filter((ref) => ref && !previousRefs.has(ref.toLowerCase()));
  }
  const uniqueRefs = [...new Set(refs)];
  await assertNoDriverPwaCompletedDispatchRefs(uniqueRefs, "add these orders to Dispatch");
  for (const ref of uniqueRefs) {
    const conflict = await otherDateAssignment(plan, ref);
    if (!conflict) {continue;}
    throw commandError(`${ref} is already planned on ${planDate(conflict.plan_date)}.`, "DISPATCH_ORDER_ALREADY_PLANNED", 409, {
      conflicts: [{ orderRef: ref, planId: text(conflict.plan_id), planDate: planDate(conflict.plan_date) }]
    });
  }
}

async function activityForPlan(planId) {
  const result = await query(
    `SELECT status, load_id, stop_id, stop_type, order_refs
       FROM driver_job_records
      WHERE plan_id = $1
        AND status IN ('in_progress', 'complete')
      ORDER BY id`,
    [planId]
  );
  return result.rows;
}

function snapshotCounts(plan = {}) {
  const board = dispatchPlanBoard(plan);
  return {
    orderCount: (plan.orders || []).length,
    truckCount: board.truckCount,
    loadCount: board.loadCount,
    stopCount: board.stopCount
  };
}

export async function applyDispatchV2Command({ planId, command = {}, actorId = null } = {}) {
  const commandId = text(command.commandId);
  const commandType = text(command.commandType || command.type);
  if (!commandId || !commandType || !Number.isFinite(Number(command.baseRevision))) {
    throw commandError("commandId, commandType, and baseRevision are required.", "DISPATCH_COMMAND_INVALID", 400);
  }
  const hash = requestHash({ ...command, commandType });
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const plan = await selectPlan({ planId, lock: true });
    if (!plan) {throw commandError("Dispatch plan not found.", "DISPATCH_PLAN_NOT_FOUND", 404);}
    const replay = await existingReceipt(commandId, hash);
    if (replay) {return { payload: replay, replay: true };}
    await assertAssignmentDateAvailable(plan, { ...command, commandType });
    const result = applyDispatchPlanCommand({
      plan,
      command: { ...command, type: commandType },
      receiptStore: createDispatchCommandReceiptStore()
    });
    const policy = evaluateExecutedPrefixPolicy({
      previousPlan: plan,
      nextPlan: result.plan,
      activity: await activityForPlan(plan.id)
    });
    if (!policy.allowed) {
      throw commandError(policy.conflicts[0].message, policy.conflicts[0].code, 409, { conflicts: policy.conflicts });
    }
    if (plan.savedAt) {
      const previousCounts = snapshotCounts(plan);
      await query(
        `INSERT INTO dispatch_plan_snapshot_history (
           plan_id, plan_date, revision, orders, trucks, summary,
           original_saved_at, archive_reason, session_id,
           schema_version, plan_digest, order_count, truck_count, load_count, stop_count
         ) VALUES (
           $1, $2::date, $3, $4::jsonb, $5::jsonb, $6::jsonb,
           $7, 'before_incremental_command', $8,
           $9, $10, $11, $12, $13, $14
         )`,
        [
          plan.id,
          plan.planDate,
          plan.revision,
          JSON.stringify(plan.orders || []),
          JSON.stringify(plan.trucks || []),
          JSON.stringify(plan.summary || {}),
          plan.savedAt,
          text(command.sessionId),
          SNAPSHOT_SCHEMA_VERSION,
          digestDispatchPlan(plan),
          previousCounts.orderCount,
          previousCounts.truckCount,
          previousCounts.loadCount,
          previousCounts.stopCount
        ]
      );
    }
    const updated = await query(
      `UPDATE dispatch_plans
          SET revision = revision + 1,
              updated_at = now()
        WHERE id = $1
          AND revision = $2
        RETURNING revision, updated_at`,
      [plan.id, Number(command.baseRevision)]
    );
    if (!updated.rows[0]) {
      throw commandError("Dispatch plan changed before this command was applied.", "STALE_DISPATCH_PLAN", 409);
    }
    result.plan.revision = Number(updated.rows[0].revision);
    result.plan.savedAt = updated.rows[0].updated_at;
    const digest = digestDispatchPlan(result.plan);
    const counts = snapshotCounts(result.plan);
    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb,
              trucks = $3::jsonb,
              summary = $4::jsonb,
              saved_at = now(),
              schema_version = $5,
              plan_digest = $6,
              order_count = $7,
              truck_count = $8,
              load_count = $9,
              stop_count = $10
        WHERE plan_id = $1`,
      [
        plan.id,
        JSON.stringify(result.plan.orders || []),
        JSON.stringify(result.plan.trucks || []),
        JSON.stringify(result.plan.summary || {}),
        SNAPSHOT_SCHEMA_VERSION,
        digest,
        counts.orderCount,
        counts.truckCount,
        counts.loadCount,
        counts.stopCount
      ]
    );
    await syncOrderAssignments(result.plan);
    // Operator reads this projection instead of the plan JSON. Keep it in the
    // command transaction so a refresh cannot resurrect a just-ungrouped order.
    await syncDispatchDeliveryGroupsFromPlan(result.plan);
    const payload = {
      plan: publicPlan(result.plan),
      patch: result.patch,
      acknowledgement: { ...result.acknowledgement, revision: result.plan.revision, digest }
    };
    await query(
      `INSERT INTO dispatch_plan_commands (
         command_id, plan_id, plan_date, command_type, request_hash,
         base_revision, applied_revision, session_id, actor_id, result
       ) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        commandId,
        plan.id,
        plan.planDate,
        commandType,
        hash,
        Number(command.baseRevision),
        result.plan.revision,
        text(command.sessionId),
        actorId || null,
        JSON.stringify(payload)
      ]
    );
    await query(
      `INSERT INTO dispatch_plan_followup_outbox (command_id, plan_id, command_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (command_id) DO NOTHING`,
      [commandId, plan.id, commandType]
    );
    return { payload, replay: false };
  });
}

export async function listDispatchV2Checkpoints({ planId, date = "" } = {}) {
  const params = [planId];
  const dateClause = date ? "AND h.plan_date = $2::date" : "";
  if (date) {params.push(planDate(date));}
  const result = await query(
    `SELECT h.id::text AS id, h.plan_id::text AS plan_id, h.plan_date::text AS plan_date,
            h.revision::int AS revision, h.original_saved_at, h.archived_at,
            h.archive_reason, h.session_id, h.schema_version, h.plan_digest,
            h.order_count, h.truck_count, h.load_count, h.stop_count
       FROM dispatch_plan_snapshot_history h
      WHERE h.plan_id = $1
        ${dateClause}
      ORDER BY h.archived_at DESC, h.id DESC
      LIMIT 200`,
    params
  );
  return result.rows.map((row) => ({
    id: row.id,
    planId: row.plan_id,
    planDate: planDate(row.plan_date),
    revision: Number(row.revision || 0),
    originalSavedAt: row.original_saved_at,
    archivedAt: row.archived_at,
    archiveReason: row.archive_reason || "",
    sessionId: row.session_id || "",
    schemaVersion: Number(row.schema_version || 1),
    digest: row.plan_digest || "",
    orderCount: Number(row.order_count || 0),
    truckCount: Number(row.truck_count || 0),
    loadCount: Number(row.load_count || 0),
    stopCount: Number(row.stop_count || 0)
  }));
}

export async function getDispatchV2Checkpoint({ planId, checkpointId } = {}) {
  const result = await query(
    `SELECT h.id, h.plan_id, h.plan_date::text AS plan_date, h.revision,
            h.orders, h.trucks, h.summary, h.original_saved_at, h.archived_at
       FROM dispatch_plan_snapshot_history h
      WHERE h.plan_id = $1
        AND h.id = $2
      LIMIT 1`,
    [planId, checkpointId]
  );
  if (!result.rows[0]) {return null;}
  return publicPlan(rowPlan({ ...result.rows[0], id: result.rows[0].plan_id }));
}

export async function pruneExpiredDispatchV2Checkpoints({ retentionDays = 7, batchSize = 500 } = {}) {
  const days = Math.min(Math.max(Number(retentionDays) || 7, 1), 90);
  const safeBatchSize = Math.min(Math.max(Number(batchSize) || 500, 1), 1000);
  const result = await query(
    `WITH expired AS (
       SELECT id
         FROM dispatch_plan_snapshot_history
        WHERE archived_at < now() - ($1::text || ' days')::interval
          AND archive_reason <> 'save_recovery'
        ORDER BY archived_at, id
        LIMIT $2
     )
     DELETE FROM dispatch_plan_snapshot_history history
      USING expired
      WHERE history.id = expired.id
      RETURNING history.id`,
    [days, safeBatchSize]
  );
  return { deleted: result.rowCount, checkpointIds: result.rows.map((row) => text(row.id)) };
}

export async function pendingDispatchV2Followups({ limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const result = await query(
    `WITH candidates AS (
       SELECT outbox.id
         FROM dispatch_plan_followup_outbox outbox
        WHERE (
          (outbox.status IN ('pending', 'failed') AND outbox.available_at <= now())
          OR (outbox.status = 'running' AND outbox.updated_at < now() - interval '10 minutes')
        )
        ORDER BY outbox.id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     ), claimed AS (
       UPDATE dispatch_plan_followup_outbox outbox
          SET status = 'running', updated_at = now()
         FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.*
     )
     SELECT claimed.id, claimed.command_id, claimed.plan_id, claimed.command_type,
            claimed.attempts, claimed.progress, command.result
       FROM claimed
       JOIN dispatch_plan_commands command ON command.command_id = claimed.command_id
      ORDER BY claimed.id`,
    [safeLimit]
  );
  return result.rows;
}

export async function advanceDispatchV2Followup(id, stage) {
  const allowedStages = new Set([
    "order_dependencies",
    "co_assignments",
    "scm_schedule",
    "delivery_materialization"
  ]);
  const cleanStage = text(stage);
  if (!allowedStages.has(cleanStage)) {
    throw commandError("Unsupported Dispatch follow-up stage.", "DISPATCH_FOLLOWUP_STAGE_INVALID", 400);
  }
  const result = await query(
    `UPDATE dispatch_plan_followup_outbox
        SET progress = jsonb_set(
              COALESCE(progress, '{}'::jsonb),
              ARRAY[$2]::text[],
              jsonb_build_object('completedAt', now()),
              true
            ),
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING progress`,
    [id, cleanStage]
  );
  if (!result.rows[0]) {
    throw commandError("The Dispatch follow-up is no longer owned by this worker.", "DISPATCH_FOLLOWUP_NOT_RUNNING", 409);
  }
  return result.rows[0].progress || {};
}

export async function completeDispatchV2Followup(id) {
  await query(
    `UPDATE dispatch_plan_followup_outbox
        SET status = 'complete', completed_at = now(), updated_at = now()
      WHERE id = $1
        AND status = 'running'`,
    [id]
  );
}

export async function failDispatchV2Followup(id, error) {
  await query(
    `UPDATE dispatch_plan_followup_outbox
        SET status = 'failed', attempts = attempts + 1,
            last_error = $2, available_at = now() + interval '1 minute', updated_at = now()
      WHERE id = $1
        AND status = 'running'`,
    [id, text(error?.message || error).slice(0, 2000)]
  );
}
