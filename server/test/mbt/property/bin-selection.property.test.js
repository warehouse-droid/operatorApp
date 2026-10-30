import test,{after} from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {closeDb} from "../../../src/db.js";
import {selectedDeliverySnapshot} from "../../../src/mbt/bin-selection-snapshot.js";
import {fitBinSelectionRoute} from "../../../src/mbt/bin-selection-routing.js";
after(closeDb);
test("property: repeated bin selections preserve delivery identity and exactly the required pickup",()=>{
  fc.assert(fc.property(fc.array(fc.record({truck:fc.boolean(),id:fc.uuid(),code:fc.string({minLength:1,maxLength:40})}),{minLength:1,maxLength:30}),choices=>{
    let snapshot={binWorkflow:{orderId:"root",role:"delivery"},mandatoryStops:[{stopId:"delivery-stable",actionCode:"deliver_bin",sequence:1}]};
    for (const choice of choices) {
      const source={kind:choice.truck ? "truck" : "yard",id:choice.id,address:`Location ${choice.id}`};
      snapshot=selectedDeliverySnapshot({service_visit_id:"visit-stable",service_snapshot:snapshot},{asset_id:choice.id,asset_code:choice.code},source);
      assert.equal(snapshot.mandatoryStops.filter(s=>s.actionCode==="collect_empty_bin").length,choice.truck ? 0 : 1);
      assert.equal(snapshot.mandatoryStops.find(s=>s.actionCode==="deliver_bin").stopId,"delivery-stable");
      assert.equal(snapshot.binWorkflow.orderId,"root");assert.deepEqual(snapshot.binWorkflow.source,source);
      assert.deepEqual(snapshot.mandatoryStops.map(s=>s.sequence),snapshot.mandatoryStops.map((_s,i)=>i+1));
    }
  }),{numRuns:250,seed:20261022});
});
test("property: route timing fits exactly when the scheduled load has enough time",()=>{
  fc.assert(fc.property(fc.array(fc.record({drive:fc.integer({min:1,max:30}),stay:fc.integer({min:1,max:30})}),{minLength:1,maxLength:10}),fc.integer({min:0,max:300}),(values,start)=>{
    const needed=values.reduce((n,v)=>n+v.drive+v.stay,0);
    const make=finish=>({plannedStartMinute:start,plannedFinishMinute:finish,stops:values.map((_v,i)=>({mbt:{visitId:`v${i}`}}))});
    const changed=new Set(values.map((_v,i)=>`v${i}`));
    const legs=values.map(v=>v.drive),stays=values.map(v=>v.stay),load=make(start+needed);
    fitBinSelectionRoute(load,legs,stays,changed);assert.equal(load.stops.at(-1).timing.depart,start+needed);
    let cursor=start;
    for (const [i,stop] of load.stops.entries()) {assert.equal(stop.timing.arrival,cursor+legs[i]);cursor=stop.timing.depart;}
    assert.throws(()=>fitBinSelectionRoute(make(start+needed-1),legs,stays,changed),/fit|finish time/i);
  }),{numRuns:500,seed:20261022});
});
