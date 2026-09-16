import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { query, withTransaction } from "../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../src/dispatch-fleet-status.js";
import { readTransferCleanupState, createTransferCleanupManifest, digest } from "./to-cleanup-repository.mjs";
import { projectAuthoritativeTransferLines, authoritativeLineFields, authorityLineKey } from "./to-conflict-domain.mjs";
export { digest };

export function conflictSourceHashes() {
  const names = ["../src/db.js", "../src/delivery-repository.js", "../src/dispatch-history-mode.js", "../src/netsuite-closed-order-policy.js",
    "../src/dispatch-fulfilled-to-policy.js", "../src/dispatch-fulfilled-to-repository.js", "../src/receiving-repository.js",
    "./to-conflict-domain.mjs", "./to-conflict-repository.mjs", "./to-cleanup-domain.mjs", "./to-cleanup-repository.mjs"];
  return Object.fromEntries(names.map(name => [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")]));
}

function statusProof(remote) {
  assert.equal(remote.mode, "netsuite-read-only-select"); assert.equal(remote.transactionType, "TrnfrOrd");
  assert(remote.orders.length > 0 && remote.orders.length === remote.requested.length, "Missing target NetSuite proof");
  const requested = new Map(remote.requested.map(row => [String(row.netsuite_id), row.tranid]));
  assert.equal(requested.size, remote.orders.length, "Duplicate requested TO");
  assert.equal(new Set(remote.orders.map(row => String(row.id))).size, requested.size, "Duplicate NetSuite TO");
  for (const row of remote.orders) {assert.equal(requested.get(String(row.id)), row.tranid, "Unexpected NetSuite TO");}
  return { mode: remote.mode, transactionType: remote.transactionType, completedAt: remote.completedAt,
    rows: remote.orders.map(row => ({ id: String(row.id), tranid: row.tranid, status: row.status, status_text: row.statusText })) };
}

export function createConflictManifest(state, remote) {
  const statuses = statusProof(remote), ids = new Set(remote.orders.map(row => String(row.id)));
  const orders = new Map(state.orders.map(row => [String(row.netsuite_id), row]));
  const corrections = new Map(remote.orders.map(proof => {
    const id = String(proof.id), order = orders.get(id);
    assert(order, `Local TO disappeared: ${proof.tranid}`);
    return [id, projectAuthoritativeTransferLines(order, state.lines.filter(line => String(line.transfer_order_id) === id), proof, remote.completedAt)];
  }));
  const projected = { ...state, lines: [...state.lines.filter(line => !ids.has(String(line.transfer_order_id))), ...[...corrections.values()].flat()] };
  const cleanup = createTransferCleanupManifest(projected, statuses, { candidateIds: [...ids] });
  assert.equal(cleanup.entries.length, ids.size, `TOs no longer eligible or require review: ${JSON.stringify([...cleanup.held, ...cleanup.unchanged])}`);
  const verified = new Map(statuses.rows.map(row => [row.id, row]));
  const entries = cleanup.entries.map(entry => ({ ...entry,
    before: { order: orders.get(entry.id), lines: state.lines.filter(line => String(line.transfer_order_id) === entry.id) },
    after: { ...entry.after, order: { ...entry.after.order, status: verified.get(entry.id).status, status_text: verified.get(entry.id).status_text } } }));
  return { version: 1, kind: "authoritative-transfer-conflict-cleanup", createdAt: new Date().toISOString(), sourceHashes: conflictSourceHashes(), remote, entries };
}

function replacementIds(entry) {
  return new Map(entry.after.lines.filter(line => String(line.id).startsWith("new:")).map(line => [authorityLineKey(line), line.id]));
}

function comparableImage(image, template) {
  const inserted = replacementIds(template);
  const lines = image.lines.map(line => ({ ...line, id: inserted.get(authorityLineKey(line)) || line.id }));
  lines.sort((a, b) => `${authorityLineKey(a)}:${a.id}`.localeCompare(`${authorityLineKey(b)}:${b.id}`));
  return { order: image.order, lines };
}

function imageHash(image, template) { return digest(comparableImage(image, template)); }

export function conflictSummary(manifest) {
  const rows = manifest.entries.flatMap(entry => {
    const before = new Map(entry.before.lines.map(line => [`${line.line_stage}:${line.id}`, line]));
    return entry.after.lines.map(line => ({ before: before.get(`${line.line_stage}:${line.id}`), after: line }));
  });
  return { orders: manifest.entries.length,
    changedOrders: manifest.entries.filter(entry => imageHash(entry.before, entry) !== imageHash(entry.after, entry) || entry.addCompletion).length,
    insertedLines: rows.filter(row => !row.before).length, changedLines: rows.filter(row => !row.before || digest(row.before) !== digest(row.after)).length,
    quantityCorrections: rows.filter(row => row.before && Number(row.before.quantity) !== Number(row.after.quantity)).length,
    reactivatedLines: rows.filter(row => row.before && !row.before.netsuite_active && row.after.netsuite_active).length,
    retiredLines: rows.filter(row => row.before?.netsuite_active && !row.after.netsuite_active).length,
    loaded: manifest.entries.filter(entry => entry.after.order.outbound_operator_status === "loaded").length,
    received: manifest.entries.filter(entry => entry.after.order.receiving_status === "received").length,
    localDelivery: manifest.entries.filter(entry => entry.guard.locallyCompleted).length,
    netsuiteOnly: manifest.entries.filter(entry => !entry.guard.locallyCompleted).length,
    newCompletions: manifest.entries.filter(entry => entry.addCompletion).length };
}

async function lockCorrection(manifest) {
  await query("SET LOCAL lock_timeout='3s'"); await query("SET LOCAL statement_timeout='60s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
  for (const id of manifest.entries.map(entry => entry.id).sort()) {await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${id}`]);}
  await query(`LOCK TABLE transfer_orders,transfer_order_lines,dispatch_scm_to_splits,scm_reconciliation_order_state,
    scm_transport_schedule,operator_consolidated_load_claims,operator_netsuite_posting_order_claims,dispatch_order_completion_events,
    receiving_receipt_records,operator_netsuite_posting_commands,driver_job_records IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
}

function revalidate(manifest, before) {
  const fresh = createConflictManifest(before, manifest.remote), byId = new Map(fresh.entries.map(entry => [entry.id, entry])), pending = [];
  for (const entry of manifest.entries) {
    const current = byId.get(entry.id);
    assert(current, `TO became restricted: ${entry.ref}`);
    assert.equal(digest(current.guard), digest(entry.guard), `TO supporting evidence changed: ${entry.ref}`);
    assert.equal(imageHash(current.after, entry), imageHash(entry.after, entry), `TO projected result changed: ${entry.ref}`);
    assert([imageHash(entry.before, entry), imageHash(entry.after, entry)].includes(imageHash(current.before, entry)), `TO before-image stale: ${entry.ref}`);
    if (imageHash(current.before, entry) !== imageHash(current.after, entry) || current.addCompletion) {pending.push(current);}
  }
  return pending;
}

async function writeLines(pending) {
  const updates = [], inserts = [];
  for (const entry of pending) {
    const before = new Map(entry.before.lines.map(line => [`${line.line_stage}:${line.id}`, line]));
    for (const line of entry.after.lines) {
      if (String(line.id).startsWith("new:")) {inserts.push(line);}
      else if (digest(before.get(`${line.line_stage}:${line.id}`)) !== digest(line)) {updates.push(line);}
    }
  }
  const fields = [...new Set(authoritativeLineFields)];
  await query(`UPDATE transfer_order_lines t SET ${fields.map(field => `${field}=v.${field}`).join(",")}
    FROM jsonb_populate_recordset(NULL::transfer_order_lines,$1::jsonb) v
    WHERE t.line_stage=v.line_stage AND t.id=v.id AND t.transfer_order_id=v.transfer_order_id`, [JSON.stringify(updates)]);
  const insertedIds = new Map();
  for (const line of inserts) {
    const record = { ...line }; delete record.id;
    const insertFields = Object.keys(record);
    const result = await query(`INSERT INTO transfer_order_lines(id,${insertFields.join(",")})
      SELECT nextval('canonical_order_line_id_seq'),${insertFields.map(field => `v.${field}`).join(",")}
      FROM jsonb_populate_record(NULL::transfer_order_lines,$1::jsonb) v RETURNING id`, [JSON.stringify(record)]);
    insertedIds.set(line.id, String(result.rows[0].id));
  }
  return { updated: updates.length, inserted: inserts.length, insertedIds };
}

async function writeHeadersAndObservations(pending, manifest) {
  await query(`UPDATE transfer_orders t SET outbound_operator_status=v.outbound_operator_status,local_yard_order_status=v.local_yard_order_status,
    receiving_status=v.receiving_status,status=v.status,status_text=v.status_text
    FROM jsonb_populate_recordset(NULL::transfer_orders,$1::jsonb) v WHERE t.netsuite_id=v.netsuite_id`, [JSON.stringify(pending.map(entry => entry.after.order))]);
  const observations = pending.filter(entry => entry.addCompletion), hash = digest(manifest);
  await query(`INSERT INTO dispatch_order_completion_events
    (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,reason,metadata)
    SELECT 'TO',v->>'ref',$2::timestamptz,'netsuite_fulfillment','to-conflict-cleanup:' || $3 || ':' || (v->>'id'),'system',
      'TO conflict cleanup: current NetSuite fulfillment is authoritative; physical delivery time is unknown.',
      jsonb_build_object('cleanupManifestSha256',$3,'observedAt',$2,'physicalDeliveryAt',NULL,'netsuiteEvidence',v->'evidence')
    FROM jsonb_array_elements($1::jsonb) v`, [JSON.stringify(observations), manifest.remote.completedAt, hash]);
  return observations.length;
}

function assertResult(before, after, pending, insertedIds) {
  const changedIds = new Set(pending.map(entry => entry.id));
  const expectedOrders = new Map(pending.map(entry => [entry.id, entry.after.order]));
  assert.deepEqual(after.orders, before.orders.map(row => expectedOrders.get(String(row.netsuite_id)) || row), "Unexpected TO header mutation");
  const expectedLines = [...before.lines.filter(line => !changedIds.has(String(line.transfer_order_id))),
    ...pending.flatMap(entry => entry.after.lines.map(line => ({ ...line, id: insertedIds.get(line.id) || line.id })))];
  const sorted = lines => [...lines].sort((a, b) => `${a.line_stage}:${a.id}`.localeCompare(`${b.line_stage}:${b.id}`));
  assert.deepEqual(sorted(after.lines), sorted(expectedLines), "Unexpected TO line or stage mutation");
  assert.deepEqual(after.protected, before.protected, "Protected Driver, receipt, posting, dependency, CO or plan state changed");
  assert.deepEqual(after.reconciliation, before.reconciliation); assert.deepEqual(after.schedules, before.schedules);
  assert.deepEqual(after.splits, before.splits); assert.deepEqual(after.claims, before.claims);
}

export async function applyConflictManifest(manifest, { rollback = false } = {}) {
  assert.equal(manifest.version, 1); assert.equal(manifest.kind, "authoritative-transfer-conflict-cleanup");
  assert.deepEqual(conflictSourceHashes(), manifest.sourceHashes, "Runtime or cleanup source changed; rehearse again");
  const age = Date.now() - Date.parse(manifest.remote.completedAt);
  assert(Number.isFinite(age) && age >= -60000 && age <= 90 * 60000, "NetSuite proof expired");
  return withTransaction(async () => {
    await lockCorrection(manifest);
    const before = await readTransferCleanupState(), pending = revalidate(manifest, before);
    const lines = await writeLines(pending), addedCompletions = await writeHeadersAndObservations(pending, manifest);
    const after = await readTransferCleanupState();
    assertResult(before, after, pending, lines.insertedIds);
    return { mode: rollback ? "transaction-rollback-rehearsal" : "applied", manifestSha256: digest(manifest), completedAt: new Date().toISOString(),
      changedOrders: pending.length, changedLines: lines.updated, insertedLines: lines.inserted, addedCompletions, protectedStateUnchanged: true };
  }, { rollback });
}
