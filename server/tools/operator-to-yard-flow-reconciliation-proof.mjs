import { verifyOperatorNetSuitePostingRecord } from '../src/operator-netsuite-posting-adapter.js';
import { transferPostingOrderLine } from '../src/netsuite-transfer-posting-line.js';

const proofUnit = value => String(value || '').trim().toUpperCase();
function proofSelectedLines(job, source, localLines) {
  if (!job.snapshot.lines?.length) {throw new Error('The saved posting has no lines.');}
  return job.snapshot.lines.map(saved => {
    if (!Number.isFinite(Number(saved.quantity)) || Number(saved.quantity) <= 0) {throw new Error('The saved posting quantity is invalid.');}
    const stage = job.transaction_type === 'IF' ? 'outbound' : 'receiving';
    const matches = source.lines.filter(line => line.stage === stage && line.identityStatus === 'exact'
      && Number(line.itemId) === Number(saved.itemId)
      && [line.sourceLineKey, ...(line.sourceLineAliases || [])].map(String).includes(String(saved.sourceLineKey)));
    const local = localLines.filter(line => String(line.id) === String(saved.lineId)
      && String(line.line_id) === String(saved.sourceLineKey) && Number(line.item_id) === Number(saved.itemId));
    if (matches.length !== 1 || local.length !== 1 || !Number.isSafeInteger(Number(matches[0].netsuite_order_line))) {
      throw new Error('The saved posting identity is not uniquely verifiable.');
    }
    if (!proofUnit(local[0].unit) || proofUnit(local[0].unit) !== proofUnit(matches[0].unit)) {
      throw new Error('The saved posting sales unit differs from its NetSuite source.');
    }
    const orderLine = transferPostingOrderLine(matches[0], { sourceNetSuiteId: Number(source.id), stage });
    return { orderLine, itemId: Number(saved.itemId),
      quantity: Number(saved.quantity), location: null, unit: proofUnit(local[0].unit) };
  });
}

function proofTransactionLinks(entry, source, linked) {
  return linked.filter(row => row.transactionId === Number(entry.id) && row.sourceOrderId === Number(source.id)
        && row.transactionType === entry.type && !row.sourceIdentityIssue);
}

function assertProofShipped(job, record, transactionLinks) {
  if (job.transaction_type === 'IF' && (!transactionLinks.length || transactionLinks.some(row => row.status !== 'C')
    || (record.shipStatus && String(record.shipStatus.id || record.shipStatus) !== 'C'))) {throw new Error('The fulfillment is not shipped.');}
}

function assertProofItem(line, record, transactionLinks) {
  const sourceLinks = transactionLinks.filter(row => Number(row.itemId) === line.itemId
          && (row.sourceOrderLineAliases || [row.sourceOrderLine]).map(Number).includes(line.orderLine));
  if (sourceLinks.length !== 1 || Math.abs(Number(sourceLinks[0].quantity) - line.quantity) > 0.000001
          || proofUnit(sourceLinks[0].unit) !== line.unit) {throw new Error('The linked transaction line is not uniquely verified.');}
  const item = record.item?.items?.find(row => Number(row.orderLine) === line.orderLine);
  if (!item || proofUnit(item.unitsDisplay || item.units?.refName) !== line.unit) {throw new Error('The transaction sales unit differs.');}
}

function verifyExistingCandidate(job, source, entry, linked, lines) {
  const record = entry.record;
  if (!record || Number(record.id) !== Number(entry.id)) {throw new Error('The transaction identity differs.');}
  const transactionLinks = proofTransactionLinks(entry, source, linked);
  assertProofShipped(job, record, transactionLinks);
  for (const line of lines) {assertProofItem(line, record, transactionLinks);}
  return verifyOperatorNetSuitePostingRecord({ sourceOrderKind: 'TO', sourceNetSuiteId: Number(source.id),
        transactionType: job.transaction_type, externalId: record.externalId || record.externalid || '',
        lineSnapshot: lines, payload: { item: { items: lines } } }, { ...record, transactionType: job.transaction_type });
}

export function verifyExistingTransferPosting({ job, source, localLines, records, linked = [] }) {
  if (job.command_id) {throw new Error('An existing native command must use its own recovery contract.');}
  const lines = proofSelectedLines(job, source, localLines), matches = new Map(), reasons = [];
  for (const entry of records.filter(record => record.sourceId === Number(source.id)
    && record.type === (job.transaction_type === 'IF' ? 'ItemShip' : 'ItemRcpt'))) {
    try {
      const verified = verifyExistingCandidate(job, source, entry, linked, lines);
      matches.set(verified.id, verified);
    } catch (error) { reasons.push(error.message); }
  }
  if (matches.size !== 1) {throw new Error(`No uniquely verified existing transaction (${matches.size} matches). ${reasons[0] || ''}`);}
  const verified = [...matches.values()][0];
  return { reconciledExisting: true, transactions: [{ transactionType: job.transaction_type,
    sourceOrderKind: 'TO', sourceNetSuiteId: Number(source.id), sourceOrderRef: source.tranid,
    transactionId: verified.id, transactionRef: verified.transactionRef }] };
}
