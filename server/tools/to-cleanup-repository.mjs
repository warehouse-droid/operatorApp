import assert from "node:assert/strict";
import { query, withTransaction, hasActiveTransaction } from "../src/db.js";
import { listDriverPwaCompletedDispatchRefs } from "../src/dispatch-history-mode.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../src/dispatch-fleet-status.js";
import { netSuiteClosedOrderFamilySql } from "../src/netsuite-closed-order-policy.js";
import { canonical, digest } from "./so-delivery-cleanup-repository.mjs";
import { projectTransferCleanup, refKey, headerFields, outboundFields, receivingFields } from "./to-cleanup-domain.mjs";
export { digest };
const rows = async (sql, params = []) => (await query(sql, params)).rows;
const lineKey = line => `${line.line_stage}:${line.id}`;
const numericFields = [...outboundFields, ...receivingFields].filter(field => !["loaded_uom", "confirmed"].includes(field));

async function protectedState() {
  const result = {};
  for (const [table, expression] of [
    ["driver_job_records", "jsonb_build_array(id,job_id,status,started_at,completed_at,order_refs,photo_data_urls)::text"],
    ["dispatch_plan_snapshots", "orders::text || trucks::text"],
    ["receiving_receipt_records", "row_to_json(t)::text"],
    ["operator_netsuite_posting_commands", "row_to_json(t)::text"],
    ["order_dependencies", "row_to_json(t)::text"],
    ["order_dependency_lines", "row_to_json(t)::text"],
    ["local_co_orders", "row_to_json(t)::text"],
    ["local_co_order_lines", "row_to_json(t)::text"]
  ]) {result[table] = (await rows(`SELECT count(*)::int AS count,md5(string_agg(md5(${expression}),'' ORDER BY md5(${expression}))) AS hash FROM ${table} t`))[0];}
  return result;
}

async function capture() {
  const orders = await rows("SELECT * FROM transfer_orders ORDER BY netsuite_id");
  const lines = await rows(`SELECT t.*,${numericFields.map(field => `${field}::float8 AS ${field}`).join(",")} FROM transfer_order_lines t ORDER BY transfer_order_id,line_stage,id`);
  const splits = await rows("SELECT * FROM dispatch_scm_to_splits ORDER BY split_to_id");
  const reconciliation = await rows("SELECT * FROM scm_reconciliation_order_state WHERE order_kind='TO' ORDER BY source_order_netsuite_id");
  const schedules = await rows("SELECT * FROM scm_transport_schedule WHERE order_kind='TO' ORDER BY id");
  const closed = await rows(`SELECT netsuite_id FROM transfer_orders t WHERE ${netSuiteClosedOrderFamilySql("t", "TO")} ORDER BY netsuite_id`);
  const claims = await rows(`SELECT order_id AS order_key FROM operator_consolidated_load_claims WHERE active
    UNION SELECT local_order_key FROM operator_netsuite_posting_order_claims WHERE active ORDER BY order_key`);
  const completions = await rows("SELECT * FROM dispatch_order_completion_status WHERE order_kind='TO' ORDER BY order_ref");
  const receipts = await rows(`SELECT r.id,r.order_id,r.receipt_status,r.item_receipt_id FROM receiving_receipt_records r
    JOIN transfer_orders t ON t.netsuite_id=r.order_id WHERE r.receipt_status IN ('received','local_direct_receipt') ORDER BY r.id`);
  const driverCompletedRefs = [...await listDriverPwaCompletedDispatchRefs({ candidateRefs: orders.map(row => row.tranid) })].sort();
  return JSON.parse(JSON.stringify({ orders, lines, splits, reconciliation, schedules, closed, claims, completions, receipts, driverCompletedRefs, protected: await protectedState() }));
}
export async function readTransferCleanupState() {
  if (hasActiveTransaction()) {return capture();}
  return withTransaction(async () => { await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"); return capture(); });
}

function indexState(state, remote) {
  const identities = new Map();
  for (const row of state.orders) {identities.set(refKey(row.tranid), (identities.get(refKey(row.tranid)) || 0) + 1);}
  return { identities, verified: new Map(remote.rows.map(row => [String(row.id), row])),
    orders: new Map(state.orders.map(row => [String(row.netsuite_id), row])),
    splits: new Map(state.splits.map(row => [String(row.split_to_id), row])),
    driver: new Set(state.driverCompletedRefs.map(refKey)),
    completed: new Map(state.completions.map(row => [refKey(row.order_ref), row])),
    closed: new Set(state.closed.map(row => String(row.netsuite_id))) };
}

function restrictedFamily(order, parent, state, index) {
  const familyIds = [String(order.netsuite_id), String(parent?.netsuite_id)], familyRefs = [refKey(order.tranid), refKey(parent?.tranid)];
  const reconciliation = state.reconciliation.filter(row => familyIds.includes(String(row.source_order_netsuite_id)));
  const schedules = state.schedules.filter(row => familyRefs.includes(refKey(row.order_ref)));
  const lifecycle = [order, parent].flatMap(row => [row?.local_yard_order_status, row?.outbound_operator_status]);
  return familyIds.some(key => index.closed.has(key)) || [order, parent].some(row => row?.netsuite_missing_at)
    || [...lifecycle, ...schedules.map(row => row.status), ...reconciliation.map(row => row.application_status)].some(value => ["hold", "cancelled", "canceled", "reconcile review"].includes(refKey(value)))
    || reconciliation.some(row => ["review", "missing", "error"].includes(refKey(row.reconciliation_status)))
    || schedules.some(row => row.reconciliation_blocked);
}

function projectionOptions(order, state, index) {
  const id = String(order.netsuite_id), ref = refKey(order.tranid);
  const split = index.splits.get(id), parent = index.orders.get(String(split?.source_to_id || id));
  const completion = index.completed.get(ref);
  const locallyCompleted = index.driver.has(ref) || ["driver_job", "manual_dispatch", "direct_dependency"].includes(completion?.completion_evidence_type);
  const locallyReceived = state.receipts.some(row => String(row.order_id) === id &&
    (row.receipt_status === "local_direct_receipt" || (row.receipt_status === "received" && order.receiving_status === "received")));
  const claimed = state.claims.some(row => [id, ref, `transfer_order:${id}`, `transfer_order:${ref}`].includes(refKey(row.order_key)));
  return { verified: index.verified.get(String(parent?.netsuite_id)), split, parent, locallyCompleted, locallyReceived,
    hasCompletion: Boolean(completion), identityCount: index.identities.get(ref), sourceIdentityCount: index.identities.get(refKey(parent?.tranid)),
    restricted: Boolean(restrictedFamily(order, parent, state, index)), claimed };
}

function supportGuard(options) {
  return { split: options.split || null, locallyCompleted: options.locallyCompleted, locallyReceived: options.locallyReceived,
    claimed: options.claimed, restricted: options.restricted, identityCount: options.identityCount, sourceIdentityCount: options.sourceIdentityCount };
}

function excludedReasons(result, options) {
  if (result.reasons.length) {return result.reasons;}
  return [!options.verified && Number(options.parent?.netsuite_id) > 0 ? "no_current_netsuite_record" : "not_fully_fulfilled_or_locally_completed"];
}

export function createTransferCleanupManifest(state, remote, { candidateIds = null } = {}) {
  assert.equal(remote.mode, "netsuite-read-only-select"); assert.equal(remote.transactionType, "TrnfrOrd");
  assert.equal(new Set(remote.rows.map(row => String(row.id))).size, remote.rows.length);
  const selected = candidateIds && new Set(candidateIds.map(String)), index = indexState(state, remote);
  const entries = [], held = [], unchanged = [];
  for (const order of state.orders) {
    const id = String(order.netsuite_id);
    if (selected && !selected.has(id)) {continue;}
    const options = projectionOptions(order, state, index);
    const lines = state.lines.filter(line => String(line.transfer_order_id) === id);
    const result = projectTransferCleanup(order, lines, options);
    if (!result.eligible) {
      (result.qualifies ? held : unchanged).push({ id, ref: order.tranid, reasons: excludedReasons(result, options) });
      continue;
    }
    entries.push({ id, ref: order.tranid, before: { order, lines }, after: { order: result.order, lines: result.lines },
      evidence: result.evidence, outbound: result.outbound, receiving: result.receiving, addCompletion: result.addCompletion, guard: supportGuard(options) });
  }
  return { version: 1, kind: "transfer-order-cleanup", createdAt: new Date().toISOString(), remote, entries, held, unchanged };
}

const changed = (before, after, fields) => fields.some(field => canonical(before[field]) !== canonical(after[field]));
export function transferCleanupSummary(manifest) {
  return { eligible: manifest.entries.length, held: manifest.held.length, excluded: manifest.unchanged.length,
    changedOrders: manifest.entries.filter(entry => digest(entry.before) !== digest(entry.after) || entry.addCompletion).length,
    changedHeaders: manifest.entries.filter(entry => changed(entry.before.order, entry.after.order, headerFields)).length,
    changedOutboundLines: manifest.entries.reduce((sum, entry) => sum + entry.before.lines.filter((line, i) => line.line_stage === "outbound" && changed(line, entry.after.lines[i], outboundFields)).length, 0),
    changedReceivingLines: manifest.entries.reduce((sum, entry) => sum + entry.before.lines.filter((line, i) => line.line_stage === "receiving" && changed(line, entry.after.lines[i], receivingFields)).length, 0),
    receivingEligible: manifest.entries.filter(entry => entry.receiving).length,
    changedReceivingHeaders: manifest.entries.filter(entry => entry.before.order.receiving_status !== entry.after.order.receiving_status).length,
    localDelivery: manifest.entries.filter(entry => entry.guard.locallyCompleted).length,
    netsuiteOnly: manifest.entries.filter(entry => !entry.guard.locallyCompleted).length,
    newCompletions: manifest.entries.filter(entry => entry.addCompletion).length };
}

export async function applyTransferCleanupManifest(manifest, { rollback = false } = {}) {
  assert.equal(manifest.version, 1); assert.equal(manifest.kind, "transfer-order-cleanup");
  const age = Date.now() - Date.parse(manifest.remote.completedAt);
  assert(Number.isFinite(age) && age >= -60000 && age <= 90 * 60000, "NetSuite proof expired");
  assert.equal(new Set(manifest.entries.map(entry => entry.id)).size, manifest.entries.length);
  return withTransaction(async () => {
    await query("SET LOCAL lock_timeout='3s'"); await query("SET LOCAL statement_timeout='60s'");
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    for (const id of manifest.entries.map(entry => entry.id).sort()) {await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${id}`]);}
    await query(`LOCK TABLE transfer_orders,transfer_order_lines,dispatch_scm_to_splits,scm_reconciliation_order_state,
      scm_transport_schedule,operator_consolidated_load_claims,operator_netsuite_posting_order_claims,dispatch_order_completion_events,
      receiving_receipt_records,operator_netsuite_posting_commands,driver_job_records IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const before = await readTransferCleanupState();
    const fresh = createTransferCleanupManifest(before, manifest.remote, { candidateIds: manifest.entries.map(entry => entry.id) });
    const byId = new Map(fresh.entries.map(entry => [entry.id, entry])), pending = [];
    for (const entry of manifest.entries) {
      const current = byId.get(entry.id);
      assert(current, `TO became restricted: ${entry.ref}`);
      assert.equal(digest(current.guard), digest(entry.guard), `TO evidence changed: ${entry.ref}`);
      assert.equal(digest(current.after), digest(entry.after), `TO projection changed: ${entry.ref}`);
      assert([digest(entry.before), digest(entry.after)].includes(digest(current.before)), `TO before-image stale: ${entry.ref}`);
      if (digest(current.before) !== digest(current.after) || current.addCompletion) {pending.push(current);}
    }
    const headers = pending.filter(entry => changed(entry.before.order, entry.after.order, headerFields)).map(entry => entry.after.order);
    await query(`UPDATE transfer_orders t SET outbound_operator_status=v.outbound_operator_status,local_yard_order_status=v.local_yard_order_status,
      receiving_status=v.receiving_status,status=v.status,status_text=v.status_text
      FROM jsonb_to_recordset($1::jsonb) AS v(netsuite_id bigint,outbound_operator_status text,local_yard_order_status text,receiving_status text,status text,status_text text)
      WHERE t.netsuite_id=v.netsuite_id`, [JSON.stringify(headers)]);
    const output = [], input = [];
    for (const entry of pending) {entry.after.lines.forEach((line, i) => {
      const fields = line.line_stage === "outbound" ? outboundFields : receivingFields;
      if (changed(entry.before.lines[i], line, fields)) {(line.line_stage === "outbound" ? output : input).push(line);}
    });}
    await query(`UPDATE transfer_order_lines t SET loaded_qty=v.loaded_qty,loaded_uom=v.loaded_uom,confirmed=false,
      packed_pallet_qty=0,packed_layer_qty=0,packed_section_qty=0,packed_piece_qty=0,packed_sales_qty=0
      FROM jsonb_to_recordset($1::jsonb) AS v(id bigint,loaded_qty numeric,loaded_uom text)
      WHERE t.id=v.id AND t.line_stage='outbound'`, [JSON.stringify(output)]);
    await query(`UPDATE transfer_order_lines t SET netsuite_received_qty=v.netsuite_received_qty,received_pallet_qty=0,
      received_layer_qty=0,received_section_qty=0,received_piece_qty=0,received_sales_qty=0
      FROM jsonb_to_recordset($1::jsonb) AS v(id bigint,netsuite_received_qty numeric)
      WHERE t.id=v.id AND t.line_stage='receiving'`, [JSON.stringify(input)]);
    const observations = pending.filter(entry => entry.addCompletion), hash = digest(manifest);
    await query(`INSERT INTO dispatch_order_completion_events
      (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,reason,metadata)
      SELECT 'TO',v->>'ref',$2::timestamptz,'netsuite_fulfillment','to-cleanup:' || $3 || ':' || (v->>'id'),'system',
        'One-time TO cleanup: verified NetSuite fulfillment; physical delivery time is unknown.',
        jsonb_build_object('cleanupManifestSha256',$3,'observedAt',$2,'physicalDeliveryAt',NULL,'netsuiteEvidence',v->'evidence')
      FROM jsonb_array_elements($1::jsonb) v`, [JSON.stringify(observations), manifest.remote.completedAt, hash]);
    const after = await readTransferCleanupState();
    const expectedOrders = new Map(pending.map(entry => [entry.id, entry.after.order]));
    const expectedLines = new Map(pending.flatMap(entry => entry.after.lines.map(line => [lineKey(line), line])));
    assert.deepEqual(after.orders, before.orders.map(row => expectedOrders.get(String(row.netsuite_id)) || row), "Unexpected TO header mutation");
    assert.deepEqual(after.lines, before.lines.map(row => expectedLines.get(lineKey(row)) || row), "Unexpected TO line/stage mutation");
    assert.deepEqual(after.protected, before.protected, "Driver, receipt, posting, dependency, CO or plan state changed");
    assert.deepEqual(after.reconciliation, before.reconciliation); assert.deepEqual(after.schedules, before.schedules);
    return { mode: rollback ? "transaction-rollback-rehearsal" : "applied", manifestSha256: hash, completedAt: new Date().toISOString(),
      changedOrders: pending.length, changedHeaders: headers.length, changedOutboundLines: output.length, changedReceivingLines: input.length,
      addedCompletions: observations.length, protectedStateUnchanged: true };
  }, { rollback });
}
