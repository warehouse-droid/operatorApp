// @ts-check
export const EXISTING_PICKUP_IF_STRATEGY = 'verified_pickup_if_v1';

/** @param {string} message */
export function pickupEvidenceError(message) {
  return Object.assign(new Error(`${message} Existing fulfillment could not be verified; review the order before confirming pickup.`), {
    status: 409, code: 'OPERATOR_PICKUP_EXISTING_IF_UNVERIFIED'
  });
}
/** @param {any} value */
function id(value) { return Number(value?.id ?? value); }
/** @param {any} value */
function positiveId(value) { return Number.isSafeInteger(id(value)) && id(value) > 0; }
/** @param {any} value */
function positive(value) { return Number.isFinite(Number(value)) && Number(value) > 0; }
/** @param {any} left @param {any} right */
function equalQuantity(left, right) { return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) <= 0.000001; }
/** @param {any} value */
function label(value) { return String(value?.refName ?? value ?? '').trim().toUpperCase(); }
/** @param {boolean[]} checks @param {string} message */
function requireEvidence(checks, message) {
  if (checks.some(valid => !valid)) { throw pickupEvidenceError(message); }
}
/** @param {any[]} rows @param {(row: any) => boolean} matches @param {string} subject */
function only(rows, matches, subject) {
  const selected = rows.filter(matches);
  if (selected.length !== 1) { throw pickupEvidenceError(`${subject} has no unique match.`); }
  return selected[0];
}

/** @param {any} e @param {any} selected */
function sourceLine(e, selected) {
  const local = only(e.order.lines || [], row => String(row.line_id) === String(selected.orderLine), 'Local pickup line');
  const source = only(e.sourceItems || [], row => String(row.lineUniqueKey) === String(local.line_id), 'Stable NetSuite source line');
  const location = id(selected.location);
  const itemType = source.itemType?.id ?? source.itemType;
  requireEvidence([
    ['InvtPart', 'NonInvtPart'].includes(itemType), local.netsuite_active !== false,
    positiveId(source.line), positiveId(source.item), id(source.item) === Number(local.item_id),
    positiveId(location), id(source.location) === location, id(local.location_id ?? e.order.outbound_location_id) === location
  ], 'Source item, inventory location or line identity differs.');
  const loaded = Number(local.loaded_qty ?? 0);
  requireEvidence([positive(source.quantity), positive(selected.quantity), Number.isFinite(loaded), loaded >= 0,
    loaded + Number(selected.quantity) <= Number(source.quantity) + 0.000001],
  'The confirmed quantity exceeds the remaining local pickup quantity.');
  return { local, source, location };
}

/** @param {any} record @param {any} link @param {any} e */
function verifyRecord(record, link, e) {
  const type = label(record.transactionType ?? record.type ?? 'ItemFulfillment');
  const invalidStatus = /VOID|CANCEL|REJECT/u.test(label(record.status ?? record.shipStatus));
  requireEvidence([
    ['ITEMFULFILLMENT', 'ITEMSHIP', 'IF'].includes(type), !invalidStatus,
    !['TRUE', 'T', 'YES', '1'].includes(label(record.voided ?? record.isVoid)),
    id(record.id) === Number(link.transactionId), id(record.createdFrom ?? record.createdfrom) === Number(e.sourceNetSuiteId),
    String(record.tranId ?? record.tranid) === String(link.transactionRef)
  ], 'The linked IF record has a different identity or is not valid.');
}

/** @param {any} link @param {any} context @param {any} e */
function verifyLinkIdentity(link, context, e) {
  const { local, source, location } = context;
  requireEvidence([
    Number(link.sourceOrderId) === Number(e.sourceNetSuiteId), link.sourceRecordType === 'SalesOrd',
    String(link.sourceOrderRef) === String(e.sourceOrderRef), Number(link.sourceOrderLine) === Number(source.line),
    String(link.sourceLineKey) === String(local.line_id), Number(link.itemId) === Number(local.item_id),
    Number(link.locationId) === location, link.transactionType === 'ItemShip',
    label(link.statusText).replace(/\s*:\s*/gu, ':') === 'ITEM FULFILLMENT:SHIPPED',
    positiveId(link.transactionId), Boolean(String(link.transactionRef || '').trim()), positive(link.quantity)
  ], 'The linked fulfillment is not an exact shipped source-line match.');
}

/** @param {any} item @param {any} link @param {any} context */
function verifyIFItem(item, link, { local, source, location }) {
  requireEvidence([
    item.itemReceive !== false, id(item.item) === Number(local.item_id), id(item.location) === location,
    positive(item.quantity), equalQuantity(item.quantity, link.quantity),
    String(item.units ?? '') === String(source.units ?? ''), Boolean(String(source.units ?? '').trim()),
    Boolean(label(local.unit)), label(item.unitsDisplay) === label(local.unit), label(link.unit) === label(local.unit)
  ], 'Existing IF item, quantity, unit or inventory location differs.');
}

/** @param {any} link @param {any} context @param {any} e */
function verifyLink(link, context, e) {
  verifyLinkIdentity(link, context, e);
  const record = only(e.records || [], row => row && Number(row.id) === Number(link.transactionId), 'Existing IF record');
  verifyRecord(record, link, e);
  const item = only(record.item?.items || [], row => Number(row.orderLine) === Number(context.source.line), 'Existing IF source line');
  verifyIFItem(item, link, context);
  return { id: Number(link.transactionId), ref: String(link.transactionRef), type: 'IF', quantity: Number(item.quantity) };
}

/** @param {any} e @param {any} selected */
function reconcileLine(e, selected) {
  const context = sourceLine(e, selected);
  const links = (e.links || []).filter((/** @type {any} */ row) => String(row.sourceLineKey) === String(context.local.line_id));
  const transactions = new Map();
  for (const link of links) {
    const verified = verifyLink(link, context, e);
    // Each link must agree with the same uniquely read IF record before deduplication.
    transactions.set(verified.id, verified);
  }
  const linkedTransactions = [...transactions.values()].sort((a, b) => a.id - b.id);
  const completed = linkedTransactions.reduce((sum, transaction) => sum + transaction.quantity, 0);
  if (!linkedTransactions.length || !equalQuantity(completed, context.source.quantity)) {
    throw pickupEvidenceError('Existing shipped IFs do not exactly cover the source-line quantity.');
  }
  return { sourceLineKey: String(context.local.line_id), sourceLineAliases: [String(context.local.line_id)],
    orderLine: Number(context.source.line), itemId: Number(context.local.item_id), location: context.location,
    orderedQuantity: Number(context.source.quantity), completedQuantity: Number(completed.toFixed(6)), remainingQuantity: 0, linkedTransactions };
}

/** @param {any} evidence */
export function resolvePickupExistingFulfillment(evidence) {
  if (!positiveId(evidence.sourceNetSuiteId) || !String(evidence.sourceOrderRef || '').trim()
      || !Array.isArray(evidence.selectedItems) || !evidence.selectedItems.length) {
    throw pickupEvidenceError('A source SO and confirmed pickup lines are required.');
  }
  const availableLines = evidence.selectedItems.map((/** @type {any} */ item) => reconcileLine(evidence, item));
  if (new Set(availableLines.map((/** @type {any} */ line) => line.orderLine)).size !== availableLines.length) {
    throw pickupEvidenceError('Confirmed source lines are ambiguous.');
  }
  return { postingStrategy: EXISTING_PICKUP_IF_STRATEGY, sourceOrderKind: 'SO', sourceNetSuiteId: Number(evidence.sourceNetSuiteId),
    sourceOrderRef: String(evidence.sourceOrderRef), availableLines };
}

/** @param {any} command @param {any[]} lines */
function assertPickupCommand(command, lines) {
  if (command.functionKey !== 'customer_pickup' || command.transactionType !== 'IF' || command.steps?.length || !lines.length) {
    throw pickupEvidenceError('Existing pickup evidence cannot create a posting step.');
  }
}
/** @param {any} line */
function assertReconciledPickupLine(line) {
  requireEvidence([line.authoritative === true, line.postedQuantity === 0, positive(line.reconciledQuantity),
    equalQuantity(line.requestedQuantity, line.reconciledQuantity), Boolean(line.linkedTransactions?.length)],
  'Pickup completion requires fully reconciled line evidence.');
}
/** @param {Map<string, any>} transactions @param {any} linked @param {any} line */
function mergePickupTransaction(transactions, linked, line) {
  requireEvidence([linked.type === 'IF', positiveId(linked.id), Boolean(String(linked.ref || '').trim())], 'The IF reference is invalid.');
  const key = `${line.sourceNetSuiteId}:${linked.id}`;
  const previous = transactions.get(key);
  if (previous && previous.transactionRef !== linked.ref) { throw pickupEvidenceError('IF references conflict.'); }
  transactions.set(key, { transactionType: 'IF', sourceOrderKind: 'SO', sourceNetSuiteId: Number(line.sourceNetSuiteId),
    sourceOrderRef: String(line.sourceOrderRef), transactionId: Number(linked.id), transactionRef: linked.ref, reused: true,
    inventoryLocationIds: [...new Set([...(previous?.inventoryLocationIds || []), Number(line.location)])].sort((a, b) => a - b) });
}
/** @param {any} command */
export function pickupExistingFulfillmentTransactions(command) {
  if (command.inputSnapshot?.postingStrategy !== EXISTING_PICKUP_IF_STRATEGY) { return []; }
  const transactions = new Map();
  const lines = command.inputSnapshot.lineReconciliation?.lines || [];
  assertPickupCommand(command, lines);
  for (const line of lines) {
    assertReconciledPickupLine(line);
    for (const linked of line.linkedTransactions) { mergePickupTransaction(transactions, linked, line); }
  }
  return [...transactions.values()].sort((a, b) => a.transactionId - b.transactionId);
}
