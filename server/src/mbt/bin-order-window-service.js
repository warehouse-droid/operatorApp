// @ts-check
import { query } from '../db.js';
import { binWorkflowOrder, binWorkflowParts, binWorkflowError } from './bin-order-workflow-repository.js';
import { binLocalDate } from './bin-order-workflow-domain.js';
import { assertPlanningAccess, readPlanningPlan } from './bin-planning-repository.js';

/** @param {any} value */
function validLocalDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) { return false; }
  const date = new Date(`${value}:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,16) === value;
}

/** @param {any} value */
export async function binRequestedWindow(value) {
  let startAt = value?.startAt, endAt = value?.endAt;
  if (value?.startLocal || value?.endLocal) {
    if (![value.startLocal, value.endLocal].every(validLocalDateTime)) {
      throw binWorkflowError(400, 'Enter a complete start and finish in Toronto time.');
    }
    const row = (await query(`SELECT ($1::timestamp AT TIME ZONE 'America/Toronto') AS start,
      ($2::timestamp AT TIME ZONE 'America/Toronto') AS finish`, [value.startLocal, value.endLocal])).rows[0];
    startAt = row.start; endAt = row.finish;
  }
  if (!startAt || !endAt || !(Date.parse(endAt) > Date.parse(startAt))) {
    throw binWorkflowError(400, 'The time window must have a valid start and a later finish.');
  }
  return { startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() };
}

/** @param {string} visitId @param {boolean} [lock] */
async function windowContext(visitId, lock = false) {
  const root = await binWorkflowOrder(visitId, lock);
  const partRows = await binWorkflowParts(root.service_visit_id);
  const stored = await query(`SELECT * FROM mbt_service_visits WHERE service_visit_id=ANY($1::uuid[])
    ORDER BY service_visit_id ${lock ? 'FOR UPDATE' : ''}`, [partRows.map((/** @type {any} */ p) => p.visit_id)]);
  const parts = partRows.map((/** @type {any} */ p) => ({...p,...stored.rows.find((/** @type {any} */ v) => v.service_visit_id === p.visit_id)}));
  const target = parts.find((/** @type {any} */ p) => p.visit_id === visitId);
  const visits = target ? [target] : parts.length ? parts : [root];
  const guards = [...new Map([root, ...parts].map(v => [v.service_visit_id, v])).values()];
  const ids = guards.map(v => v.service_visit_id);
  const started = await query(`SELECT 1 FROM mbt_visit_steps WHERE service_visit_id=ANY($1::uuid[])
    AND (status IN ('in_progress','completed') OR started_at IS NOT NULL) LIMIT 1`, [ids]);
  const reason = guards.some(v => v.actual_started_at || ['in_progress','evidence_pending','completed','cancelled'].includes(v.status)) || started.rowCount
    ? 'The BIN work has started or closed. Its time window cannot be changed.' : null;
  const plans = [];
  for (const id of [...new Set(visits.map((/** @type {any} */ v) => v.dispatch_plan_id).filter(Boolean))]) {
    const plan = await readPlanningPlan(id);
    plans.push({planId: plan.id, planDate: plan.planDate, baseRevision: plan.revision, baseDigest: plan.digest});
  }
  plans.sort((a,b) => a.planDate.localeCompare(b.planDate) || a.planId.localeCompare(b.planId));
  return { root, parts, visits, guards, target, reason, plans };
}

/** @param {string} visitId */
export async function getBinOrderWindow(visitId) {
  const c = await windowContext(visitId), v = c.target || c.root;
  return { reference: v.display_reference, expectedRevision: Number(c.root.workflow_revision),
    expectedVisits: c.guards.map(row => ({ visitId: row.service_visit_id, revision: Number(row.revision) })),
    plans: c.plans, eligible: false, reason: 'Requested order windows are controlled by Front Desk.',
    window: { startAt: v.scheduled_start_at, endAt: v.scheduled_end_at } };
}

/** Front Desk has no authority to amend work assigned to Dispatch.
 * @param {string} visitId
 */
export async function assertBinDeliveryUnplanned(visitId) {
  const c = await windowContext(visitId, true);
  const issued = await query(`SELECT 1 FROM mbt_bin_planning_assignments WHERE service_visit_id=ANY($1::uuid[])
    AND (withdrawn_at IS NULL OR released_at IS NOT NULL) LIMIT 1`, [c.guards.map(v => v.service_visit_id)]);
  if (c.reason || c.guards.some(v => v.dispatch_plan_id) || issued.rowCount) {
    throw binWorkflowError(409, 'Dispatch has planned or started this delivery. Resolve its planning instructions before changing the order.', 'MBT_FRONTDESK_DELIVERY_PLANNED');
  }
  return c;
}

/** @param {any} c @param {{startAt:string,endAt:string}} window @param {string} actorId */
async function persistWindow(c, window, actorId) {
  const ids = c.visits.map((/** @type {any} */ v) => v.service_visit_id);
  if (!c.parts.length || c.root.order_kind === 'delivery') { ids.push(c.root.service_visit_id); }
  await query(`UPDATE mbt_service_visits SET scheduled_start_at=$2,scheduled_end_at=$3,
    revision=revision+1,updated_by=$4,updated_at=now() WHERE service_visit_id=ANY($1::uuid[])`, [ids, window.startAt, window.endAt, actorId]);
  if (c.root.configuration) {
    const configuration = structuredClone(c.root.configuration);
    for (const part of configuration.parts) { if (ids.includes(part.visitId)) { part.window = window; } }
    if (configuration.sameDay) {
      const delivery = configuration.parts.find((/** @type {any} */ p) => p.role === 'delivery');
      const collection = configuration.parts.find((/** @type {any} */ p) => p.role === 'collection');
      if (binLocalDate(collection.window.startAt) !== binLocalDate(delivery.window.endAt)) {
        throw binWorkflowError(409, 'Collection-first exchanges must deliver the replacement on the same Toronto day.');
      }
    }
    await query('UPDATE mbt_bin_orders SET configuration=$2::jsonb,revision=revision+1 WHERE order_id=$1', [c.root.service_visit_id, JSON.stringify(configuration)]);
  } else { await query('UPDATE mbt_bin_orders SET revision=revision+1 WHERE order_id=$1', [c.root.service_visit_id]); }
  if (c.root.order_kind === 'delivery') {
    await query(`UPDATE mbt_contract_service_lines SET planned_delivery_at=$2,revision=revision+1,
      updated_by=$3,updated_at=now() WHERE service_line_id=$1`, [c.root.service_line_id, window.startAt, actorId]);
    await query(`UPDATE mbt_contracts c SET planned_delivery_at=(SELECT min(planned_delivery_at)
      FROM mbt_contract_service_lines WHERE contract_id=c.contract_id),revision=revision+1,updated_by=$2,updated_at=now()
      WHERE contract_id=$1`, [c.root.contract_id, actorId]);
  }
}

/** @param {string} visitId @param {any} value @param {string} actorId */
export async function updateUnplannedBinDeliveryWindow(visitId, value, actorId) {
  const c = await assertBinDeliveryUnplanned(visitId), window = await binRequestedWindow(value);
  await persistWindow(c, window, actorId);
}

/** Dispatch controls the route and load schedule, never the customer's requested window.
 * @param {any} input @param {any} boundary @returns {Promise<never>} */
export async function changeBinOrderWindow(input, boundary) {
  assertPlanningAccess(input, boundary, true);
  throw binWorkflowError(403, 'Requested order windows are controlled by Front Desk.', 'MBT_BIN_ORDER_WINDOW_READ_ONLY');
}
