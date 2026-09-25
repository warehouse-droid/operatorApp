// Run from /app against the deployed image after the authorized IF test.
import assert from 'node:assert/strict';
import { pool, withTransaction } from './src/db.js';
import { fetchTransactionStatusFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite } from './src/netsuite.js';
import { updateSalesOrderNetSuiteStatus, upsertSalesOrderLines } from './src/order-sync-repository.js';
import { writeAudit } from './src/auth-repository.js';
try {
  const status = await fetchTransactionStatusFromNetSuite(996102,'SalesOrd');
  const lines = await fetchDeliveryOrderDetailsFromNetSuite(996102);
  assert.equal(status.tranid,'SOB120598');
  assert.equal(lines.length,1);
  assert.equal(Number(lines[0].location_id),14);
  assert.equal(Number(lines[0].line_id),4970885);
  const updated = await withTransaction(async () => {
    const order = await updateSalesOrderNetSuiteStatus(996102,status);
    await upsertSalesOrderLines(996102,lines);
    await writeAudit({ actorType:'system',source:'child-location-validation',action:'netsuite.child_location_test.cache_refreshed',orderId:'996102',
      details:{ transactionId:997397,transactionRef:'IF154026',status:status.status,statusText:status.status_text,lines:lines.length } });
    return order;
  });
  console.log(JSON.stringify({refreshed:true,order:updated,inventoryLocation:14,lineCount:lines.length}));
} finally { await pool.end(); }
