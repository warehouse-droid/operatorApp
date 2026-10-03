import { pool, query, withTransaction } from './db.js';
import { config } from './config.js';
import { getScmStockRequest, normalizePickupStockRequestDraft, savePickupStockRequestDraft,
  convertSalesStockRequestLines, recordStockRequestEvent } from './stock-request-repository.js';
import { confirmAndPrintStockTransfer, refreshStockRequestItemsAvailability } from './stock-request-service.js';
import { createTransferOrderInNetSuite } from './netsuite.js';
import { regularStockPolicies } from './regular-stock-request-service.js';
import { regularError, evaluateRegularStockApproval, isRegularStockingRequest } from './regular-stock-domain.js';
import { groupStockRequestLinesForTransfer, stockRequestPalletQuantity, STOCK_REQUEST_MAX_QUANTITY } from './stock-request-domain.js';
import { regularStockConfirmationToken } from './regular-stock-confirmation.js';

const fingerprint = (id, input) => regularStockConfirmationToken(id, { lines: input.lines, palletQuantities: input.palletQuantities || {} });
const issued = transfer => !!transfer?.netsuiteTransferOrderId
  && ['pending_fulfillment', 'partially_fulfilled', 'pending_receipt', 'received', 'closed'].includes(transfer.status);

function requirePickup(request) {
  if (request.workflowVersion !== 2 || !isRegularStockingRequest(request) || request.regular.stockingType === 'purchase' || request.regular.handoffStatus) {
    throw regularError('Only Stocking requests without an existing SO action can be converted by SCM.', 'REGULAR_PICKUP_REQUIRED');
  }
}

function requireRevision(request, input) {
  if (!Number.isSafeInteger(Number(input.expectedRevision)) || Number(input.expectedRevision) !== request.revision) {
    throw regularError('This request changed. Reload and review it again.', 'STOCK_REQUEST_REVISION_CONFLICT');
  }
  if (!request.lines.some(line => ['submitted', 'approved'].includes(line.status)) || request.transfers.length) {
    throw regularError('This request has no items available for a new Stocking conversion.');
  }
}

function requireConfirmation(id, plan, token) {
  if (!token) throw regularError('Review and confirm the Transfer Orders before proceeding.', 'REGULAR_CONFIRMATION_REQUIRED');
  if (token !== regularStockConfirmationToken(id, plan)) {
    throw regularError('The items, quantities or transfer routes changed. Review the updated action and confirm again.', 'REGULAR_CONFIRMATION_CHANGED');
  }
}

function savedPreview(request, input) {
  const saved = request.regular.pickupTransfer;
  if (input.lines !== undefined && fingerprint(request.id, input) !== saved.inputFingerprint) {
    throw regularError('TO creation has already started. Resume the saved quantities and routes.', 'REGULAR_PICKUP_LOCKED');
  }
  return { action: saved.plan.action, lines: saved.plan.lines, evidence: saved.evidence,
    confirmationToken: regularStockConfirmationToken(request.id, saved.plan), resuming: true };
}

function pickupPlan(request, lines, input) {
  const routes = groupStockRequestLinesForTransfer(lines).map(group => {
    const pallet = stockRequestPalletQuantity(group.lines);
    const value = input.palletQuantities?.[group.sourceLocationId];
    if ((value === undefined || value === null || value === '') && pallet.requiresManualQuantity) {
      throw regularError(`Enter the PALLET quantity for source ${group.lines[0].sourceName}.`, 'REGULAR_PICKUP_PALLETS_REQUIRED', 400);
    }
    const quantity = value === undefined ? pallet.automaticQuantity : Number(value);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > STOCK_REQUEST_MAX_QUANTITY) {
      throw regularError('PALLET quantities must be finite, non-negative numbers within the quantity limit.', 'REGULAR_PICKUP_PALLETS_INVALID', 400);
    }
    return { sourceLocationId: group.sourceLocationId, sourceName: group.lines[0].sourceName,
      destinationLocationId: request.destinationLocationId, destinationName: request.destinationName,
      palletQuantity: quantity, items: group.lines.map(line => ({ itemName: line.itemName, quantity: line.salesQty, unit: line.salesUom })) };
  });
  return { revision: request.revision, lines,
    action: { mode: 'pickup', requestRef: request.requestRef, destinationName: request.destinationName, routes } };
}

async function prepare(request, input, dependencies) {
  requireRevision(request, input);
  const lines = await normalizePickupStockRequestDraft(request, input);
  const itemIds = [...new Set(lines.map(line => line.itemId))];
  await (dependencies.refreshAvailability || refreshStockRequestItemsAvailability)(itemIds);
  const normalized = await normalizePickupStockRequestDraft(request, input);
  const policies = await (dependencies.loadPolicies || regularStockPolicies)(itemIds);
  const evidence = evaluateRegularStockApproval({ lines: normalized, policies, deliveryMethod: 'stocking',
    arrivalAt: request.regular.arrivalAt, leadHours: request.regular.approval.leadHours,
    now: (dependencies.now || (() => new Date()))() });
  return { plan: pickupPlan(request, normalized, input), evidence };
}

export async function previewPickupStockTransfers(id, input, _context, dependencies = {}) {
  const request = await getScmStockRequest(id);
  requirePickup(request);
  if (request.regular.pickupTransfer) return savedPreview(request, input);
  const { plan, evidence } = await prepare(request, input, dependencies);
  return { action: plan.action, lines: plan.lines, evidence, confirmationToken: regularStockConfirmationToken(id, plan), resuming: false };
}

async function saveState(id, state) {
  await query(`UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{pickupTransfer}',$2::jsonb),
    revision=revision+1,updated_at=now() WHERE id=$1`, [id, JSON.stringify(state)]);
}

async function claim(request, input, context, dependencies) {
  const prepared = await prepare(request, input, dependencies);
  requireConfirmation(request.id, prepared.plan, input.confirmationToken);
  return withTransaction(async () => {
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE', [request.id]);
    const current = await getScmStockRequest(request.id);
    requirePickup(current);
    requireRevision(current, input);
    const normalized = await normalizePickupStockRequestDraft(current, input);
    const plan = pickupPlan(current, normalized, input);
    requireConfirmation(current.id, plan, input.confirmationToken);
    const lines = await savePickupStockRequestDraft(current, normalized, context.operatorId);
    const evidence = { ...prepared.evidence, lines: prepared.evidence.lines.map((entry, index) => ({ ...entry, lineId: lines[index].id })) };
    for (const entry of evidence.lines) await query('UPDATE sales_stock_request_lines SET approval_evidence=$2::jsonb WHERE id=$1', [entry.lineId, JSON.stringify(entry)]);
    const event = await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
      VALUES($1,'regular_manual_decision',$2,$3::jsonb) RETURNING id`, [current.id, context.operatorId,
      JSON.stringify({ decision: 'stock', reason: 'SCM Stocking conversion', before: current.lines, after: lines, evidence })]);
    const startedAt = new Date().toISOString();
    await query(`UPDATE sales_stock_requests SET manual_decision_event_id=$2,regular_details=regular_details||$3::jsonb WHERE id=$1`,
      [current.id, event.rows[0].id, JSON.stringify({ approvedAt: startedAt, approvalExpiresAt: null })]);
    const converted = await convertSalesStockRequestLines(current.id,
      { expectedRevision: current.revision, lineIds: lines.map(line => line.id) }, { ...context, approvedHandoff: true });
    for (const transfer of converted.transfers) {
      const route = plan.action.routes.find(entry => entry.sourceLocationId === transfer.sourceLocationId);
      await query(`UPDATE sales_stock_transfers SET pallet_quantity=$2,pallet_quantity_manually_adjusted=true WHERE id=$1`, [transfer.id, route.palletQuantity]);
    }
    const state = { status: 'executing', startedAt, plan, evidence, inputFingerprint: fingerprint(current.id, input),
      transferIds: converted.transfers.map(transfer => transfer.id), error: null };
    await saveState(current.id, state);
    return state;
  });
}

async function issueTransfers(id, state, context, dependencies) {
  const confirm = dependencies.confirmTransfer || (transfer => confirmAndPrintStockTransfer(transfer.id,
    { expectedRevision: transfer.revision, requestId: `regular-pickup:${id}:${transfer.id}` }, { id: context.operatorId },
    { ensurePrinter: async () => {}, createRemote: (payload, options) => createTransferOrderInNetSuite(
      { ...payload, externalId: `MBBS_REGULAR_PICKUP_${id}_${transfer.id}` }, options) }));
  for (const transferId of state.transferIds) {
    const transfer = (await getScmStockRequest(id)).transfers.find(entry => entry.id === transferId);
    if (issued(transfer)) continue;
    try { await confirm(transfer); } catch (error) {
      // Print failures do not undo a committed TO. Recover the durable NetSuite result.
      const saved = (await getScmStockRequest(id)).transfers.find(entry => entry.id === transferId);
      if (!issued(saved)) throw error;
    }
    const saved = (await getScmStockRequest(id)).transfers.find(entry => entry.id === transferId);
    if (!issued(saved)) throw regularError('NetSuite has not confirmed this TO. Retry to recover its status.', 'REGULAR_PICKUP_UNCONFIRMED');
  }
}

async function execute(id, input, context, dependencies) {
  const request = await getScmStockRequest(id);
  requirePickup(request);
  let state = request.regular.pickupTransfer;
  if (state) {
    savedPreview(request, input);
    requireConfirmation(id, state.plan, input.confirmationToken);
    if (state.status === 'complete') return request;
  }
  if (!(dependencies.liveExecutionEnabled ?? config.smartScm.liveExecutionEnabled)) throw regularError('Live NetSuite execution is disabled.', 'REGULAR_LIVE_DISABLED');
  state = state || await claim(request, input, context, dependencies);
  try {
    await saveState(id, { ...state, status: 'executing', error: null });
    await issueTransfers(id, state, context, dependencies);
    await (dependencies.refreshAvailability || refreshStockRequestItemsAvailability)([...new Set(state.plan.lines.map(line => line.itemId))]);
    await withTransaction(async () => {
      await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE', [id]);
      const completed = await getScmStockRequest(id);
      const transfers = completed.transfers.map(transfer => ({ reference: transfer.netsuiteTransferOrderRef,
        sourceName: transfer.sourceName, destinationName: transfer.destinationName }));
      const result = { ...state, status: 'complete', error: null, completedAt: new Date().toISOString(), transfers };
      await saveState(id, result);
      await recordStockRequestEvent({ requestId: Number(id), eventType: 'regular_pickup_to_complete', actorId: context.operatorId,
        details: { action: state.plan.action, transfers, completedAt: result.completedAt } });
    });
    return getScmStockRequest(id);
  } catch (error) {
    await saveState(id, { ...state, status: 'attention', error: String(error.message).slice(0, 1000) });
    throw error;
  }
}

export async function convertPickupStockTransfers(id, input, context, dependencies = {}) {
  const client = await pool.connect();
  const key = `regular-stock-pickup:${Number(id)}`;
  let acquired = false;
  try {
    acquired = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [key])).rows[0].acquired;
    if (!acquired) throw regularError('This Stocking conversion is already running. Refresh to see its progress.', 'REGULAR_PICKUP_RUNNING');
    return await execute(id, input, context, dependencies);
  } finally {
    if (acquired) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => {});
    client.release();
  }
}
