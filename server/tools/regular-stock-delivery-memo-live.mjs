// Read-only checks of the released payload and repository. No orders or printing.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {getStockTransfer} from '../src/stock-request-repository.js';
import {buildStockRequestTransferPayload} from '../src/stock-request-service.js';
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const locations={source:{netsuiteLocationId:1,subsidiaryId:1},destination:{netsuiteLocationId:28,subsidiaryId:1}};
  const transfer={workflowVersion:2,id:42,requestId:81,transferRef:'STTO-000042',palletQuantity:0,lines:[{itemId:10,salesQty:5}]};
  assert.equal(buildStockRequestTransferPayload({transfer:{...transfer,deliverySalesOrderRef:'SOB121732'},locations}).memo,'SOB121732');
  assert.equal(buildStockRequestTransferPayload({transfer,locations}).memo,'Sales stock request STTO-000042 | MBBS-STOCK-REQUEST-TO:42');
  const saved=await query(`SELECT t.id, r.regular_details->>'salesOrderRef' AS ref FROM sales_stock_transfers t
    JOIN sales_stock_requests r ON r.id=t.request_id WHERE r.regular_details->>'deliveryVersion'='1' ORDER BY t.id DESC LIMIT 5`);
  for(const row of saved.rows)assert.equal((await getStockTransfer(row.id)).deliverySalesOrderRef,row.ref);
  return {readOnly:true,deliveryMemo:'SOB121732',legacyMemoPreserved:true,savedTransferReads:saved.rowCount,netSuiteCalls:0,orderWrites:0,printJobsCreated:0};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
