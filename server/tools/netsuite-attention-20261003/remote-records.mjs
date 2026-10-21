import {query,closeDb} from '../../src/db.js';
import {listOperatorNetSuitePostingAttentionCommands} from '../../src/operator-netsuite-posting-repository.js';
import {listSalesOrderAutoFulfillmentCandidates} from '../../src/sales-order-auto-fulfillment-repository.js';
import {fetchItemFulfillmentFromNetSuite,findOperatorNetSuitePostingTransactionByExternalId} from '../../src/netsuite.js';
try {
 const native=await listOperatorNetSuitePostingAttentionCommands({limit:500});
 const sales=await listSalesOrderAutoFulfillmentCandidates({statuses:['uncertain'],limit:500});
 const work=[...native.flatMap(c=>c.steps.map(s=>({queue:'native',id:c.id,reference:s.sourceOrderRef,source:s.sourceNetSuiteId,
   externalId:s.externalId,remoteId:s.netSuiteTransactionId || s.response?.observedTransaction?.id}))),
   ...sales.map(c=>({queue:'sales',id:c.id,reference:c.dispatchOrderRef,source:c.sourceSalesOrderId,externalId:c.externalId,remoteId:c.netSuiteTransactionId}))];
 const results=[];let cursor=0;
 await Promise.all(Array.from({length:3},async()=>{
  while(cursor<work.length){const input=work[cursor++];try{
   const found=input.remoteId?{record:await fetchItemFulfillmentFromNetSuite(input.remoteId)}:
    await findOperatorNetSuitePostingTransactionByExternalId(input.externalId,'IF',input.source,{direct:true});
   const record=found?.record || (found?.id?await fetchItemFulfillmentFromNetSuite(found.id):null);
   results.push({...input,record});
  }catch(error){results.push({...input,error:error.message});}}
 }));
 console.log(JSON.stringify({at:new Date().toISOString(),results},null,2));
}finally{await closeDb();}
