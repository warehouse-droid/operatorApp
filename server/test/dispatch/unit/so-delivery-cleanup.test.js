import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectCleanupOrder } from "../../../tools/so-delivery-cleanup-domain.mjs";

const order = { netsuite_id: 71001, tranid: "SO-CLEANUP", sales_order_type: "Delivery",
  operator_status: "open", local_yard_order_status: "Open", status: "B" };
const line = { id: 81001, sales_order_id: 71001, item_type: "InvtPart", quantity: 4,
  unit: "EA", netsuite_active: true, loaded_qty: 0, packed_sales_qty: 2, confirmed: true };
const verified = { id: 71001, tranid: "SO-CLEANUP", status: "F", statusText: "Sales Order : Pending Billing" };
const options = { verified, identityCount: 1, sourceIdentityCount: 1 };

test("cleanup uses verified full SO quantities and retains commercial fields", () => {
  const result = projectCleanupOrder(order, [line], options);
  assert.equal(result.eligible, true);
  assert.equal(result.order.operator_status, "loaded");
  assert.equal(result.order.local_yard_order_status, "Loaded");
  assert.equal(result.order.status, "F");
  assert.equal(result.lines[0].loaded_qty, 4);
  assert.equal(result.lines[0].packed_sales_qty, 0);
  assert.equal(result.lines[0].confirmed, false);
  assert.equal(result.lines[0].quantity, 4);
  assert.equal(result.lines[0].unit, "EA");
  assert.equal(result.addCompletion, true);
});

test("local delivery becomes Loaded without inventing NetSuite fulfillment", () => {
  const result = projectCleanupOrder(order, [line], { ...options, verified: null, locallyCompleted: true });
  assert.equal(result.eligible, true);
  assert.equal(result.order.operator_status, "loaded");
  assert.equal(result.order.status, "B");
  assert.equal(result.addCompletion, false);
});

test("unsafe and unverified orders retain all fields", () => {
  const cases = [
    [{...order,sales_order_type:"Pick-Up"}, options],
    [order,{...options,verified:{...verified,status:"E"}}],
    [order,{...options,verified:{...verified,id:9}}],
    [order,{...options,verified:{...verified,tranid:"SO-WRONG"}}],
    [order,{...options,identityCount:2}],
    [order,{...options,activeReload:true}],
    [order,{...options,claimed:true}],
    [{...order,has_preparing_operator:true},options],
    [{...order,operator_status:"cancelled"},options],
    [{...order,local_yard_order_status:"Hold"},options]
  ];
  for (const [before, opts] of cases) {
    const result = projectCleanupOrder(before, [line], opts);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.order, before);
    assert.deepEqual(result.lines, [line]);
  }
});

test("active split inherits only its unique fulfilled source", () => {
  const child = {...order,netsuite_id:-71001,tranid:"SO-CLEANUP-S1",status:"B"};
  const split = {source_so_id:71001,split_so_id:-71001,status:"active"};
  const result = projectCleanupOrder(child, [line], {...options,source:order,split});
  assert.equal(result.eligible,true);
  assert.equal(result.order.status,"B");
  for (const altered of [{...split,status:"cancelled"},{...split,source_so_id:999}]) {
    assert.equal(projectCleanupOrder(child,[line],{...options,source:order,split:altered}).eligible,false);
  }
  assert.equal(projectCleanupOrder(child,[line],{...options,source:order,split,sourceIdentityCount:2}).eligible,false);
});

test("linked supply reduces the Operator load and conflicting packing is held", () => {
  const result = projectCleanupOrder(order,[line],{...options,allocations:{81001:{sales_qty:3}}});
  assert.equal(result.lines[0].loaded_qty,1);
  for (const altered of [{...line,loaded_qty:1,loaded_uom:"PLT"},
    {...line,netsuite_active:false},{...line,sync_exception:true}]) {
    const held = projectCleanupOrder(order,[altered],options);
    assert.equal(held.eligible,false);
    assert.deepEqual(held.lines,[altered]);
  }
  assert.equal(projectCleanupOrder(order,[line],{...options,allocations:{81001:{sales_qty:5}}}).eligible,false);
});

test("property: cleanup has exact residual loads, is monotone and idempotent", () => {
  fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.integer({min:0,max:10000}),
    fc.integer({min:0,max:10000}),fc.constantFrom("F","G"),(required,loaded,linkedSeed,status)=>{
      const linked=linkedSeed%(required+1);
      const before={...line,quantity:required,loaded_qty:loaded,loaded_uom:loaded?"EA":null};
      const opts={...options,verified:{...verified,status},allocations:{81001:{sales_qty:linked}}};
      const result=projectCleanupOrder(order,[before],opts);
      assert.equal(result.eligible,true);
      assert.equal(result.lines[0].loaded_qty,Math.max(loaded,required-linked));
      assert.equal(result.order.status,status);
      assert.equal(result.lines[0].quantity,required);
      const again=projectCleanupOrder(result.order,result.lines,{...opts,hasCompletion:true});
      assert.deepEqual(again.order,result.order);
      assert.deepEqual(again.lines,result.lines);
      assert.equal(again.addCompletion,false);
    }),{seed:20260915,numRuns:600});
});

test("property: incomplete/duplicate/Driver-only evidence never enables a false NetSuite completion", () => {
  fc.assert(fc.property(fc.boolean(),fc.constantFrom("A","B","E","H"),fc.integer({min:1,max:4}),
    (local,status,count)=>{
      const result=projectCleanupOrder(order,[line],{...options,verified:{...verified,status},
        identityCount:count,locallyCompleted:local});
      assert.equal(result.eligible,local&&count===1);
      assert.equal(result.addCompletion,false);
      assert.equal(result.order.status,"B");
    }),{seed:20260916,numRuns:160});
});
