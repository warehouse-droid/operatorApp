import { query, withTransaction } from '../src/db.js';
import { writeAudit } from '../src/auth-repository.js';
import { upsertInboundTransferOrderLines } from '../src/order-sync-repository.js';
import { readTransferCompletionEvents } from '../src/transfer-order-posting-repository.js';
import { transferPostingCompletion } from '../src/transfer-order-posting-domain.js';
import { planLocalYardState, receivingRowsForMissingLines } from './operator-to-yard-flow-reconciliation-plan.mjs';
import { verifyExistingTransferPosting } from './operator-to-yard-flow-reconciliation-proof.mjs';

async function readLockedTransfer(id) {
  const order = (await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1 FOR UPDATE', [id])).rows[0];
  if (!order) {throw new Error('The local Transfer Order no longer exists.');}
  const lines = (await query('SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY line_stage,id FOR UPDATE', [id])).rows;
  const loads = (await query("SELECT id,order_id,order_ref,operator_id,load_type,line_snapshot,response,created_at FROM operator_load_records WHERE order_id=$1 AND order_family='transfer_order' ORDER BY id", [id])).rows;
  const receipts = (await query('SELECT id,receipt_status,payload FROM receiving_receipt_records WHERE order_id=$1 ORDER BY id', [id])).rows;
  const jobs = (await query('SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 ORDER BY created_at,id FOR UPDATE', [id])).rows;
  const direct = (await query("SELECT id FROM order_dependencies WHERE transfer_order_id=$1 AND dependency_mode='direct_to_customer' AND status<>'cancelled'", [id])).rowCount > 0;
  return { order, lines, loads, receipts, jobs, direct };
}

function matchingRemoteHeader(order, evidence) {
  const ref = Number(order.netsuite_id) < 0 ? order.tranid.replace(/-S\d+$/u, '') : order.tranid;
  const historicalAlias = (evidence.historicalIdentityAliases || []).find(alias => String(alias.localId) === String(order.netsuite_id)
    && alias.orderRef === order.tranid && alias.sourceRecordType === 'TrnfrOrd');
  const expectedId = historicalAlias?.sourceId || order.netsuite_id;
  const matches = evidence.headers.filter(header => header.tranid === ref
    && (Number(order.netsuite_id) < 0 || String(header.id) === String(expectedId))
    && (!historicalAlias || header.status === 'G'));
  return matches.length === 1 ? matches[0] : null;
}

function verifiedReactivations(lines, source) {
  return lines.filter(local => !local.netsuite_active && source.lines.filter(line => line.stage === local.line_stage
    && line.identityStatus === 'exact' && Number(line.itemId) === Number(local.item_id)
    && [line.sourceLineKey, ...(line.sourceLineAliases || [])].map(String).includes(String(local.line_id))).length === 1);
}

async function completionForRecoveredJob(job) {
  try { return transferPostingCompletion(job, await readTransferCompletionEvents(job)); }
  catch { return null; } // Existing accounting is a fact; it supplies no missing physical evidence.
}

async function attachExistingFulfillment(job, result, event) {
  await query("UPDATE transfer_order_posting_jobs SET status='completed',last_error=NULL,result=$2::jsonb,completion_event_id=COALESCE(completion_event_id,$3),updated_at=now() WHERE id=$1 AND command_id IS NULL", [job.id, JSON.stringify(result), event?.id || null]);
  await query("UPDATE operator_load_records SET response=COALESCE(response,'{}'::jsonb)||jsonb_build_object('operatorNetSuitePosting',$2::jsonb) WHERE id=$1 AND order_id=$3", [job.operator_record_id, JSON.stringify(result), job.local_to_id]);
  const transaction = result.transactions[0];
  await query('UPDATE transfer_orders SET last_item_fulfillment_id=$2,last_item_fulfillment_tranid=$3 WHERE netsuite_id=$1', [job.local_to_id, transaction.transactionId, transaction.transactionRef]);
}

async function recoverExistingJobs(input, source, evidence, output, apply) {
  for (const job of input.jobs.filter(row => row.transaction_type === 'IF' && row.status !== 'completed')) {
    if (job.command_id) { output.issues.push(`${job.id}: immutable native command retains its recovery contract`); continue; }
    if (!evidence.records.some(record => record.type === 'ItemShip' && record.sourceId === Number(source.id))) {continue;}
    try {
      const result = verifyExistingTransferPosting({ job, source, localLines: input.lines, records: evidence.records, linked: evidence.linked || [] });
      const event = await completionForRecoveredJob(job);
      if (apply) {await attachExistingFulfillment(job, result, event);}
      output.recoveredIfJobs.push({ jobId: job.id, oldStatus: job.status, result, completionEventId: event?.id || null });
      output.writes += 1;
    } catch (error) { output.issues.push(`${job.order_ref}: ${error.message}`); }
  }
}

async function legacyLoadScope(order, load) {
  const response = load.response || {}, date = String(response.dispatchPlanDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {throw new Error('The legacy load has no saved dispatch date.');}
  const matches = (await query(`SELECT a.plan_id,a.load_id,a.plan_date::text,a.assignment FROM dispatch_plan_order_assignments a
    JOIN dispatch_plans p ON p.id=a.plan_id AND p.status<>'cancelled'
    WHERE upper(a.order_ref)=upper($1) AND a.plan_date=$2::date`, [order.tranid, date])).rows.filter(row =>
    row.assignment?.dispatchTruckPlate === response.dispatchTruckPlate && row.assignment?.dispatchLoadName === response.dispatchLoadName);
  const scopes = new Map(matches.map(row => [`${row.plan_id}:${row.load_id}`, row]));
  if (scopes.size !== 1) {throw new Error('The legacy load does not identify one matching saved truck assignment.');}
  const assignment = [...scopes.values()][0];
  return { planId: String(assignment.plan_id), loadId: assignment.load_id, planDate: date, assignmentAmbiguous: false,
    locationId: order.from_location_id, reconciliationSource: 'durable_legacy_load' };
}

function legacyLoadLines(load, lines, cumulative) {
  const selected = [];
  for (const saved of load.line_snapshot || []) {
    const quantity = Number(saved.loadedQty), key = `${saved.lineId}:${saved.itemId}`, previous = cumulative.get(key) || 0;
    if (!Number.isFinite(quantity) || quantity < 0) {throw new Error('The legacy load quantity is invalid.');}
    cumulative.set(key, Math.max(quantity, previous));
    if (quantity <= previous + 0.000001) {continue;}
    const matches = lines.filter(line => line.line_stage === 'outbound' && String(line.line_id) === String(saved.lineId) && Number(line.item_id) === Number(saved.itemId));
    if (matches.length !== 1 || String(saved.loadedUom || saved.unit).toUpperCase() !== String(matches[0].unit).toUpperCase()) {throw new Error('The legacy load item or sales unit is not unique.');}
    selected.push({ lineId: String(matches[0].id), sourceLineKey: String(matches[0].line_id), itemId: Number(saved.itemId), quantity: quantity - previous });
  }
  return selected;
}

function legacyExistingIfResult(job, source, input, evidence, output) {
  if (!(evidence.linked || []).some(row => row.sourceOrderId === Number(source.id) && row.transactionType === 'ItemShip')) {return { result: {}, status: 'waiting_receipt', lastError: null };}
  try {
    const result = verifyExistingTransferPosting({ job, source, localLines: input.lines, records: evidence.records, linked: evidence.linked });
    return { result, status: 'completed', lastError: null };
  } catch (error) {
    output.issues.push(`${job.order_ref}: ${error.message}`);
    return { result: {}, status: 'attention', lastError: error.message };
  }
}

async function captureLegacyLoads(input, source, evidence, output, apply) {
  const cumulative = new Map();
  for (const load of input.loads.filter(row => row.load_type === 'transfer_order_load')) {
    try {
      const lines = legacyLoadLines(load, input.lines, cumulative);
      if (!lines.length || input.jobs.some(job => job.transaction_type === 'IF' && String(job.operator_record_id) === String(load.id))) {continue;}
      const snapshot = { lines, ...(await legacyLoadScope(input.order, load)) };
      const job = { transaction_type: 'IF', local_to_id: input.order.netsuite_id, order_ref: input.order.tranid, operator_id: load.operator_id, operator_record_id: load.id, snapshot };
      const { result, status, lastError } = legacyExistingIfResult(job, source, input, evidence, output);
      const event = await completionForRecoveredJob(job);
      if (apply) {
        const inserted = (await query(`INSERT INTO transfer_order_posting_jobs(transaction_type,local_to_id,order_ref,operator_id,operator_record_id,snapshot,status,last_error,result,completion_event_id)
          VALUES('IF',$1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9) ON CONFLICT(transaction_type,operator_record_id) DO NOTHING RETURNING *`,
        [job.local_to_id,job.order_ref,job.operator_id,job.operator_record_id,JSON.stringify(snapshot),status,lastError,JSON.stringify(result),event?.id || null])).rows[0];
        if (!inserted) {continue;}
        if (status === 'completed') {await attachExistingFulfillment(inserted, result, event);}
      }
      output.capturedLoadJobs.push({ operatorRecordId: String(load.id), status, result }); output.writes += 1;
    } catch (error) { output.issues.push(`${input.order.tranid}: ${error.message}`); }
  }
}

async function repairOperationalState(input, source, output, apply) {
  const reactivate = verifiedReactivations(input.lines, source);
  const lines = input.lines.map(line => reactivate.some(row => row.id === line.id) ? { ...line, netsuite_active: true } : line);
  const destinations = receivingRowsForMissingLines(lines, source);
  if (destinations.issues.length) { output.kind = 'review'; output.issues.push(...destinations.issues); return null; }
  if (destinations.rows.some(row => !/^\d+$/u.test(String(row.line_id)) || !Number.isSafeInteger(Number(row.line_id)) || Number(row.line_id) <= 0)) {throw new Error('The destination line identity must be a positive bigint integer.');}
  const planningLines = [...lines, ...destinations.rows.map(row => ({ ...row, id: `planned-${row.line_id}`, line_stage: 'receiving', netsuite_active: true }))];
  const plan = planLocalYardState({ ...input, lines: planningLines });
  if (plan.issues.length) { output.kind = 'review'; output.issues.push(...plan.issues); return null; }
  if (apply && destinations.rows.length) {await upsertInboundTransferOrderLines(input.order.netsuite_id, destinations.rows);}
  for (const row of reactivate) {if (apply) {await query("UPDATE transfer_order_lines SET netsuite_active=true,sync_exception=CASE WHEN sync_exception='line_deleted' THEN NULL ELSE sync_exception END WHERE id=$1 AND transfer_order_id=$2", [row.id, input.order.netsuite_id]);}}
  for (const change of plan.changes) {if (apply) {await query("UPDATE transfer_order_lines SET loaded_qty=$2,loaded_uom=$3 WHERE id=$1 AND transfer_order_id=$4 AND line_stage='outbound'", [change.id, change.loaded_qty, change.loaded_uom, input.order.netsuite_id]);}}
  output.changedLines = plan.changes.length; output.lineChanges = plan.changes;
  output.addedReceivingLines = destinations.rows.length; output.reactivatedLines = reactivate.length;
  output.writes += plan.changes.length + destinations.rows.length + reactivate.length;
  return plan.header;
}

async function applyHeader(order, header, local, output, apply) {
  const next = { status: header.status, status_text: header.status_text, ...(local || {}) };
  const changed = Object.keys(next).filter(key => (order[key] ?? null) !== (next[key] ?? null));
  output.changedHeader = changed.length > 0; output.headerChanges = Object.fromEntries(changed.map(key => [key, { before: order[key] ?? null, after: next[key] ?? null }]));
  if (!changed.length) {return;}
  if (apply) {await query(`UPDATE transfer_orders SET ${changed.map((key, i) => `${key}=$${i + 2}`).join(',')},status_updated_at=now(),synced_at=now() WHERE netsuite_id=$1`, [order.netsuite_id, ...changed.map(key => next[key])]);}
  output.writes += 1;
}

function reconciledTransferKind(header, input) {
  return header.status === 'G' ? 'historical_completed' : header.status === 'H' ? 'closed' : input.direct ? 'direct_to_customer' : 'operational';
}

export async function reconcileTransferOrder(id, evidence, { apply = false } = {}) {
  return withTransaction(async () => {
    await query("SET LOCAL lock_timeout='3s'");
    const input = await readLockedTransfer(id), header = matchingRemoteHeader(input.order, evidence);
    const output = { localToId: String(id), orderRef: input.order.tranid, kind: 'review', writes: 0, changedLines: 0, addedReceivingLines: 0, reactivatedLines: 0, changedHeader: false, recoveredIfJobs: [], capturedLoadJobs: [], issues: [], applied: apply };
    if (!header) { output.issues.push('The NetSuite parent identity could not be uniquely verified.'); return output; }
    output.parentId = String(header.id);
    const source = evidence.sources.find(row => String(row.id) === String(header.id) && row.tranid === header.tranid);
    output.kind = reconciledTransferKind(header, input);
    if (source) {await recoverExistingJobs(input, source, evidence, output, apply);}
    let local = output.kind === 'historical_completed' ? { outbound_operator_status: 'loaded', receiving_status: 'received' } : null;
    if (output.kind === 'operational') {
      if (!source) { output.issues.push('The active NetSuite line evidence is missing.'); output.kind = 'review'; return output; }
      local = await repairOperationalState(input, source, output, apply);
      if (output.kind === 'operational') {await captureLegacyLoads(input, source, evidence, output, apply);}
      if (!input.receipts.length && source.lines.some(line => line.stage === 'receiving' && Number(line.cumulativeProgressQuantity) > 0)) {output.issues.push('Prior NetSuite receipt progress has no local yard receipt; accounting quantities require review before any new IR.');}
    }
    await applyHeader(input.order, header, local, output, apply);
    if (apply && output.writes) {await writeAudit({ actorType: 'system', source: 'admin', action: 'operator.to.reconcile', orderId: id,
      details: { request: 'deploy and reconciliation all TO', historicalPreference: 'keep_completion', netSuiteEvidenceAt: evidence.at, netSuiteWrites: 0, ...output } });}
    return output;
  });
}

function legacyShipmentJob(input, source, record) {
  const selected = (record.item?.items || []).filter(item => item.itemReceive !== false && Number(item.quantity) > 0);
  const lines = selected.map(item => {
    const matches = source.lines.filter(line => line.stage === 'outbound' && line.identityStatus === 'exact'
      && Number(line.itemId) === Number(item.item?.id) && (line.orderLineAliases || [line.orderLine]).map(Number).includes(Number(item.orderLine)));
    if (matches.length !== 1) {throw new Error('The legacy shipment source line is not unique.');}
    const sourceLine = matches[0];
    const local = input.lines.filter(line => line.line_stage === 'outbound' && Number(line.item_id) === Number(sourceLine.itemId)
      && [sourceLine.sourceLineKey, ...(sourceLine.sourceLineAliases || [])].map(String).includes(String(line.line_id)));
    if (local.length !== 1) {throw new Error('The legacy shipment local line is not unique.');}
    return { lineId: String(local[0].id), sourceLineKey: String(local[0].line_id), itemId: Number(sourceLine.itemId), quantity: Number(item.quantity) };
  });
  return { transaction_type: 'IF', snapshot: { lines } };
}

function verifiedLegacyShipmentEvidence(input, source, evidence) {
    const quantities = new Map(), acceptedTransactions = [];
    for (const entry of evidence.records.filter(row => row.sourceId === Number(source.id) && row.type === 'ItemShip')) {
      const job = legacyShipmentJob(input, source, entry.record);
      const result = verifyExistingTransferPosting({ job, source, localLines: input.lines, records: [entry], linked: evidence.linked });
      acceptedTransactions.push(...result.transactions);
      for (const line of job.snapshot.lines) {
        const key = `${line.sourceLineKey}:${line.itemId}`, existing = quantities.get(key);
        const local = input.lines.find(row => String(row.id) === line.lineId);
        quantities.set(key, { sourceLineKey: line.sourceLineKey, itemId: line.itemId, unit: local.unit,
          quantity: (existing?.quantity || 0) + line.quantity });
      }
    }
    if (!quantities.size) {throw new Error('No verified shipped quantity is available for legacy Receiving.');}
    return { acceptedTransactions, verifiedLoadLines: [...quantities.values()] };
}

export async function enableLegacyTransferReceiving(id, evidence) {
  return withTransaction(async () => {
    const input = await readLockedTransfer(id), header = matchingRemoteHeader(input.order, evidence);
    if (!header || ['G', 'H'].includes(header.status) || input.direct) {throw new Error('The legacy Receiving exception requires an active ordinary transfer.');}
    const source = evidence.sources.find(row => String(row.id) === String(header.id) && row.tranid === header.tranid);
    if (!source) {throw new Error('The legacy transfer source evidence is missing.');}
    const accepted = verifiedLegacyShipmentEvidence(input, source, evidence);
    const existing = (await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='operator.to.legacy_receiving_enabled'", [id])).rows;
    if (!existing.length) {await writeAudit({ actorType: 'system', source: 'admin', action: 'operator.to.legacy_receiving_enabled', orderId: id,
      details: { orderRef: input.order.tranid, sourceNetSuiteId: Number(source.id), ...accepted,
        authorization: 'User requested these two partially received TOs in the receiving yard module', netSuiteEvidenceAt: evidence.at, netSuiteWrites: 0 } });}
    return { orderRef: input.order.tranid, destinationLocationId: input.order.to_location_id, created: !existing.length,
      ...accepted, netSuiteWrites: 0 };
  });
}
