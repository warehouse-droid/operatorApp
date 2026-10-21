import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { resolveDispatchSalesTarget } from "../../../src/dispatch-order-target-repository.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import { applyDispatchV2Command } from "../../../src/dispatch-planner-v2-repository.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../../../src/scm-dependency-command-service.js";
import { cancelOrderDependency, createOrderDependency, syncDirectDependencyOperatorProgress, updateOrderDependencyMode,
  syncOrderDependenciesFromDispatchPlan,validateDispatchPlanDependencies } from "../../../src/order-dependency-repository.js";

after(closeDb);

async function seed() {
  const token = crypto.randomUUID().slice(0, 8);
  const base = 8_300_000_000 + Number.parseInt(token, 16);
  const salesRef = `SO-PACK-INDEPENDENT-${token}`;
  const transferRef = `TO-PACK-INDEPENDENT-${token}`;
  await query(`INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit,to_pcs)
    VALUES($1,'Packing independence','InvtPart','EA',1)`, [base]);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,
    outbound_location_id,outbound_location,sales_order_type,fulfillment_status,
    operator_status,local_yard_order_status,dispatch_address,netsuite_active)
    VALUES($1,$2,current_date,'Packing independence','B','Sales Order : Pending Fulfillment',
      15,'12441','Delivery','open','open','Open','100 Test Street',true)`, [base+1,salesRef]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,
    item_type,quantity,unit,piece_qty,to_pcs,netsuite_backordered_qty,netsuite_active)
    VALUES($1,1,$2,'Packing independence','PACK-INDEPENDENT','InvtPart',10,'EA',10,1,10,true)`, [base+1,base]);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,trandate,status,status_text,
    from_location_id,from_location,to_location_id,to_location,outbound_operator_status,
    local_yard_order_status,fulfillment_status,receiving_status,dispatch_planned,netsuite_active)
    VALUES($1,$2,current_date,'B','Transfer Order : Pending Fulfillment',1,'3445',15,'12441',
      'open','Open','not_fulfilled','pending',false,true)`, [base+2,transferRef]);
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,item_id,item_name,sku,
    item_type,quantity,unit,piece_qty,to_pcs,netsuite_active,line_stage)
    SELECT $1,1,$2,'Packing independence','PACK-INDEPENDENT','InvtPart',10,'EA',10,1,true,stage
    FROM unnest(ARRAY['outbound','receiving']) stage`, [base+2,base]);
  return { base, salesRef, transferRef };
}

async function rollbackTest(fn) {
  const context = await beginRollbackContext();
  try { await context.run(async () => fn(await seed())); }
  finally { await context.rollback(); }
}

async function setPacking(fixture, salesStatus, transferStatus) {
  await query(`UPDATE sales_orders SET operator_status=$2,local_yard_order_status=$2
    WHERE netsuite_id=$1`, [fixture.base+1,salesStatus]);
  await query(`UPDATE transfer_orders SET outbound_operator_status=$2,local_yard_order_status=$2
    WHERE netsuite_id=$1`, [fixture.base+2,transferStatus]);
  await query(`UPDATE sales_order_lines SET confirmed=true,confirmed_at=now(),packed_piece_qty=10
    WHERE sales_order_id=$1`, [fixture.base+1]);
  await query(`UPDATE transfer_order_lines SET confirmed=true,confirmed_at=now(),packed_piece_qty=10
    WHERE transfer_order_id=$1 AND line_stage='outbound'`, [fixture.base+2]);
}

async function link(fixture) {
  const target = await resolveDispatchSalesTarget({ dispatchTargetRef: fixture.salesRef });
  return createOrderDependency({ dispatchTargetRef: fixture.salesRef,transferOrderRef: fixture.transferRef,
    mode: "direct_to_customer",allocations: [{targetLineKey: target.lines[0].targetLineKey,quantities: {pieces: 5}}] });
}

test("TO link previews ignore Operator packing on both source and dependent order", async () => {
  await rollbackTest(async fixture => {
    for (const salesStatus of ["open","confirmed","packed","preparing"]) {
      for (const transferStatus of ["open","confirmed","packed","preparing"]) {
        await setPacking(fixture,salesStatus,transferStatus);
        const preview = await previewScmDependencyMutation({ action: "link_to",targetRef: fixture.salesRef,
          payload: {transferOrderRef: fixture.transferRef,mode: "direct_to_customer"} }, {id: "packing-regression"});
        assert.equal(preview.allowed,true,JSON.stringify({salesStatus,transferStatus,blockers: preview.blockers}));
      }
    }
  });
});

test("packed TO can be linked, extended and have its dependency mode changed", async () => {
  await rollbackTest(async fixture => {
    await setPacking(fixture,"packed","packed");
    const dependency = await link(fixture);
    await syncDirectDependencyOperatorProgress(fixture.base+2);
    const preview = await previewScmDependencyMutation({action: "change_mode",targetRef: fixture.salesRef,
      payload: {dependencyId: dependency.id,mode: "yard_replenishment"}}, {id: "packing-regression"});
    assert.equal(preview.allowed,true,JSON.stringify(preview.blockers));
    const extended = await link(fixture);
    assert.equal(extended.id,dependency.id);
    const changed = await updateOrderDependencyMode(dependency.id,"yard_replenishment");
    assert.equal(changed.mode,"yard_replenishment");
  });
});

async function seedPurchase(fixture) {
  const purchaseRef = `PO-PACK-INDEPENDENT-${fixture.base}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,trandate,vendor_id,vendor,status,status_text,
    destination_location_id,destination_location,source_location_id,source_location,dispatch_vendor_yard,
    receipt_status,netsuite_active) VALUES($1,$2,current_date,$3,'Packing vendor','pendingReceipt',
      'Purchase Order : Pending Receipt',15,'12441',1,'3445','Packing vendor','not_received',true)`,
  [fixture.base+3,purchaseRef,fixture.base+4]);
  const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    item_type,quantity,unit,piece_qty,to_pcs,location_id,location,netsuite_active)
    VALUES($1,1,$2,'Packing independence','PACK-INDEPENDENT','InvtPart',10,'EA',10,1,15,'12441',true) RETURNING id`,
  [fixture.base+3,fixture.base])).rows[0];
  return {purchaseRef,poLineId: Number(line.id)};
}

async function execute(command) {
  command.requestId = crypto.randomUUID();
  command.payloadHash = scmDependencyPayloadHash(command);
  return executeScmDependencyCommand(command,{id: "packing-regression",sessionId: "packing-regression"});
}

test("PO link preview ignores Operator preparation, confirmation and packing on its dependent SO",async () => {
  await rollbackTest(async fixture => {
    const purchase = await seedPurchase(fixture);
    for(const status of ["open","preparing","confirmed","packed"]) {
      await setPacking(fixture,status,"packed");
      const preview = await previewScmDependencyMutation({action: "link_po",targetRef: fixture.salesRef,
        payload: {poRef: purchase.purchaseRef}},{id: "packing-regression"});
      assert.equal(preview.allowed,true,JSON.stringify({status,blockers: preview.blockers}));
    }
  });
});

test("actual PO link preserves the dependent SO packing and still blocks loading",async () => {
  await rollbackTest(async fixture => {
    const purchase = await seedPurchase(fixture);
    await setPacking(fixture,"packed","packed");
    const target = await resolveDispatchSalesTarget({dispatchTargetRef: fixture.salesRef});
    const command = {action: "link_po",targetRef: fixture.salesRef,targetSignature: target.signature,
      payload: {poRef: purchase.purchaseRef,targetLineKey: target.lines[0].targetLineKey,
        poLineId: purchase.poLineId,quantities: {pieces: 5}}};
    const before = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id",[fixture.base+1])).rows;
    const linked = await execute({...command});
    assert.equal(linked.allocations.length,1);
    const allocation = (await query("SELECT allocated_sales_qty,allocated_piece_qty FROM dispatch_so_po_allocations WHERE id=$1",[linked.allocations[0].id])).rows[0];
    assert.equal(Number(allocation.allocated_sales_qty),5);
    assert.equal(Number(allocation.allocated_piece_qty),5);
    assert.deepEqual((await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id",[fixture.base+1])).rows,before);
    assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1",[fixture.base+1])).rows[0].operator_status,"packed");
    await query("UPDATE sales_order_lines SET loaded_qty=1 WHERE sales_order_id=$1",[fixture.base+1]);
    await assert.rejects(execute({...command}),error=>error.code==="OPERATOR_ACTIVITY_STARTED");
  });
});

test("packed TO and SO can change from replenishment to direct pickup through the command path",async () => {
  await rollbackTest(async fixture => {
    await setPacking(fixture,"packed","packed");
    const dependency = await link(fixture);
    await updateOrderDependencyMode(dependency.id,"yard_replenishment");
    await query("UPDATE order_dependencies SET status='packed' WHERE id=$1",[dependency.id]);
    const changed = await execute({action: "change_mode",targetRef: fixture.salesRef,
      payload: {dependencyId: dependency.id,mode: "direct_to_customer"}});
    assert.equal(changed.dependency.mode,"direct_to_customer");
    assert.equal((await query("SELECT packed_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'",[fixture.base+2])).rows[0].packed_piece_qty,"10");
    assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1",[fixture.base+1])).rows[0].operator_status,"packed");
  });
});

test("Dispatch can save a new direct-pickup assignment when both the TO and dependent SO are packed",async () => {
  await rollbackTest(async fixture => {
    await setPacking(fixture,"packed","packed");
    await link(fixture);
    await link(fixture);
    const header = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES('2099-10-01','draft',0) RETURNING id")).rows[0];
    await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,'[]','[]','{}')",[header.id]);
    const orders = [{id: fixture.salesRef,type: "SO",sourceYard: "3445",pickupLocations: ["3445"],
      address: "100 Test Street",pieces: 10,items: [{itemId: fixture.base,pieces: 10,quantity: 10,unit: "EA"}]}];
    const trucks = [{id: "PACK-TRUCK",plate: "PACK-TEST",loads: [{id: "PACK-LOAD",stops: [
      {id: "PACK-PICK",type: "pick",location: "3445",orderRefs: [fixture.salesRef]},
      {id: "PACK-DROP",type: "drop",orderId: fixture.salesRef}]}]}];
    const saved = await applyDispatchV2Command({planId: header.id,command: {commandId: crypto.randomUUID(),commandType: "replace_plan",
      baseRevision: 0,compactReceipt: true,payload: {orders,trucks,summary: {}}}});
    assert.equal(saved.payload.plan.revision,1);
    assert.deepEqual(await validateDispatchPlanDependencies(saved.payload.plan),[]);
    assert.equal((await query("SELECT outbound_operator_status FROM transfer_orders WHERE netsuite_id=$1",[fixture.base+2])).rows[0].outbound_operator_status,"packed");
    assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1",[fixture.base+1])).rows[0].operator_status,"packed");
  });
});

test("Operator loading remains an execution blocker even when the packing header says packed", async () => {
  await rollbackTest(async fixture => {
    await setPacking(fixture,"packed","packed");
    await query(`UPDATE transfer_order_lines SET loaded_qty=1 WHERE transfer_order_id=$1 AND line_stage='outbound'`,[fixture.base+2]);
    const preview = await previewScmDependencyMutation({action: "link_to",targetRef: fixture.salesRef,
      payload: {transferOrderRef: fixture.transferRef}}, {id: "packing-regression"});
    assert.equal(preview.allowed,false);
    assert.ok(preview.blockers.some(blocker => blocker.code === "OPERATOR_ACTIVITY_STARTED"));
    await assert.rejects(link(fixture),error => error.code === "DEPENDENCY_EXECUTION_STARTED");
    await query("UPDATE transfer_order_lines SET loaded_qty=0 WHERE transfer_order_id=$1",[fixture.base+2]);
    await query("UPDATE transfer_orders SET fulfillment_status='loaded' WHERE netsuite_id=$1",[fixture.base+2]);
    await assert.rejects(link(fixture),error => error.message.includes("already started"));
  });
});

test("packing does not waive the transfer-before-dependent-pickup route rule", async () => {
  await rollbackTest(async fixture => {
    await setPacking(fixture,"packed","packed");
    const dependency = await link(fixture);
    await updateOrderDependencyMode(dependency.id,"yard_replenishment");
    const plan = {id: 0,planDate: "2099-10-01",orders: [{id: fixture.salesRef,type: "SO"}],
      trucks: [{plate: "TEST",loads: [{id: "dependent",stops: [
        {id: "pick",type: "pick",location: "12441"},
        {id: "drop",type: "drop",orderId: fixture.salesRef}]}]}]};
    assert.ok((await validateDispatchPlanDependencies(plan)).some(message => message.includes(fixture.transferRef)));
  });
});

test("legacy packed dependency status permits unlink without rewriting Operator packing",async () => {
  await rollbackTest(async fixture => {
    const dependency = await link(fixture);
    await setPacking(fixture,"packed","packed");
    await query("UPDATE order_dependencies SET status='packed' WHERE id=$1",[dependency.id]);
    const preview = await previewScmDependencyMutation({action: "unlink_to",targetRef: fixture.salesRef,
      payload: {dependencyId: dependency.id}}, {id: "packing-regression"});
    assert.equal(preview.allowed,true,JSON.stringify(preview.blockers));
    await cancelOrderDependency(dependency.id);
    assert.equal((await query("SELECT status FROM order_dependencies WHERE id=$1",[dependency.id])).rows[0].status,"cancelled");
    assert.equal((await query("SELECT outbound_operator_status FROM transfer_orders WHERE netsuite_id=$1",[fixture.base+2])).rows[0].outbound_operator_status,"packed");
  });
});

test("legacy packing status does not block dependency group and ungroup remapping",async () => {
  await rollbackTest(async fixture => {
    const dependency = await link(fixture);
    await updateOrderDependencyMode(dependency.id,"yard_replenishment");
    await query("UPDATE order_dependencies SET status='packed' WHERE id=$1",[dependency.id]);
    const header = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-10-01','draft') RETURNING id")).rows[0];
    const groupRef = `GO-PACK-${fixture.base}`;
    const plan = {id: header.id,planDate: "2099-10-01",orders: [{id: groupRef,type: "SO",childOrders: [fixture.salesRef]}],trucks: []};
    const grouped = await syncOrderDependenciesFromDispatchPlan(plan);
    assert.equal(grouped.remapped[0]?.dependencyId,dependency.id);
    assert.equal((await query("SELECT dispatch_target_ref FROM order_dependencies WHERE id=$1",[dependency.id])).rows[0].dispatch_target_ref,groupRef);
    const ungrouped = await syncOrderDependenciesFromDispatchPlan({...plan,orders: [{id: fixture.salesRef,type: "SO"}]},
      {allowEstablishedUngroupTargets: [{sourceOrderRef: fixture.salesRef,groupRef}]});
    assert.equal(ungrouped.released[0]?.dependencyId,dependency.id);
    assert.equal((await query("SELECT dispatch_target_ref FROM order_dependencies WHERE id=$1",[dependency.id])).rows[0].dispatch_target_ref,fixture.salesRef);
  });
});

test("legacy packing status cannot hide loading when assigning a new direct pickup",async () => {
  await rollbackTest(async fixture => {
    const dependency = await link(fixture);
    await query("UPDATE order_dependencies SET status='packed' WHERE id=$1",[dependency.id]);
    await query("UPDATE transfer_orders SET fulfillment_status='loaded' WHERE netsuite_id=$1",[fixture.base+2]);
    const plan = {id: 0,planDate: "2099-10-01",orders: [{id: fixture.salesRef,type: "SO",pickupLocations: ["3445"]}],
      trucks: [{plate: "TEST",loads: [{id: "new-load",stops: [
        {id: "pick",type: "pick",location: "3445"},
        {id: "drop",type: "drop",orderId: fixture.salesRef}]}]}]};
    assert.ok((await validateDispatchPlanDependencies(plan)).some(message => message.includes("already started")));
  });
});
