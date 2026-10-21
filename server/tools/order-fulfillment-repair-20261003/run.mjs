import assert from 'node:assert/strict';
import {closeDb,withTransaction,query} from '/app/src/db.js';
import {suiteql,fetchItemFulfillmentFromNetSuite} from '/app/src/netsuite.js';
import {getDeliveryOrder} from '/app/src/delivery-repository.js';
import {snapshotIncident,reconcileIncidents} from './repair.mjs';
const mode=process.env.INCIDENT_REPAIR_MODE||'snapshot';
assert(['snapshot','rehearse','apply','verify'].includes(mode));
const transport=globalThis.fetch;
let recordWrites=0;
globalThis.fetch=async(url,options={})=>{
  if(new URL(url).pathname.includes('/record/v1/')&&(options.method||'GET')!=='GET') {recordWrites++;throw new Error('NetSuite record mutation forbidden');}
  return transport(url,options);
};
async function snapshot(){return withTransaction(async()=>({SO:await snapshotIncident('SO'),TO:await snapshotIncident('TO')}));}
async function remote(){
  const out={};
  const rows=(await suiteql(`SELECT t.id,t.tranid,t.status,BUILTIN.DF(t.status) AS status_text,tl.uniquekey,tl.id AS line,tl.item,tl.quantity,tl.quantityshiprecv,tl.location,i.itemtype FROM transaction t JOIN transactionline tl ON tl.transaction=t.id LEFT JOIN item i ON i.id=tl.item WHERE t.id IN (1032550,1023363) AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL ORDER BY t.id,tl.id`)).items;
  for(const [kind,id,ifId] of [['SO',1023363,1035754],['TO',1032550,1036362]]) {
    out[kind]={sourceRows:rows.filter(l=>Number(l.id)===id),
      record:await fetchItemFulfillmentFromNetSuite(ifId),
      history:(await suiteql(`SELECT DISTINCT t.id,t.tranid,t.type,t.status,t.externalid FROM transaction t JOIN transactionline tl ON tl.transaction=t.id WHERE tl.createdfrom=${id} AND t.type IN ('ItemShip','ItemRcpt') ORDER BY t.id`)).items};
  }
  out.checkedAt=new Date().toISOString();return out;
}
try {
  const before=await snapshot();
  if(mode==='verify') {
    const views=[];
    for(const id of [1023363,1032550]) {
      const o=await getDeliveryOrder(id,{includeNetSuiteClosed:true});
      views.push({id,ref:o?.tranid,operatorStatus:o?.operator_status,status:o?.status,statusText:o?.status_text,posting:o?.posting,confirmationSummary:o?.confirmationSummary});
      assert.equal(o?.operator_status,'loaded');assert(!o?.posting?.loadBlocked);
    }
    console.log(JSON.stringify({mode,verified:true,views,snapshot:before}));
  } else {
    const evidence=await remote();
    if(mode==='snapshot') console.log(JSON.stringify({mode,evidence,before}));
    else {
      const result=await reconcileIncidents(evidence,{apply:mode==='apply'});
      const after=await snapshot();
      if(mode==='rehearse') assert.deepEqual(after,before,'Rollback changed scoped business state');
      const repeated=mode==='apply'?await reconcileIncidents(evidence,{apply:true}):null;
      if(repeated) {assert(repeated.results.every(r=>r.alreadyApplied));assert.deepEqual(await snapshot(),after,'Idempotent repeat changed state');}
      assert.equal(recordWrites,0);
      console.log(JSON.stringify({mode,result,repeated,evidence,before,after,rollbackVerified:mode==='rehearse',recordWrites}));
    }
  }
} finally {await closeDb();}
