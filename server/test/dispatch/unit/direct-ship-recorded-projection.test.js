import assert from "node:assert/strict";
import test from "node:test";
import { freezeRecordedPurchaseOrderProjections } from "../../../src/dispatch-recorded-po-projection.js";

test("started remaining TO cargo retains its published projection",()=>{
  const published={version:1,hasResidual:true,items:[{quantity:1,pieces:1}]};
  const recordedPlan={orders:[{id:"TO-RECORDED",type:"TO",toRouteProjection:published}],
    trucks:[{loads:[{id:"load",stops:[{id:"pick",type:"pick",orderId:"TO-RECORDED"}]}]}]};
  const projectedOrders=[{id:"TO-RECORDED",type:"TO",toRouteProjection:{version:1,hasResidual:false,items:[]}}];
  const result=freezeRecordedPurchaseOrderProjections({recordedPlan,projectedOrders,
    activity:[{status:"in_progress",stop_type:"pickup",load_id:"load",stop_id:"pick",order_refs:["TO-RECORDED"]}]});
  assert.deepEqual(result.orders[0].toRouteProjection,published);
  assert.notEqual(result.orders[0].toRouteProjection,published);
});
