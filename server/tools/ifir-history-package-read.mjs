// Read-only comparison of saved package fields with original posting payloads.
import { query, closeDb } from './src/db.js';
import { fetchItemReceiptFromNetSuite, fetchItemFulfillmentFromNetSuite } from './src/netsuite.js';
const fields = ['custcol_plt', 'custcol_lyr', 'custcol_sec', 'custcol_pcs'];
try {
  const rows = (await query(`SELECT id, transaction_type, netsuite_transaction_id, netsuite_transaction_ref, payload
    FROM operator_netsuite_posting_steps WHERE id IN (2252,2234,2268) AND status='posted' ORDER BY id`)).rows;
  for (const row of rows) {
    const record = await (row.transaction_type === 'IR' ? fetchItemReceiptFromNetSuite
      : fetchItemFulfillmentFromNetSuite)(Number(row.netsuite_transaction_id));
    const lines = row.payload.item.items.filter(line => line.itemReceive === true).map(line => {
      const saved = record.item.items.find(item => Number(item.orderLine ?? item.orderline) === Number(line.orderLine));
      return { orderLine: line.orderLine, requested: Object.fromEntries(fields.map(field => [field,line[field] ?? null])),
        saved: Object.fromEntries(fields.map(field => [field,saved?.[field] ?? null])),
        availableCustomFields: Object.keys(saved || {}).filter(key => key.startsWith('custcol')) };
    });
    console.log(JSON.stringify({ reference: row.netsuite_transaction_ref, transactionId: row.netsuite_transaction_id, lines }));
  }
} finally { await closeDb(); }
