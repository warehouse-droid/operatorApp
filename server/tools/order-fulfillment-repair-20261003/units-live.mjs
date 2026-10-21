import assert from 'node:assert/strict';
import {closeDb} from '/app/src/db.js';
import {fetchDeliveryOrderDetailsFromNetSuite,fetchDeliveryOrderDetailsBatchFromNetSuite,fetchTransactionProgressFromNetSuite,fetchScmReconciliationOrdersFromNetSuite,fetchPoToLinkedTransactionsFromNetSuite,suiteql} from './candidate-netsuite.js';
const transport=globalThis.fetch;globalThis.fetch=async(url,opts={})=>{if(new URL(url).pathname.includes('/query/v1/suiteql'))globalThis.unitQuery=JSON.parse(opts.body||'{}').q;if(new URL(url).pathname.includes('/record/v1/')&&(opts.method||'GET')!=='GET')throw Error('NetSuite writes forbidden');return transport(url,opts);};
try {
 console.error('Checking single');
 const single=await fetchDeliveryOrderDetailsFromNetSuite(1033859);assert.equal(single.length,1);assert.equal(single[0].quantity,1);assert.equal(single[0].unit,'Yard');assert.equal(single[0].netsuite_received_qty,1);
 console.error('Checking batch');
 const batch=await fetchDeliveryOrderDetailsBatchFromNetSuite([1033859,1023363]);assert.equal(batch.get(1033859)[0].quantity,1);
 console.error('Checking progress');
 const progress=await fetchTransactionProgressFromNetSuite(1033859,'SalesOrd');assert.equal(progress.lines[0].quantity,1);assert.equal(progress.lines[0].netsuite_received_qty,1);
 console.error('Checking recon');
 const recon=await fetchScmReconciliationOrdersFromNetSuite({orderIds:[1033859],targetOnly:true,kind:'SO',includeOpen:false});assert.equal(recon.length,1);assert.equal(recon[0].lines[0].quantity,1);assert.equal(recon[0].lines[0].cumulativeProgressQuantity,1);
 console.error('Checking links');
 const links=await fetchPoToLinkedTransactionsFromNetSuite([1033859]);assert.equal(links.length,1);assert.equal(links[0].quantity,1);assert.equal(links[0].unit,'Yard');
 console.error('Checking other');
 const other=(await suiteql("SELECT DISTINCT i.id,i.itemid,tl.units,BUILTIN.DF(tl.units) AS unit,uom.conversionrate FROM item i JOIN transactionline tl ON tl.item=i.id JOIN transaction t ON t.id=tl.transaction JOIN UnitsTypeUom uom ON uom.internalid=tl.units WHERE t.type='SalesOrd' AND t.trandate>=TO_DATE('2026-10-01','YYYY-MM-DD') AND tl.mainline='F' AND tl.taxline='F' AND uom.conversionrate<>1 ORDER BY i.id")).items;
 console.log(JSON.stringify({verified:true,order:'SOM06812',salesQuantity:1,salesUom:'Yard',readers:['single','batch','progress','reconciliation','linked IF'],single,batch:[...batch],progress,recon,links,otherConvertedItems:other}));
}finally{await closeDb();}
