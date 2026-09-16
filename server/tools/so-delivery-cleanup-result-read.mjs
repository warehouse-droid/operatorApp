import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {pool,query,withTransaction,closeDb} from "../src/db.js";
import {getDeliveryOrder} from "../src/delivery-repository.js";
import {listFulfilledSalesDeliveryStates} from "../src/dispatch-fulfilled-so-repository.js";
import {readCleanupState,createCleanupManifest,cleanupManifestSummary} from "./so-delivery-cleanup-repository.mjs";
import {readCoCleanupState} from "./co-source-cleanup-repository.mjs";
pool.options.options="-c jit=off -c default_transaction_read_only=on -c statement_timeout=60000";
const directory=process.argv[2]||"test-artifacts/so-delivery-cleanup-apply-20260915";
const read=name=>JSON.parse(readFileSync(`${directory}/${name}`,"utf8"));
try {
  const result=await withTransaction(async()=>{
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const ns=read("live/manifest.json"),local=read("local/manifest.json"),co=read("live/co-manifest.json");
    const state=await readCleanupState(),byId=new Map(state.orders.map(order=>[String(order.netsuite_id),order]));
    const nsStates=await listFulfilledSalesDeliveryStates(ns.entries.map(entry=>entry.ref));
    const localStates=await listFulfilledSalesDeliveryStates(local.entries.map(entry=>entry.ref));
    for(const entry of [...ns.entries,...local.entries]) {
      assert.equal(byId.get(entry.id).operator_status,"loaded",entry.ref);
      assert.equal(byId.get(entry.id).local_yard_order_status,"Loaded",entry.ref);
    }
    for(const entry of local.entries) {
      assert.equal(localStates.get(entry.ref.toLowerCase())?.eligible,false,entry.ref);
      for(const field of ["status","status_text","fulfillment_status","fulfilled_at","last_item_fulfillment_id"]) {
        assert.deepEqual(byId.get(entry.id)[field],entry.before.order[field],`Direct cleanup changed NetSuite ${field}: ${entry.ref}`);
      }
    }
    const coResults=[];
    for(const entry of co.entries) {
      const detail=await getDeliveryOrder(entry.ref);
      coResults.push({ref:entry.ref,found:Boolean(detail),status:detail?.operator_status,yardStatus:detail?.local_yard_order_status});
      if(detail) assert.equal(detail.local_yard_order_status,"Loaded",entry.ref);
    }
    const coState=await readCoCleanupState();
    const nsSummary=cleanupManifestSummary(createCleanupManifest(state,ns.remote,{candidateIds:ns.entries.map(entry=>entry.id)}));
    const directSummary=cleanupManifestSummary(createCleanupManifest(state,local.remote,{candidateIds:local.entries.map(entry=>entry.id),scope:"local-delivery-only"}));
    return {verifiedAt:new Date().toISOString(),nsLoaded:ns.entries.length,localLoaded:local.entries.length,
      nsPlanningAllowed:ns.entries.filter(entry=>nsStates.get(entry.ref.toLowerCase())?.eligible).length,
      nsPlanningRestrictions:ns.entries.filter(entry=>!nsStates.get(entry.ref.toLowerCase())?.eligible).map(entry=>({ref:entry.ref,state:nsStates.get(entry.ref.toLowerCase())})),
      localReplanningBlocked:local.entries.length,coResults,nsSummary,directSummary,coCount:coState.cos.length};
  },{rollback:true});
  writeFileSync(`${directory}/result-verification.json`,JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify({...result,coResults:result.coResults.length,nsPlanningRestrictions:result.nsPlanningRestrictions.length}));
} finally {await closeDb();}
