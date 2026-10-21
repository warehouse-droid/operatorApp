// Read-only verification of the candidate created after the initial snapshot.
import assert from 'node:assert/strict';
import {query,closeDb,beginRollbackContext} from '../../src/db.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite,fetchSalesOrderFulfillmentStateFromNetSuite} from '../../src/netsuite.js';
import {prepareSalesOrderAutoFulfillmentCandidate} from '../../src/sales-order-auto-fulfillment-repository.js';
const id='236e4f20-3e14-4b94-b31c-a6519135bf6a';
try {
 const candidate=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1',[id])).rows[0];
 assert.equal(candidate.dispatch_order_ref,'SOA09706');assert.equal(candidate.attempt_count,0);
 const headers=await suiteqlAll("SELECT id,tranid,status,BUILTIN.DF(status) AS status_text FROM transaction WHERE type='SalesOrd' AND tranid='SOA09706'");
 assert.equal(headers.length,1);const sourceId=Number(headers[0].id);assert.ok(Number.isSafeInteger(sourceId));
 const lines=await suiteqlAll(`SELECT tl.id AS order_line,tl.uniquekey AS source_line_key,tl.item,tl.quantity,tl.quantityshiprecv,tl.units,tl.location FROM transactionline tl WHERE tl.transaction=${sourceId} AND tl.item IS NOT NULL AND tl.mainline='F' AND tl.taxline='F'`);
 const links=await suiteqlAll(`SELECT DISTINCT t.id,t.tranid,t.type FROM NextTransactionLineLink l JOIN transaction t ON t.id=l.nextdoc WHERE l.previousdoc=${sourceId} AND t.type IN ('ItemShip','ItemRcpt')`);
 const externalMatches=await suiteqlAll(`SELECT id,tranid,type FROM transaction WHERE externalid='${candidate.external_id.replaceAll("'","''")}'`);
 const records=[];for(const link of links){assert.equal(link.type,'ItemShip');records.push(await fetchItemFulfillmentFromNetSuite(link.id));}
 const source=await fetchSalesOrderFulfillmentStateFromNetSuite(sourceId);
 const local=(await query('SELECT to_jsonb(o) AS header FROM sales_orders o WHERE netsuite_id=$1',[sourceId])).rows;
 const localLines=(await query('SELECT id,line_id,netsuite_order_line,item_id,quantity,loaded_qty,unit FROM sales_order_lines WHERE sales_order_id=$1',[sourceId])).rows;
 const rollback=await beginRollbackContext();let prepared;
 try{await rollback.run(async()=>{
  await query("UPDATE dispatch_sales_order_if_candidates SET status='discovered',last_error=NULL WHERE id=$1",[id]);
  prepared=await prepareSalesOrderAutoFulfillmentCandidate(id);
 });}finally{await rollback.rollback();}
 console.log(JSON.stringify({at:new Date().toISOString(),candidate,headers,lines,links,externalMatches,records,source,local,localLines,prepared,netSuitePosts:0},null,2));
}finally{await closeDb();}
