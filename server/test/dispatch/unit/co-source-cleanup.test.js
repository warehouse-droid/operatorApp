import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {createCoCleanupManifest} from "../../../tools/co-source-cleanup-repository.mjs";

test("property: every active CO group member needs verified completion and skipped sources stay excluded",()=>{
  fc.assert(fc.property(fc.array(fc.record({netsuite:fc.boolean(),local:fc.boolean()}),{minLength:1,maxLength:6}),
    fc.boolean(),fc.boolean(),(members,active,skip)=>{
      const orders=members.map((_,i)=>({netsuite_id:String(81000+i),tranid:`SO-CO-PROP-${i}`,sales_order_type:"Delivery",status:"B",
        operator_status:"open",local_yard_order_status:"Open",netsuite_active:true}));
      const co={id:"90100",co_ref:"CO-PROP",source_order_ref:"GOA-CO-PROP",status:"pending_load",details:{}};
      const state={so:{orders,lines:[],splits:[],completions:[],reloads:[],claims:[],allocations:[],
        driverCompletedRefs:orders.filter((_,i)=>members[i].local).map(order=>order.tranid)},
        cos:[co],lines:[],groups:[{group_ref:"GOA-CO-PROP",active,members:orders.map(order=>order.tranid)}],completions:[]};
      const remote={mode:"netsuite-read-only-select",completedAt:new Date().toISOString(),rows:orders.filter((_,i)=>members[i].netsuite)
        .map(order=>({id:order.netsuite_id,tranid:order.tranid,status:"F"}))};
      const plan=createCoCleanupManifest(state,remote,{skipSourceRefs:skip?[orders[0].tranid]:[]});
      const expected=active&&!skip&&members.every(member=>member.netsuite||member.local);
      assert.equal(plan.entries.length,expected?1:0);
      if(expected) {
        const after={...state,cos:[plan.entries[0].after.order]};
        const again=createCoCleanupManifest(after,remote);
        assert.deepEqual(again.entries[0].before,again.entries[0].after);
        assert.equal(plan.entries[0].after.order.status,"planned");
        assert.equal(plan.entries[0].after.order.loaded_at,undefined);
      }
      assert.equal(co.status,"pending_load");
    }),{seed:20260915,numRuns:240});
});
