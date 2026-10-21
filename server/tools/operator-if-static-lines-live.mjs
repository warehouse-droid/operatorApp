import assert from 'node:assert/strict';
import { query, closeDb } from '../src/db.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../src/netsuite.js';
import { prepareSalesOrderFulfillmentPayload } from '../src/operator-netsuite-posting-fulfillment-lines.js';

// Read-only operational check: this tool never transforms or changes any record.
try {
  const order = (await query("SELECT netsuite_id,tranid FROM sales_orders WHERE tranid='SOA10159' LIMIT 1")).rows[0];
  assert.ok(order);
  const saved = (await query(`SELECT payload,line_snapshot,payload_hash,external_id,source_netsuite_id
    FROM operator_netsuite_posting_steps WHERE source_netsuite_id=$1 AND transaction_type='IF'
    ORDER BY id DESC LIMIT 1`, [order.netsuite_id])).rows[0];
  assert.ok(saved);
  const source = await fetchSalesOrderFulfillmentStateFromNetSuite(order.netsuite_id, { includeAllSourceLines: true });
  const step = { sourceNetSuiteId: saved.source_netsuite_id, sourceOrderKind: 'SO', transactionType: 'IF',
    externalId: saved.external_id, lineSnapshot: saved.line_snapshot, payload: saved.payload };
  const before = JSON.stringify(step);
  let outgoing = null, ready = false, reason = null;
  try { outgoing = prepareSalesOrderFulfillmentPayload(step, source); ready = true; }
  catch (error) { reason = error.message; }
  assert.equal(JSON.stringify(step), before);
  console.log(JSON.stringify({ at: new Date().toISOString(), orderRef: order.tranid,
    sourceNetSuiteId: Number(order.netsuite_id), ready, reason,
    sourceLines: source?.lines.map(line => ({ orderLine: line.orderLine, location: line.location,
      remainingQuantity: line.remainingQuantity, lineClosed: line.lineClosed })),
    savedItems: saved.payload.item.items, outgoingItems: outgoing?.item.items ?? null,
    externalIdPreserved: outgoing ? outgoing.externalId === saved.external_id : null,
    durablePayloadPreserved: true, payloadHash: saved.payload_hash, netSuiteWrites: 0, localWrites: 0 }));
} finally { await closeDb(); }
