// Operational NetSuite reads only; no transform/update function is imported.
import { query, closeDb } from '../src/db.js';
import { fetchPoToReconciliationOrdersFromNetSuite, fetchPoToLinkedTransactionsFromNetSuite,
  fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite, suiteqlAll } from '../src/netsuite.js';

try {
  const local = (await query('SELECT netsuite_id,tranid,outbound_operator_status,receiving_status,status FROM transfer_orders ORDER BY netsuite_id')).rows;
  const ids = local.map(order => Number(order.netsuite_id)).filter(id => Number.isSafeInteger(id) && id > 0);
  const checkpoint = globalThis.operatorToYardResumeEvidence || {};
  const sources = [...(checkpoint.sources || [])], linked = [...(checkpoint.linked || [])], headers = [...(checkpoint.headers || [])];
  const jobs = (await query('SELECT * FROM transfer_order_posting_jobs')).rows;
  const pendingIds = new Set(jobs.filter(job => job.status !== 'completed').map(job => Number(job.local_to_id)));
  const splitParents = new Set(local.filter(order => Number(order.netsuite_id) < 0 && !(order.status === 'G'
    && order.outbound_operator_status === 'loaded' && order.receiving_status === 'received'))
    .map(order => order.tranid.replace(/-S\d+$/u, '')));
  const knownHeaders = new Set(headers.map(header => Number(header.id)));
  const missingHeaders = ids.filter(id => !knownHeaders.has(id));
  for (let index = 0; index < missingHeaders.length; index += 200) {
    const batch = missingHeaders.slice(index, index + 200);
    const batchHeaders = await suiteqlAll(`SELECT id,tranid,status,BUILTIN.DF(status) AS status_text,lastmodifieddate
      FROM transaction WHERE type='TrnfrOrd' AND id IN (${batch.join(',')}) ORDER BY id`);
    headers.push(...batchHeaders);
    console.log(JSON.stringify({ kind: 'headers', headers: batchHeaders }));
  }
  const detailed = headers.filter(header => !['G', 'H'].includes(header.status) || pendingIds.has(Number(header.id))
    || splitParents.has(header.tranid)).filter(header => header.status !== 'H').map(header => Number(header.id));
  const sourceDone = new Set(checkpoint.sourceDone || []), linkedDone = new Set(checkpoint.linkedDone || []);
  for (let index = 0; index < detailed.length; index += 20) {
    const batch = detailed.slice(index, index + 20);
    const sourceIds = batch.filter(id => !sourceDone.has(id));
    if (sourceIds.length) {
      const rows = await fetchPoToReconciliationOrdersFromNetSuite({ orderIds: sourceIds, kind: 'TO', targetOnly: true, includeOpen: false });
      sources.push(...rows);
      console.log(JSON.stringify({ kind: 'sources', ids: sourceIds, sources: rows }));
    }
    const linkedIds = batch.filter(id => !linkedDone.has(id));
    if (linkedIds.length) {
      const rows = await fetchPoToLinkedTransactionsFromNetSuite(linkedIds);
      linked.push(...rows);
      console.log(JSON.stringify({ kind: 'linked', ids: linkedIds, linked: rows }));
    }
  }
  const records = [...(checkpoint.records || [])];
  const transactions = new Map();
  for (const line of linked) {
    if (pendingIds.has(line.sourceOrderId)) {transactions.set(`${line.transactionType}:${line.transactionId}`, line);}
  }
  // Also read the existing successful legacy Operator receipt so its local
  // physical record can be reconciled without saving a second receipt.
  const legacyReceipts = (await query(`SELECT DISTINCT r.order_id FROM receiving_receipt_records r
    JOIN transfer_orders o ON o.netsuite_id=r.order_id WHERE r.receipt_status IN ('received','partial_received')`)).rows;
  for (const line of linked) {
    if (line.transactionType === 'ItemRcpt' && legacyReceipts.some(row => Number(row.order_id) === line.sourceOrderId)) {
      transactions.set(`${line.transactionType}:${line.transactionId}`, line);
    }
  }
  for (const line of transactions.values()) {
    if (records.some(record => record.type === line.transactionType && record.id === line.transactionId)) {continue;}
    const record = line.transactionType === 'ItemShip'
      ? await fetchItemFulfillmentFromNetSuite(line.transactionId) : await fetchItemReceiptFromNetSuite(line.transactionId);
    const entry = { type: line.transactionType, id: line.transactionId, sourceId: line.sourceOrderId, record };
    records.push(entry);
    console.log(JSON.stringify({ kind: 'record', entry }));
  }
  console.log(JSON.stringify({ kind: 'complete', at: new Date().toISOString(), localCount: local.length,
    requestedParentCount: ids.length, netSuiteWrites: 0 }));
} finally { await closeDb(); }
