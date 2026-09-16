import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { query, withTransaction, hasActiveTransaction } from "../src/db.js";
import { listDriverPwaCompletedDispatchRefs } from "../src/dispatch-history-mode.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../src/dispatch-fleet-status.js";
import { projectCleanupOrder, normalizeRef, lineWriteFields, orderWriteFields } from "./so-delivery-cleanup-domain.mjs";

export function canonical(value) {
  return JSON.stringify(value, (_key, retained) => retained && typeof retained === "object" && !Array.isArray(retained)
    ? Object.fromEntries(Object.keys(retained).sort().map(key => [key, retained[key]])) : retained);
}
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const rows = async (sql, params = []) => (await query(sql, params)).rows;

async function protectedState() {
  const result = {};
  for (const [name, expression] of [
    ["driver_job_records", "jsonb_build_array(id,job_id,status,started_at,completed_at,order_refs,photo_data_urls)::text"],
    ["dispatch_plan_snapshots", "orders::text || trucks::text"],
    ["dispatch_sales_order_if_candidates", "row_to_json(t)::text"],
    ["operator_netsuite_posting_commands", "row_to_json(t)::text"]
  ]) result[name] = (await rows(`SELECT count(*)::int AS count, md5(string_agg(md5(${expression}),'' ORDER BY md5(${expression}))) AS hash FROM ${name} t`))[0];
  return result;
}

async function captureState() {
  const orders = await rows(`SELECT netsuite_id,tranid,status,status_text,sales_order_type,
    netsuite_active,is_test_fixture,netsuite_missing_at,operator_status,local_yard_order_status,
    fulfillment_status,preparing_operator_id IS NOT NULL AS has_preparing_operator,
    preparing_started_at,last_item_fulfillment_id,last_item_fulfillment_tranid,fulfilled_at,
    dispatch_planned,dispatch_plan_date,dispatch_planned_at
    FROM sales_orders ORDER BY netsuite_id`);
  const ids = orders.filter(order => order.sales_order_type === "Delivery").map(order => order.netsuite_id);
  const lines = await rows(`SELECT id,sales_order_id,line_id,item_id,sku,item_name,item_type,
    quantity::float8,unit,pallet_qty::float8,layer_qty::float8,section_qty::float8,piece_qty::float8,
    to_plt::float8,to_lyr::float8,to_sec::float8,to_pcs::float8,loaded_qty::float8,loaded_uom,netsuite_active,
    packed_pallet_qty::float8,packed_layer_qty::float8,packed_section_qty::float8,packed_piece_qty::float8,
    packed_sales_qty::float8,confirmed,sync_exception,
    fulfilled_pallet_qty::float8,fulfilled_layer_qty::float8,fulfilled_section_qty::float8,fulfilled_piece_qty::float8
    FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,id`, [ids]);
  const splits = await rows("SELECT source_so_id,source_so_ref,split_so_id,split_so_ref,status FROM dispatch_scm_so_splits ORDER BY split_so_id");
  const reloads = await rows("SELECT sales_order_id,reattempt_order_id,status FROM operator_reload_cycles WHERE status IN ('authorized','preparing','packed','in_progress') ORDER BY id");
  const claims = await rows(`SELECT order_id AS order_key FROM operator_consolidated_load_claims WHERE active
    UNION SELECT local_order_key FROM operator_netsuite_posting_order_claims WHERE active AND function_key='delivery_prep' ORDER BY order_key`);
  const allocations = await rows(`SELECT sales_line_id,SUM(sales_qty)::float8 AS sales_qty,SUM(pallet_qty)::float8 AS pallet_qty,
    SUM(layer_qty)::float8 AS layer_qty,SUM(section_qty)::float8 AS section_qty,SUM(piece_qty)::float8 AS piece_qty FROM (
      SELECT sales_line_id,allocated_sales_qty AS sales_qty,allocated_pallet_qty AS pallet_qty,
        allocated_layer_qty AS layer_qty,allocated_section_qty AS section_qty,allocated_piece_qty AS piece_qty
        FROM dispatch_so_po_allocations WHERE status='active'
      UNION ALL SELECT dl.sales_line_id,dl.allocated_quantity,dl.pallet_qty,dl.layer_qty,dl.section_qty,dl.piece_qty
        FROM order_dependency_lines dl JOIN order_dependencies d ON d.id=dl.dependency_id
        WHERE d.dependency_mode='direct_to_customer' AND d.status<>'cancelled'
    ) a GROUP BY sales_line_id ORDER BY sales_line_id`);
  const completions = await rows(`SELECT completion_event_id,order_ref,completion_evidence_type,completion_evidence_id,
    dispatch_completed_at FROM dispatch_order_completion_status WHERE order_kind='SO' ORDER BY order_ref`);
  const driverCompletedRefs = [...await listDriverPwaCompletedDispatchRefs({candidateRefs: orders.filter(order => order.sales_order_type === "Delivery").map(order => order.tranid)})].sort();
  return JSON.parse(JSON.stringify({orders,lines,splits,reloads,claims,allocations,completions,driverCompletedRefs,protected:await protectedState()}));
}

export async function readCleanupState() {
  if (hasActiveTransaction()) return captureState();
  return withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return captureState();
  });
}

function indexState(state, remote) {
  const identities = new Map();
  for (const order of state.orders) identities.set(normalizeRef(order.tranid), (identities.get(normalizeRef(order.tranid)) || 0) + 1);
  const lines = new Map();
  for (const line of state.lines) lines.set(String(line.sales_order_id), [...(lines.get(String(line.sales_order_id)) || []), line]);
  return { identities, lines, orders:new Map(state.orders.map(order => [String(order.netsuite_id),order])),
    verified:new Map(remote.rows.map(order => [String(order.id),order])),
    splits:new Map(state.splits.map(split => [String(split.split_so_id),split])),
    completions:new Map(state.completions.map(row => [normalizeRef(row.order_ref),row])),
    driver:new Set(state.driverCompletedRefs.map(normalizeRef)),
    reloads:new Set(state.reloads.flatMap(row => [String(row.sales_order_id),String(row.reattempt_order_id)])),
    claims:new Set(state.claims.map(row => normalizeRef(row.order_key))),
    allocations:Object.fromEntries(state.allocations.map(row => [String(row.sales_line_id),row])) };
}

function projectionInput(order, index) {
  const id = String(order.netsuite_id), ref = normalizeRef(order.tranid);
  const split = index.splits.get(id) || null;
  const source = index.orders.get(String(split?.source_so_id || id));
  const lines = index.lines.get(id) || [];
  const completion = index.completions.get(ref);
  return { lines, options: { source, split, verified:index.verified.get(String(source.netsuite_id)) || null,
    identityCount:index.identities.get(ref),sourceIdentityCount:index.identities.get(normalizeRef(source.tranid)),
    locallyCompleted:index.driver.has(ref) || ["manual_dispatch","direct_dependency"].includes(completion?.completion_evidence_type),
    hasCompletion:Boolean(completion), activeReload:index.reloads.has(id) || index.reloads.has(String(source.netsuite_id)),
    claimed:[id,ref,`sales_order:${id}`,`sales_order:${ref}`].some(key => index.claims.has(key)),
    allocations:Object.fromEntries(lines.filter(line => index.allocations[String(line.id)]).map(line => [String(line.id),index.allocations[String(line.id)]])) } };
}

function supportGuard(options) {
  return {split:options.split,identityCount:options.identityCount,sourceIdentityCount:options.sourceIdentityCount,
    locallyCompleted:options.locallyCompleted,activeReload:options.activeReload,claimed:options.claimed,allocations:options.allocations};
}

export function createCleanupManifest(state, remote, {candidateIds = null, scope = "all-qualifying"} = {}) {
  assert.equal(remote.mode,"netsuite-read-only-select","Only direct NetSuite SELECT evidence is accepted");
  assert.equal(new Set(remote.rows.map(row => String(row.id))).size,remote.rows.length,"Duplicate NetSuite IDs");
  const index = indexState(state,remote), selected = candidateIds ? new Set(candidateIds.map(String)) : null;
  const entries = [], held = [], unchanged = [], excludedCompleted = [];
  for (const order of state.orders) {
    if (order.sales_order_type !== "Delivery" || order.is_test_fixture || (selected && !selected.has(String(order.netsuite_id)))) continue;
    const {lines,options} = projectionInput(order,index);
    if (scope === "local-delivery-only") options.verified = null;
    const projected = projectCleanupOrder(order,lines,options);
    if ((scope === "no-local-delivery" && options.locallyCompleted) ||
      (scope === "local-delivery-only" && !options.locallyCompleted)) {
      excludedCompleted.push({id:String(order.netsuite_id),ref:order.tranid});
      continue;
    }
    if (scope === "unfinished-local" && (options.locallyCompleted ||
      [order.operator_status,order.local_yard_order_status].some(value => ["loaded","shipped","fulfilled","completed","complete"].includes(normalizeRef(value))))) {
      excludedCompleted.push({id:String(order.netsuite_id),ref:order.tranid});
      continue;
    }
    if (!projected.eligible) {
      (projected.qualifies ? held : unchanged).push({id:String(order.netsuite_id),ref:order.tranid,reasons:projected.reasons});
      continue;
    }
    entries.push({id:String(order.netsuite_id),ref:order.tranid,before:{order,lines},after:{order:projected.order,lines:projected.lines},
      guard:supportGuard(options),evidence:projected.evidence,addCompletion:projected.addCompletion});
  }
  return {version:1,createdAt:new Date().toISOString(),scope,remote,entries,held,unchanged,excludedCompleted};
}

function changedFields(before, after, fields) {
  return fields.filter(field => canonical(before[field]) !== canonical(after[field]));
}

export function cleanupManifestSummary(manifest) {
  return {eligible:manifest.entries.length,held:manifest.held.length,unchanged:manifest.unchanged.length,
    excludedCompleted:manifest.excludedCompleted.length,
    changedOrders:manifest.entries.filter(entry => digest(entry.before) !== digest(entry.after) || entry.addCompletion).length,
    changedHeaders:manifest.entries.filter(entry => changedFields(entry.before.order,entry.after.order,orderWriteFields).length).length,
    changedLines:manifest.entries.reduce((total,entry) => total + entry.before.lines.filter((line,i) => changedFields(line,entry.after.lines[i],lineWriteFields).length).length,0),
    newCompletions:manifest.entries.filter(entry => entry.addCompletion).length,
    localOnly:manifest.entries.filter(entry => entry.guard.locallyCompleted && !entry.evidence).length};
}

async function lockCleanup(manifest) {
  await query("SET LOCAL lock_timeout='3s'");
  await query("SET LOCAL statement_timeout='60s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))",[DISPATCH_FLEET_PLANNING_LOCK]);
  for (const id of manifest.entries.map(entry => entry.id).sort()) {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`operator-delivery-load:${id}`]);
  }
  // Briefly prevent source sync and linked-supply edits while before-images and
  // all cross-order evidence are checked. NOWAIT aborts rather than disrupting work.
  await query(`LOCK TABLE sales_orders,sales_order_lines,dispatch_scm_so_splits,operator_reload_cycles,
    operator_consolidated_load_claims,operator_netsuite_posting_order_claims,dispatch_so_po_allocations,
    order_dependencies,order_dependency_lines,dispatch_order_completion_events,
    dispatch_sales_order_if_candidates,operator_netsuite_posting_commands IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
}

function validateManifest(manifest, fresh) {
  const freshById = new Map(fresh.entries.map(entry => [entry.id,entry]));
  const pending = [];
  for (const entry of manifest.entries) {
    const current = freshById.get(entry.id);
    assert(current,`Cleanup manifest is stale or restricted: ${entry.ref}`);
    assert.equal(digest(current.guard),digest(entry.guard),`Cleanup evidence changed: ${entry.ref}`);
    assert.equal(digest(current.after),digest(entry.after),`Cleanup projection changed: ${entry.ref}`);
    const beforeHash = digest(current.before);
    assert(beforeHash === digest(entry.before) || beforeHash === digest(entry.after),`Cleanup before-image is stale: ${entry.ref}`);
    if (beforeHash !== digest(entry.after) || current.addCompletion) pending.push(current);
  }
  return pending;
}

async function writeChanges(entries, manifestHash, observedAt) {
  const headers = [], lines = [];
  for (const entry of entries) {
    if (changedFields(entry.before.order,entry.after.order,orderWriteFields).length) headers.push(entry.after.order);
    entry.after.lines.forEach((line,i) => { if (changedFields(entry.before.lines[i],line,lineWriteFields).length) lines.push(line); });
  }
  // Append observation evidence first. Never create Driver evidence or call a posting service.
  const completions = entries.filter(entry => entry.addCompletion);
  const added = await query(`INSERT INTO dispatch_order_completion_events
    (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,reason,metadata)
    SELECT 'SO',entry->>'ref',$2::timestamptz,'netsuite_fulfillment','so-delivery-cleanup:' || $3 || ':' || (entry->>'id'),
      'system','One-time SO cleanup: NetSuite fulfillment observed; physical delivery time is unknown.',
      jsonb_build_object('cleanupManifestSha256',$3,'observedAt',$2,'physicalDeliveryAt',NULL,'netsuiteEvidence',entry->'evidence')
    FROM jsonb_array_elements($1::jsonb) entry`,[JSON.stringify(completions),observedAt,manifestHash]);
  await query(`UPDATE sales_orders target SET operator_status=value.operator_status,
    local_yard_order_status=value.local_yard_order_status,status=value.status,status_text=value.status_text
    FROM jsonb_to_recordset($1::jsonb) AS value(netsuite_id bigint,operator_status text,local_yard_order_status text,status text,status_text text)
    WHERE target.netsuite_id=value.netsuite_id`,[JSON.stringify(headers)]);
  await query(`UPDATE sales_order_lines target SET loaded_qty=value.loaded_qty,loaded_uom=value.loaded_uom,confirmed=value.confirmed,
    packed_pallet_qty=0,packed_layer_qty=0,packed_section_qty=0,packed_piece_qty=0,packed_sales_qty=0
    FROM jsonb_to_recordset($1::jsonb) AS value(id bigint,loaded_qty numeric,loaded_uom text,confirmed boolean)
    WHERE target.id=value.id`,[JSON.stringify(lines)]);
  return {changedOrders:entries.length,changedHeaders:headers.length,changedLines:lines.length,addedCompletions:added.rowCount};
}

export async function applyCleanupManifest(manifest, {rollback = false} = {}) {
  assert.equal(manifest.version,1,"Unsupported cleanup manifest");
  const age = Date.now()-Date.parse(manifest.remote.completedAt);
  assert(Number.isFinite(age) && age>=-60000 && age<=90*60000,"NetSuite evidence is expired or invalid");
  assert.equal(new Set(manifest.entries.map(entry => entry.id)).size,manifest.entries.length,"Duplicate manifest entries");
  const manifestHash = digest(manifest), startedAt = new Date().toISOString();
  return withTransaction(async () => {
    await lockCleanup(manifest);
    const before = await readCleanupState();
    const fresh = createCleanupManifest(before,manifest.remote,{candidateIds:manifest.entries.map(entry => entry.id),
      scope:manifest.scope === "local-delivery-only" ? "local-delivery-only" : "all-qualifying"});
    const pending = validateManifest(manifest,fresh);
    const result = await writeChanges(pending,manifestHash,manifest.remote.completedAt);
    const after = await readCleanupState();
    assert.deepEqual(after.protected,before.protected,"Cleanup changed Driver, plan, or external posting state");
    const expectedOrders = new Map(pending.map(entry => [entry.id,entry.after.order]));
    const expectedLines = new Map(pending.flatMap(entry => entry.after.lines.map(line => [String(line.id),line])));
    assert.deepEqual(after.orders,before.orders.map(order => expectedOrders.get(String(order.netsuite_id)) || order),"Unexpected order mutation");
    assert.deepEqual(after.lines,before.lines.map(line => expectedLines.get(String(line.id)) || line),"Unexpected line mutation");
    return {mode:rollback?"transaction-rollback-rehearsal":"applied",manifestSha256:manifestHash,startedAt,
      completedAt:new Date().toISOString(),...result,protectedStateUnchanged:true};
  },{rollback});
}
