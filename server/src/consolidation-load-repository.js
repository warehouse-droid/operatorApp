// @ts-check
import crypto from "node:crypto";
import { query, withTransaction, afterTransactionCommit } from "./db.js";
import { getDeliveryOrder, listDeliveryOrders, listVrmaDeliveryPrepOrders, recordDeliveryLoad } from "./delivery-repository.js";
import { dispatchLoadAssignment } from "./dispatch-load-assignment.js";
import { assertOperatorYard, operatorYardLocationIds } from "./operator-yard-access.js";
import { buildConsolidationSnapshot, compareConsolidationOrders, consolidationDate, consolidationError, consolidationPackedLine, consolidationSnapshotHash, originalConsolidationOrders } from "./consolidation-load-domain.js";
import { lockConsolidatedLoadOrders, withConsolidatedLoadContext } from "./consolidation-load-locks.js";
import { syncDirectDependencyOperatorProgress } from "./order-dependency-repository.js";
import { writeAudit } from "./auth-repository.js";
import { enqueuePostingPhotos } from "./operator-netsuite-posting-photo-queue.js";

/** @type {(type: string, payload: Record<string,any>) => void} */
let emitCompletion = (_type, _payload) => {};
/** @param {(type: string, payload: Record<string,any>) => void} emit */
export function configureConsolidationLoadEvents(emit) { emitCompletion = emit; }
/** @param {any} row */
function publicBatch(row) {
  return { id: row.id, operatorId: row.operator_id, locationId: Number(row.location_id), snapshot: /** @type {ReturnType<typeof buildConsolidationSnapshot>} */ (row.snapshot),
    status: row.status, photoRefs: row.photo_refs, photoInputHash: row.photo_input_hash, commandId: row.command_id, result: row.result,
    error: row.last_error || row.posting_error || "", updatedAt: row.updated_at };
}
/** @param {unknown} id */
export function consolidationBatchId(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw consolidationError("Invalid consolidation ID.", "CONSOLIDATION_LOAD_INVALID", 400);
  return id;
}
/** @param {any} operator @param {unknown} id */
export async function getConsolidatedLoad(operator, id, { lock = false } = {}) {
  const row = (await query(`SELECT b.*,c.last_error AS posting_error FROM operator_consolidated_loads b
    LEFT JOIN operator_netsuite_posting_commands c ON c.id=b.command_id WHERE b.id=$1${lock ? " FOR UPDATE OF b" : ""}`, [consolidationBatchId(id)])).rows[0];
  if (!row) throw consolidationError("Consolidation Load not found.", "CONSOLIDATION_LOAD_NOT_FOUND", 404);
  if (String(row.operator_id) !== String(operator.id)) throw consolidationError("This load belongs to another operator.", "OPERATOR_YARD_FORBIDDEN", 403);
  assertOperatorYard(operator, row.location_id);
  const batch = publicBatch(row);
  if (batch.status === 'draft') {
    const orders = await Promise.all(batch.snapshot.orders.map(order => getDeliveryOrder(order.netsuite_id)));
    return { ...batch, confirmationSummaries: orders.filter(Boolean).map(order => order.confirmationSummary) };
  }
  return batch;
}
/** @param {any} operator @param {unknown} locationId */
export async function listPendingConsolidatedLoads(operator, locationId) {
  const yard = assertOperatorYard(operator, locationId);
  return (await query("SELECT * FROM operator_consolidated_loads WHERE operator_id=$1 AND location_id=$2 AND status='pending' ORDER BY created_at", [operator.id, yard])).rows.map(publicBatch);
}
/** @param {any} definition @param {Map<string,any>} definitions @param {Set<string>} [seen] */
function originalRefs(definition, definitions, seen = new Set()) {
  const ref = String(definition?.id || "");
  if (!ref || seen.has(ref)) return [];
  seen.add(ref);
  // CO source children describe cargo, not separate delivery orders.
  if (definition.type === "CO" || !definition.childOrders?.length) return [ref];
  const children = new Map((definition.childOrderDetails || []).map((/** @type {any} */ child) => [String(child.id), child]));
  return [ref, ...definition.childOrders.flatMap((/** @type {any} */ id) => originalRefs(definitions.get(String(id)) || children.get(String(id)) || { id }, definitions, seen))];
}
/** @param {Map<string,any>} assignments @param {string} key @param {any} assignment */
function putAssignment(assignments, key, assignment) {
  const existing = assignments.get(key);
  assignments.set(key, existing && existing.loadId !== assignment.loadId ? { ambiguous: true } : existing?.ambiguous ? existing : assignment);
}
/** @param {any} plan @param {Map<string,any>} definitions @param {any} truck @param {any} load @param {number} index @param {Map<string,any>} assignments */
function addLoadAssignments(plan, definitions, truck, load, index, assignments) {
  if (!load.id || load.returnOnly) return;
  const fleet = dispatchLoadAssignment(truck, load, { driverSequence: index });
  const assignment = { planId: String(plan.id), planDate: plan.plan_date, loadId: String(load.id),
    truckPlate: fleet.truckPlate, loadName: String(load.name || ""), sequence: fleet.driverSequence };
  for (const stop of load.stops || []) {
    const ref = String(stop.orderId || stop.orderRef || "");
    if (!ref || stop.type !== "drop") continue;
    for (const original of originalRefs(definitions.get(ref) || { id: ref }, definitions)) putAssignment(assignments, `${plan.plan_date}:${original}`, assignment);
  }
}
/** @param {any[]} orders */
async function ordersWithGroupDates(orders) {
  const missing = orders.filter((order) => !consolidationDate(order.dispatch_plan_date));
  if (!missing.length) return orders;
  // Group planning may leave original orders' dispatch fields empty, including on preview reload.
  /** @type {Array<{ref: string, type: string, dates: string[]}>} */
  const rows = (await query(`SELECT source.ref,source.type,array_agg(DISTINCT p.plan_date::text) AS dates
    FROM jsonb_to_recordset($1::jsonb) AS source(ref text,type text)
    JOIN dispatch_delivery_group_members m ON m.member_order_ref=source.ref
    JOIN dispatch_delivery_groups g ON g.group_ref=m.group_ref AND g.active=true AND g.order_type=source.type
    JOIN dispatch_plans p ON p.id=g.plan_id AND p.status<>'cancelled'
    GROUP BY source.ref,source.type`, [JSON.stringify(missing.map((order) => ({ ref: order.tranid, type: order.order_type })))])).rows;
  const datesByOrder = new Map(rows.map((row) => [`${row.type}:${row.ref}`, row.dates]));
  return orders.map((order) => {
    if (consolidationDate(order.dispatch_plan_date)) return order;
    const dates = datesByOrder.get(`${order.order_type}:${order.tranid}`);
    return dates?.length === 1 ? { ...order, dispatch_plan_date: dates[0] } : order;
  });
}
/** @param {any[]} orders */
async function assignmentsForOrders(orders) {
  const dates = [...new Set(orders.map((order) => consolidationDate(order.dispatch_plan_date)).filter(Boolean))];
  if (!dates.length) return new Map();
  const plans = (await query(`SELECT p.id,p.plan_date::text,s.orders,s.trucks FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.plan_date=ANY($1::date[]) AND p.status<>'cancelled'`, [dates])).rows;
  const assignments = new Map();
  for (const plan of plans) {
    const definitions = new Map((plan.orders || []).map((/** @type {any} */ order) => [String(order.id), order]));
    for (const truck of plan.trucks || []) for (const [index, load] of (truck.loads || []).entries()) {
      addLoadAssignments(plan, definitions, truck, load, index, assignments);
    }
  }
  return assignments;
}
/** @param {any} operator @param {number} yard @param {unknown[]} [selectedIds] */
async function consolidationSources(operator, yard, selectedIds) {
  if (selectedIds) {
    if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.some((id) => typeof id !== "string" || !/^(?:-?\d+|(?:VRMA:|CO-|(?:GROUP:)?(?:GRP|G[A-Z]+)-)\S+)$/i.test(id))) throw consolidationError("Select packed orders.", "CONSOLIDATION_LOAD_INVALID", 400);
    const sources = await Promise.all(selectedIds.map((id) => getDeliveryOrder(id)));
    if (sources.some((order) => !order)) throw consolidationError("A selected order is no longer available.", "CONSOLIDATION_LOAD_STALE");
    return sources;
  }
  const lists = await Promise.all([
      ...["sales_order", "transfer_order"].map((orderType) => listDeliveryOrders({ locationId: yard, status: "packed", orderType, allowedOperatorYards: operatorYardLocationIds(operator) })),
      listVrmaDeliveryPrepOrders({ locationId: yard, status: "packed" })
    ]);
  return Promise.all(lists.flat().map((order) => getDeliveryOrder(order.netsuite_id)));
}
/** @param {any} operator @param {unknown} locationId @param {unknown[]} [selectedIds] */
export async function readConsolidationOrders(operator, locationId, selectedIds) {
  const yard = assertOperatorYard(operator, locationId);
  const sources = await consolidationSources(operator, yard, selectedIds);
  const orders = await ordersWithGroupDates(originalConsolidationOrders(sources, yard, Boolean(selectedIds)));
  const assignments = await assignmentsForOrders(orders);
  const eligible = orders.map((order) => ({ ...order, assignment: assignments.get(`${consolidationDate(order.dispatch_plan_date)}:${order.tranid}`) }))
    .filter((order) => order.assignment?.loadId && order.assignment.truckPlate && order.operator_status === "packed"
      && !order.vrma_reference_only && (order.lines || []).some(consolidationPackedLine));
  if (selectedIds && eligible.length !== orders.length) throw consolidationError("A selected order is no longer packed or has no unique planned load.", "CONSOLIDATION_LOAD_STALE");
  return eligible.sort(compareConsolidationOrders);
}
/** @param {any} operator @param {{locationId: unknown, planDate?: string, truckPlate?: string}} options */
export async function listConsolidationLoadOrders(operator, { locationId, planDate = "", truckPlate = "" }) {
  const rows = await readConsolidationOrders(operator, locationId);
  return { orders: rows.filter((order) => (!planDate || order.assignment.planDate === planDate) && (!truckPlate || order.assignment.truckPlate === truckPlate))
    .map((order) => ({ netsuite_id: String(order.netsuite_id), tranid: order.tranid, customer: order.customer || "", order_type: order.order_type, assignment: order.assignment })),
    dates: [...new Set(rows.map((order) => order.assignment.planDate))].sort(),
    trucks: [...new Set(rows.filter((order) => !planDate || order.assignment.planDate === planDate).map((order) => order.assignment.truckPlate))].sort() };
}
/** @param {any} operator @param {{locationId: unknown, orderIds: unknown[]}} options */
export async function createConsolidationLoadPreview(operator, { locationId, orderIds }) {
  if (!Array.isArray(orderIds) || !orderIds.length) throw consolidationError("Select packed orders.", "CONSOLIDATION_LOAD_INVALID", 400);
  const orders = await readConsolidationOrders(operator, locationId, orderIds);
  const snapshot = buildConsolidationSnapshot(orders), id = crypto.randomUUID();
  await query("INSERT INTO operator_consolidated_loads(id,operator_id,location_id,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5)", [id, operator.id, snapshot.locationId, JSON.stringify(snapshot), consolidationSnapshotHash(snapshot)]);
  return getConsolidatedLoad(operator, id);
}
/** @param {any} operator @param {ReturnType<typeof publicBatch>} batch */
export async function revalidateConsolidationLoad(operator, batch) {
  const orders = await readConsolidationOrders(operator, batch.locationId, batch.snapshot.orders.map((order) => order.netsuite_id));
  const current = buildConsolidationSnapshot(orders);
  if (consolidationSnapshotHash(current) !== consolidationSnapshotHash(batch.snapshot)) throw consolidationError("Packed quantities or the planned load changed. Review the selection again.", "CONSOLIDATION_LOAD_STALE");
  return orders;
}
/** @param {string} id @param {string} operatorId @param {Array<Record<string,any>>} results */
function publishLoadCompletion(id, operatorId, results) {
  for (const order of results) {
    emitCompletion("delivery.order.loaded", { orderId: order.orderId, operatorId, resultId: order.id, consolidationLoadId: id });
    if (order.activatedCo?.length) {
      const payload = { orderId: order.orderId, activatedCo: order.activatedCo, source: "delivery-load" };
      emitCompletion("receiving.order.updated", payload);
      emitCompletion("dispatch.co.updated", payload);
    }
  }
}
/** @param {string} id */
export async function completeConsolidatedLoad(id, { allowNetSuiteCompleted = false, preflight = false } = {}) {
  return withConsolidatedLoadContext(id, () => withTransaction(async () => {
    const row = (await query("SELECT * FROM operator_consolidated_loads WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!row) throw consolidationError("Consolidation Load not found.");
    if (row.status === "completed") return row.result;
    const snapshot = /** @type {ReturnType<typeof buildConsolidationSnapshot>} */ (row.snapshot);
    await lockConsolidatedLoadOrders(snapshot.orders.map((order) => order.netsuite_id));
    const currentOrders = await Promise.all(snapshot.orders.map(async (entry) => ({
      ...await getDeliveryOrder(entry.netsuite_id, { includeNetSuiteClosed: allowNetSuiteCompleted }), assignment: snapshot.assignment
    })));
    if (consolidationSnapshotHash(buildConsolidationSnapshot(currentOrders)) !== consolidationSnapshotHash(snapshot)) {
      throw consolidationError("Accepted packed quantities changed. This load needs review.", "CONSOLIDATION_LOAD_STALE");
    }
    /** @type {Array<Record<string,any>>} */
    const results = [];
    for (const [index, order] of snapshot.orders.entries()) {
      const hex = crypto.createHash("sha256").update(`${id}:${index}`).digest("hex");
      const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      const result = await recordDeliveryLoad(order.netsuite_id, row.operator_id, { photoDataUrls: row.photo_refs, requestId, allowNetSuiteCompleted });
      if (!result.localOnly) await syncDirectDependencyOperatorProgress(order.netsuite_id);
      if (result.id) await query("UPDATE operator_load_records SET response=response || $2::jsonb WHERE id=$1", [result.id, JSON.stringify({ consolidationLoadId: id, dispatchPlanDate: snapshot.assignment.planDate, dispatchTruckPlate: snapshot.assignment.truckPlate, dispatchLoadName: snapshot.assignment.loadName })]);
      results.push({ orderId: order.netsuite_id, tranid: order.tranid, ...result });
    }
    const result = { consolidationLoadId: id, sourceLoadRecords: results, localYardOrderStatus: "Loaded" };
    await query("UPDATE operator_consolidated_loads SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL,result=$2 WHERE id=$1", [id, JSON.stringify(result)]);
    if (!preflight && !row.command_id) {await enqueuePostingPhotos({ batchId: id, photos: row.photo_refs });}
    await query("UPDATE operator_consolidated_load_claims SET active=false WHERE batch_id=$1", [id]);
    await writeAudit({ actorOperatorId: row.operator_id, action: "delivery.consolidation.loaded", details: { batchId: id, orderIds: snapshot.orders.map((order) => order.netsuite_id) } });
    if (!preflight) afterTransactionCommit(() => publishLoadCompletion(id, row.operator_id, results));
    return result;
  }, { rollback: preflight }));
}
