import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectDirectTransferResidual } from "../../../src/dispatch-to-route-projection.js";

test("TO native and physical residuals conserve cargo across duplicate item lines", () => {
  fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),fc.integer({min:0,max:25000}),
    (first,second,allocated) => {
      const source = { id:"TO-PROPERTY",type:"TO",items:[first,second].map((quantity,index)=>({lineRowId:String(index),itemId:42,
        quantity,pieces:quantity,layers:quantity/10,pallets:quantity/100,lineWeight:quantity*2})) };
      const dependency = { mode:"direct_to_customer",status:"active",salesOrderRef:"SO-PROPERTY",lines:[{itemId:42,allocatedQuantity:allocated}] };
      const before=structuredClone(source);
      const projection=projectDirectTransferResidual(source,dependency).toRouteProjection;
      const expected=Math.max(first+second-allocated,0);
      assert.equal(projection.salesQty,expected);
      assert.equal(projection.pieces,expected);
      assert.ok(Math.abs(projection.pallets-expected/100)<0.000002);
      assert.equal(projection.weight,expected*2);
      assert.equal(projection.hasResidual,expected>0);
      assert.deepEqual(source,before);
      assert.deepEqual(projectDirectTransferResidual(source,dependency).toRouteProjection,projection);
      assert.equal(projectDirectTransferResidual(source,{...dependency,status:"cancelled"}),source);
    }),{numRuns:1000,seed:35925230});
});

test("TO remaining-cargo pickup and drop use the same projection", async () => {
  const { driverOrderDetailsFromPlan }=await import("../../../src/driver-repository.js");
  const order=projectDirectTransferResidual({id:"TO-REMAINDER",type:"TO",items:[{itemId:42,sku:"Pieces",quantity:20,pieces:20,unit:"PC"}]},
    {mode:"direct_to_customer",status:"active",salesOrderRef:"SO-LINK",lines:[{itemId:42,allocatedQuantity:19}]});
  const pickup=driverOrderDetailsFromPlan(order.id,order,{stopType:"pickup"});
  const drop=driverOrderDetailsFromPlan(order.id,order,{stopType:"dropoff"});
  assert.deepEqual(drop.items,pickup.items);
  assert.deepEqual(pickup.items.map(item=>({sku:item.sku,units:item.units})),[{sku:"Pieces",units:[{unit:"PCS",value:1}]}]);
});

test("TO remaining cargo uses available mixed-unit conversions",()=>{
  const order={id:"TO-MIXED",type:"TO",items:[{itemId:42,quantity:20,pallets:2,pieces:0,toPlt:10,toPcs:1}]};
  const projection=projectDirectTransferResidual(order,{mode:"direct_to_customer",status:"active",salesOrderRef:"SO-MIXED",
    lines:[{itemId:42,allocatedQuantity:19,palletQty:1,pieceQty:9}]}).toRouteProjection;
  assert.equal(projection.salesQty,1);
  assert.equal(projection.pallets,0);
  assert.equal(projection.pieces,1);
});
