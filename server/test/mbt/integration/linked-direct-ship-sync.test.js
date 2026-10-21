// @ts-check
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query, withTransaction, pool } from "../../../src/db.js";
import { getDeliveryOrder, listDeliveryOrders, listDeliveryLoadOrders } from "../../../src/delivery-repository.js";
import { reconcileLinkedDirectShipQuantities } from "../../../src/linked-direct-ship-sync-repository.js";
import { upsertOutboundTransferOrderLines, upsertSalesOrderLines, markMissingOutboundOrderLines } from "../../../src/order-sync-repository.js";
import { updateOrderDependencyMode, syncOrderDependenciesFromDispatchPlan } from "../../../src/order-dependency-repository.js";

after(closeDb);
let sequence = 0;
async function seed(mode = "direct_to_customer") {
      const base = 9957100000 + (sequence += 10);
      const f = { salesId: base, otherSalesId: base + 1, transferId: base + 2,
        salesRef: `SO-SYNC-${base}`, otherSalesRef: `SO-PALLET-${base}`, groupRef: `GO-SYNC-${base}` };
      for (const [id, ref] of [[f.salesId, f.salesRef], [f.otherSalesId, f.otherSalesRef]]) {
        await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,sales_order_type,
          outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
          VALUES($1,$2,'Sync fixture','B','Pending Fulfillment','Delivery',28,'2967','partial_loaded','Partial Loaded','not_fulfilled',true)`, [id, ref]);
      }
      await query("INSERT INTO dispatch_plans(id,plan_date,status) VALUES($1,current_date,'draft')", [base+3]);
      await query(`INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type,active) VALUES($1,$2,current_date,'sales_order',true)`, [f.groupRef,base+3]);
      await query(`INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position) VALUES($1,$2,0),($1,$3,1)`, [f.groupRef,f.salesRef,f.otherSalesRef]);
      const rows = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,unit,
        pallet_qty,piece_qty,to_plt,to_lyr,to_pcs,loaded_qty,location_id,location,netsuite_active)
        VALUES($1,1,1189,'BWS-PW-REG-GM','InvtPart',90,'PC',1,30,60,0,1,0,28,'2967',true),
        ($1,2,3632,'UNI-WIN70T-RDM-GN','InvtPart',91.88,'SQFT',1,0,91.88,10.21,0,0,28,'2967',true),
        ($2,3,1784,'PALLET','InvtPart',14,'EACH',0,0,0,0,0,11,28,'2967',true) RETURNING *`, [f.salesId,f.otherSalesId])).rows;
      f.salesLines = rows;
      await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
        outbound_operator_status,receiving_status,netsuite_active) VALUES($1,$2,'B','Pending Fulfillment',1,'3445',28,'2967','loaded','partial_received',true)`,
      [f.transferId,`TO-SYNC-${base}`]);
      const transfer = (await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,item_name,item_type,quantity,unit,
        pallet_qty,piece_qty,to_plt,to_lyr,to_pcs,loaded_qty,netsuite_active)
        VALUES($1,11,'outbound',1189,'BWS-PW-REG-GM','InvtPart',90,'PC',1,30,60,0,1,90,true),
        ($1,12,'outbound',3632,'UNI-WIN70T-RDM-GN','InvtPart',91.88,'SQFT',1,0,91.88,10.21,0,91.88,true),
        ($1,13,'outbound',1784,'PALLET','InvtPart',3,'EACH',0,3,0,0,0,3,true) RETURNING *`, [f.transferId])).rows;
      f.transferLines = transfer;
      f.dependencyId = (await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,dispatch_target_ref,dispatch_target_kind,
        transfer_order_id,transfer_order_ref,dependency_mode,status,source_location_id,source_location,accounting_destination_location_id,
        accounting_destination_location) VALUES($1,$2,$3,'group',$4,$5,$6,'received_local',1,'3445',28,'2967') RETURNING id`,
      [f.salesId,f.salesRef,f.groupRef,f.transferId,`TO-SYNC-${base}`,mode])).rows[0].id;
      await query(`INSERT INTO order_dependency_lines(dependency_id,sales_line_id,transfer_outbound_line_id,item_id,item_name,unit,
        allocated_quantity,pallet_qty,piece_qty,loaded_quantity,delivered_quantity,locally_received_quantity,dispatch_target_line_key)
        VALUES($1,$2,$3,1189,'BWS-PW-REG-GM','PC',6,0,6,6,6,6,$4)`,
      [f.dependencyId,rows[0].id,transfer[0].id,`${f.groupRef}::${f.salesRef}::${rows[0].id}`]);
      return f;
}
async function fixture(operation, mode = "direct_to_customer") {
  const rollback = await beginRollbackContext();
  try { return await rollback.run(async () => operation(await seed(mode))); }
  finally { await rollback.rollback(); }
}
async function allocations(f) {
  return (await query("SELECT * FROM order_dependency_lines WHERE dependency_id=$1 ORDER BY sales_line_id", [f.dependencyId])).rows;
}

test("SOA10172 shape reconciles both materials and PALLET across the exact group without rewriting execution", () => fixture(async f => {
  await reconcileLinkedDirectShipQuantities({ transferOrderId: f.transferId });
  const lines = await allocations(f);
  assert.deepEqual(lines.map(line => [Number(line.item_id),Number(line.allocated_quantity)]), [[1189,90],[3632,91.88],[1784,3]]);
  assert.equal(Number(lines[0].loaded_quantity),6);
  assert.equal(Number(lines[0].delivered_quantity),6);
  assert.equal(Number(lines[0].locally_received_quantity),6);
  assert.equal(Number(lines[1].delivered_quantity),0);
  const materialOrder = await getDeliveryOrder(f.salesId);
  assert.ok(materialOrder.lines.every(line => line.no_yard_load_required));
  const palletOrder = await getDeliveryOrder(f.otherSalesId);
  assert.equal(palletOrder.lines[0].operator_required_sales_qty,11);
  assert.equal(Number(palletOrder.lines[0].loaded_qty),11);
  const audit = (await query("SELECT * FROM dispatch_audit_log WHERE action='netsuite.direct_ship.quantities_reconciled' AND entity_id=$1", [String(f.dependencyId)])).rows;
  assert.equal(audit.length,1);
  assert.ok(audit[0].before_state);
  assert.ok(audit[0].after_state);
  await reconcileLinkedDirectShipQuantities({ transferOrderId: f.transferId });
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE action='netsuite.direct_ship.quantities_reconciled' AND entity_id=$1", [String(f.dependencyId)])).rows[0].n,1);
}));

async function visibility(f,status="active") {
  const rows=await listDeliveryOrders({locationId:28,status,orderType:"sales_order"});
  return rows.filter(order=>[String(f.salesId),String(f.otherSalesId),f.groupRef].includes(String(order.netsuite_id)));
}

test("completed direct TO yard work disappears from active and planned lists without marking orders loaded", () => fixture(async f => {
  assert.ok((await visibility(f)).some(order=>order.netsuite_id===f.groupRef));
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  const before=(await query("SELECT id,loaded_qty,packed_sales_qty FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id",[[f.salesId,f.otherSalesId]])).rows;
  assert.deepEqual(await visibility(f),[]);
  const date=(await query("SELECT current_date::text AS date")).rows[0].date;
  const planned=await listDeliveryLoadOrders({locationId:28,planDate:date});
  assert.ok(!planned.some(order=>[f.groupRef,String(f.salesId),String(f.otherSalesId)].includes(String(order.netsuite_id))));
  assert.deepEqual((await query("SELECT id,loaded_qty,packed_sales_qty FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id",[[f.salesId,f.otherSalesId]])).rows,before);
  assert.ok((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]])).rows.every(order=>order.operator_status==="partial_loaded"));
}));

test("completed direct-linked children stay hidden when their group is retired", () => fixture(async f => {
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  await query("UPDATE dispatch_delivery_groups SET active=false WHERE group_ref=$1",[f.groupRef]);
  await query("UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
  assert.deepEqual(await visibility(f),[]);
}));

test("locally loaded group members without a direct link do not reappear after their completed group disappears", () => fixture(async f => {
  const child=f.salesId+4,ref=`SO-LOCAL-DONE-${child}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,sales_order_type,
    outbound_location_id,outbound_location,operator_status,local_yard_order_status,fulfillment_status,netsuite_active)
    VALUES($1,$2,'Visibility fixture','B','Pending Fulfillment','Delivery',28,'2967','open','Partial Loaded','not_fulfilled',true)`,[child,ref]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,unit,loaded_qty,netsuite_active)
    VALUES($1,1,7777,'LOCAL-ALREADY-LOADED','InvtPart',30,'PC',30,true)`,[child]);
  await query("INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position) VALUES($1,$2,2)",[f.groupRef,ref]);
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  const rows=await listDeliveryOrders({locationId:28,orderType:"sales_order"});
  assert.ok(!rows.some(order=>[String(child),String(f.salesId),String(f.otherSalesId),f.groupRef].includes(String(order.netsuite_id))));
}));

test("stale preparing status does not keep fully covered direct work on the operator list", () => fixture(async f => {
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  await query("UPDATE sales_orders SET operator_status='preparing' WHERE netsuite_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
  assert.deepEqual(await visibility(f),[]);
}));

test("an explicitly authorized reload remains visible after original direct work is satisfied", () => fixture(async f => {
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  const cycle=(await query(`INSERT INTO operator_reload_cycles(sales_order_id,order_ref,outbound_location_id,cycle_number,request_id,status,reason)
    VALUES($1,$2,28,1,$3,'authorized','Explicit reload visibility fixture') RETURNING id`,
  [f.salesId,f.salesRef,`00000000-0000-4000-8000-${String(f.salesId).padStart(12,"0")}`])).rows[0].id;
  await query(`INSERT INTO operator_reload_cycle_lines(cycle_id,sales_order_line_id,netsuite_line_id,item_id,item_name,sales_uom,target_sales_qty,to_pcs,target_piece_qty,selected_for_reattempt,selection_reason)
    VALUES($1,$2,1,1189,'BWS-PW-REG-GM','PC',10,1,10,true,'Explicit reload visibility fixture')`,[cycle,f.salesLines[0].id]);
  assert.equal((await getDeliveryOrder(f.salesId)).reload_authorized,true);
  assert.ok((await visibility(f)).some(order=>order.netsuite_id===f.groupRef || String(order.netsuite_id)===String(f.salesId)));
}));

test("remaining local quantity and cancelled direct supply stay visible", () => fixture(async f => {
  await query("UPDATE transfer_order_lines SET quantity=60,pallet_qty=1,piece_qty=0 WHERE id=$1",[f.transferLines[0].id]);
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  assert.ok((await visibility(f)).some(order=>order.netsuite_id===f.groupRef));
  const detail=await getDeliveryOrder(f.groupRef);
  assert.ok(detail.lines.some(line=>Number(line.item_id)===3632 && line.no_yard_load_required),"direct-ship reference stays in an order that has yard work");
  assert.ok(detail.lines.some(line=>Number(line.item_id)===1189 && Number(line.quantity)>0),"remaining local work stays in the same order");
  await query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1",[f.dependencyId]);
  assert.ok((await visibility(f)).some(order=>order.netsuite_id===f.groupRef));
}));

test("packed stock and over-allocated direct supply remain discoverable", () => fixture(async f => {
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  await query("UPDATE sales_order_lines SET packed_pallet_qty=1 WHERE id=$1",[f.salesLines[0].id]);
  assert.ok((await visibility(f)).some(order=>order.netsuite_id===f.groupRef));
  assert.ok((await visibility(f,"packed")).some(order=>order.netsuite_id===f.groupRef));
  await query("UPDATE sales_order_lines SET packed_pallet_qty=0 WHERE id=$1",[f.salesLines[0].id]);
  await query("UPDATE order_dependency_lines SET allocated_quantity=91 WHERE dependency_id=$1 AND item_id=1189",[f.dependencyId]);
  assert.equal((await getDeliveryOrder(f.salesId)).lines[0].linked_quantity_blocked,true);
  assert.ok((await visibility(f)).some(order=>order.netsuite_id===f.groupRef));
}));

test("fully covered TO and PO references leave the work list and return with references when yard work reopens", () => fixture(async f => {
  const poId=f.transferId+20;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor,status,status_text,netsuite_active) VALUES($1,$2,'Visibility fixture','B','Pending Receipt',true)",[poId,`PO-VISIBLE-${poId}`]);
  const poLine=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_type,quantity,unit,netsuite_active) VALUES($1,1,3632,'UNI-WIN70T-RDM-GN','InvtPart',91.88,'SQFT',true) RETURNING id",[poId])).rows[0].id;
  await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,allocated_pallet_qty,status,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
    VALUES($1,$2,$3,$4,$5,$6,3632,'UNI-WIN70T-RDM-GN','UNI-WIN70T-RDM-GN',91.88,1,'active',$7,'group',$8)`,[f.salesId,f.salesRef,f.salesLines[1].id,poId,`PO-VISIBLE-${poId}`,poLine,f.groupRef,`${f.groupRef}::${f.salesRef}::${f.salesLines[1].id}`]);
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  assert.ok((await getDeliveryOrder(f.salesId)).lines.every(line=>line.no_yard_load_required));
  assert.deepEqual(await visibility(f),[]);
  await query("UPDATE dispatch_so_po_allocations SET allocated_sales_qty=80 WHERE sales_line_id=$1",[f.salesLines[1].id]);
  assert.ok((await visibility(f)).some(order=>order.netsuite_id===f.groupRef));
  const detail=await getDeliveryOrder(f.groupRef);
  assert.ok(detail.lines.some(line=>Number(line.item_id)===1189 && line.no_yard_load_required));
  assert.ok(detail.lines.some(line=>Number(line.item_id)===3632 && Number(line.quantity)>0));
}));

test("actual TO line refresh and deletion update linked direct shipping", () => fixture(async f => {
  await upsertOutboundTransferOrderLines(f.transferId, f.transferLines.map(line => ({...line, quantity: Number(line.item_id) === 1189 ? 60 : line.quantity })));
  assert.equal(Number((await allocations(f)).find(line => Number(line.item_id) === 1189).allocated_quantity),60);
  await markMissingOutboundOrderLines(f.transferId,[11,13]);
  assert.equal(Number((await allocations(f)).find(line => Number(line.item_id) === 3632).allocated_quantity),0);
}));

test("actual SO quantity edits refresh the linked coverage", () => fixture(async f => {
  await upsertSalesOrderLines(f.salesId,f.salesLines.filter(line => Number(line.sales_order_id) === f.salesId)
    .map(line => ({...line, quantity: Number(line.item_id) === 1189 ? 30 : line.quantity,
      pallet_qty: Number(line.item_id) === 1189 ? 0 : line.pallet_qty, piece_qty: Number(line.item_id) === 1189 ? 30 : line.piece_qty })));
  assert.equal(Number((await allocations(f)).find(line => Number(line.item_id) === 1189).allocated_quantity),30);
}));

test("replenishment and cancelled relationships retain their explicit quantities", () => fixture(async f => {
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
  await query("UPDATE order_dependencies SET dependency_mode='direct_to_customer',status='cancelled' WHERE id=$1",[f.dependencyId]);
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
},"yard_replenishment"));

test("changed NetSuite SO and TO line numbers match their replacement items", () => fixture(async f => {
  const oldAllocation=(await allocations(f))[0];
  await query("UPDATE sales_order_lines SET netsuite_active=false WHERE id=$1",[f.salesLines[0].id]);
  await query("UPDATE transfer_order_lines SET netsuite_active=false WHERE id=$1",[f.transferLines[0].id]);
  await upsertSalesOrderLines(f.salesId,[{...f.salesLines[0],line_id:101}]);
  await upsertOutboundTransferOrderLines(f.transferId,[{...f.transferLines[0],line_id:111}]);
  const replacement=(await allocations(f)).find(line => Number(line.item_id)===1189);
  assert.equal(replacement.id,oldAllocation.id);
  assert.notEqual(replacement.sales_line_id,oldAllocation.sales_line_id);
  assert.notEqual(replacement.transfer_outbound_line_id,oldAllocation.transfer_outbound_line_id);
  assert.equal(Number(replacement.allocated_quantity),90);
  assert.equal(Number(replacement.delivered_quantity),6);
}));

test("audit failure rolls back every changed allocation", () => fixture(async f => {
  await query(`CREATE FUNCTION pg_temp.reject_direct_ship_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'direct ship audit rejected'; END $$`);
  await query(`CREATE TRIGGER reject_direct_ship_audit BEFORE INSERT ON dispatch_audit_log
    FOR EACH ROW WHEN(NEW.action='netsuite.direct_ship.quantities_reconciled') EXECUTE FUNCTION pg_temp.reject_direct_ship_audit()`);
  await assert.rejects(reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId}), /direct ship audit rejected/);
  const remaining=await allocations(f);
  assert.equal(remaining.length,1);
  assert.equal(Number(remaining[0].allocated_quantity),6);
}));

test("finite zero requirements preserve history while invalid database quantities are rejected", () => fixture(async f => {
  await query("UPDATE order_dependency_lines SET allocated_quantity=0 WHERE dependency_id=$1",[f.dependencyId]);
  assert.equal(Number((await allocations(f))[0].delivered_quantity),6);
  for(const value of [-1,"NaN","Infinity"]){
    await query("SAVEPOINT invalid_quantity");
    await assert.rejects(query("UPDATE order_dependency_lines SET allocated_quantity=$2 WHERE dependency_id=$1",[f.dependencyId,value]),
      error => error.code==="23514");
    await query("ROLLBACK TO SAVEPOINT invalid_quantity");
  }
}));

test("two connections refreshing competing linked TOs cannot duplicate sales coverage", async () => {
  const f=await withTransaction(() => seed());
  const otherTransferId=f.transferId+1000;
  try {
    await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,netsuite_active)
      VALUES($1,$2,'B','Pending Fulfillment',1,'3445',28,'2967',true)`,[otherTransferId,`TO-RACE-${otherTransferId}`]);
    const otherLine=(await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,item_name,item_type,quantity,unit,
      pallet_qty,piece_qty,to_plt,to_pcs,netsuite_active) VALUES($1,211,'outbound',1189,'BWS-PW-REG-GM','InvtPart',90,'PC',1,30,60,1,true) RETURNING id`,[otherTransferId])).rows[0];
    const dep=(await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,dispatch_target_ref,dispatch_target_kind,
      transfer_order_id,transfer_order_ref,dependency_mode,status,source_location_id,source_location,
      accounting_destination_location_id,accounting_destination_location)
      VALUES($1,$2,$3,'group',$4,$5,'direct_to_customer','active',1,'3445',28,'2967') RETURNING id`,
    [f.salesId,f.salesRef,f.groupRef,otherTransferId,`TO-RACE-${otherTransferId}`])).rows[0];
    await query(`INSERT INTO order_dependency_lines(dependency_id,sales_line_id,transfer_outbound_line_id,item_id,item_name,unit,
      allocated_quantity,piece_qty,dispatch_target_line_key) VALUES($1,$2,$3,1189,'BWS-PW-REG-GM','PC',6,6,$4)`,
    [dep.id,f.salesLines[0].id,otherLine.id,`${f.groupRef}::${f.salesRef}::${f.salesLines[0].id}`]);
    await Promise.all([reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId}),
      reconcileLinkedDirectShipQuantities({transferOrderId:otherTransferId})]);
    const total=(await query("SELECT SUM(allocated_quantity) AS qty FROM order_dependency_lines WHERE sales_line_id=$1",[f.salesLines[0].id])).rows[0];
    assert.equal(Number(total.qty),90);
  } finally {
    await query("DELETE FROM order_dependencies WHERE sales_order_id=$1",[f.salesId]);
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=ANY($1::bigint[])",[[f.transferId,otherTransferId]]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id=ANY($1::bigint[])",[[f.transferId,otherTransferId]]);
    await query("DELETE FROM dispatch_plans WHERE id=$1",[f.salesId+3]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
  }
});

test("a retired group target is reported without assigning its items elsewhere", () => fixture(async f => {
  await query("UPDATE dispatch_delivery_groups SET active=false WHERE group_ref=$1",[f.groupRef]);
  const result=await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  assert.equal(result[0].reason,"target_unavailable");
  assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
}));

test("a reconciliation preview shows the exact changes without updating allocations or audits", () => fixture(async f => {
  const preview=await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId,apply:false});
  assert.equal(preview[0].changedLines,3);
  assert.deepEqual(preview[0].after.map(line => Number(line.allocated_quantity)),[90,91.88,3]);
  assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
  const audit=(await query("SELECT COUNT(*)::int AS n FROM dispatch_audit_log WHERE entity_id=$1",[String(f.dependencyId)])).rows[0];
  assert.equal(audit.n,0);
}));

async function makeUnstartedNormalDependency(f) {
  await query("UPDATE order_dependencies SET status='active',dispatch_target_ref=$2,dispatch_target_kind='normal' WHERE id=$1",[f.dependencyId,f.salesRef]);
  await query("UPDATE order_dependency_lines SET loaded_quantity=0,delivered_quantity=0,locally_received_quantity=0,dispatch_target_line_key=$2 WHERE dependency_id=$1",
    [f.dependencyId,`${f.salesRef}::${f.salesRef}::${f.salesLines[0].id}`]);
}
test("switching an edited replenishment link to direct shipping refreshes full current material quantities", () => fixture(async f => {
  await makeUnstartedNormalDependency(f);
  await updateOrderDependencyMode(f.dependencyId,"direct_to_customer");
  assert.deepEqual((await allocations(f)).map(line => Number(line.allocated_quantity)),[90,91.88]);
},"yard_replenishment"));

test("moving a direct link into its group also adds the group's matching PALLET coverage", () => fixture(async f => {
  await makeUnstartedNormalDependency(f);
  await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
  const plan={id:f.salesId+3,planDate:new Date().toISOString().slice(0,10),orders:[{id:f.groupRef,type:"SO",childOrders:[f.salesRef,f.otherSalesRef]}],trucks:[]};
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks) VALUES($1,$2::jsonb,'[]')",[plan.id,JSON.stringify(plan.orders)]);
  await syncOrderDependenciesFromDispatchPlan(plan);
  assert.deepEqual((await allocations(f)).map(line => Number(line.allocated_quantity)),[90,91.88,3]);
}));

test("database errors during target lookup remain errors and leave allocations unchanged", () => fixture(async f => {
  await query("ALTER TABLE dispatch_global_order_groups RENAME TO temporarily_unavailable_groups");
  await assert.rejects(reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId}),error => error.code==="42P01");
  assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
}));

test("a link cancelled while its refresh waits for the target lock cannot be changed", async () => {
  const f=await withTransaction(() => seed());
  const holder=await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`order-dependency:${f.groupRef.toLowerCase()}`]);
    const refresh=reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
    let waiting=false;
    for(let attempt=0;attempt<100;attempt+=1){
      const locks=(await query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0];
      if(locks.n>0){waiting=true;break;}
      await new Promise(resolve => setTimeout(resolve,20));
    }
    assert.ok(waiting,"The refresh reaches the held target lock.");
    await holder.query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1",[f.dependencyId]);
    await holder.query("COMMIT");
    assert.equal((await refresh)[0].changed,false);
    assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
  } finally {
    await holder.query("ROLLBACK");holder.release();
    await query("DELETE FROM order_dependencies WHERE id=$1",[f.dependencyId]);
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1",[f.transferId]);
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id=$1",[f.transferId]);
    await query("DELETE FROM dispatch_plans WHERE id=$1",[f.salesId+3]);
    await query("DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
  }
});

async function waitForBlockedAdvisoryLocks(count) {
  for(let attempt=0;attempt<100;attempt+=1){
    const locks=(await query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0];
    if(locks.n>=count){return;}
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.fail("Expected concurrent operations to reach their held target lock.");
}
async function removeCommittedFixture(f) {
  await query("DELETE FROM order_dependencies WHERE id=$1",[f.dependencyId]);
  await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1",[f.transferId]);
  await query("DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
  await query("DELETE FROM transfer_orders WHERE netsuite_id=$1",[f.transferId]);
  await query("DELETE FROM dispatch_plans WHERE id=$1",[f.salesId+3]);
  await query("DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])",[[f.salesId,f.otherSalesId]]);
}
test("a target moved while its refresh waits must be retried against its new identity", async () => {
  const f=await withTransaction(() => seed()),holder=await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`order-dependency:${f.groupRef.toLowerCase()}`]);
    const refresh=reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
    await waitForBlockedAdvisoryLocks(1);
    await holder.query("UPDATE order_dependencies SET dispatch_target_ref=$2,dispatch_target_kind='normal' WHERE id=$1",[f.dependencyId,f.salesRef]);
    await holder.query("COMMIT");
    await assert.rejects(refresh,error => error.code==="DIRECT_SHIP_TARGET_CHANGED");
    assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
    assert.equal((await reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId}))[0].targetRef,f.salesRef);
  } finally {await holder.query("ROLLBACK");holder.release();await removeCommittedFixture(f);}
});
test("mode changes and NetSuite refreshes acquire their target and row locks in the same order", async () => {
  const f=await withTransaction(() => seed()),holder=await pool.connect();
  try {
    await makeUnstartedNormalDependency(f);
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`order-dependency:${f.salesRef.toLowerCase()}`]);
    const refresh=reconcileLinkedDirectShipQuantities({transferOrderId:f.transferId});
    await waitForBlockedAdvisoryLocks(1);
    const mode=updateOrderDependencyMode(f.dependencyId,"direct_to_customer");
    await waitForBlockedAdvisoryLocks(2);
    await holder.query("COMMIT");
    const outcomes=await Promise.allSettled([refresh,mode]);
    assert.deepEqual(outcomes.map(outcome => outcome.status),["fulfilled","fulfilled"]);
  } finally {await holder.query("ROLLBACK");holder.release();await removeCommittedFixture(f);}
});

test("a mode change waiting on a moved target reports its stale target before modifying quantities", async () => {
  const f=await withTransaction(() => seed()),holder=await pool.connect();
  try {
    await makeUnstartedNormalDependency(f);
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`order-dependency:${f.salesRef.toLowerCase()}`]);
    const mode=updateOrderDependencyMode(f.dependencyId,"direct_to_customer");
    await waitForBlockedAdvisoryLocks(1);
    await holder.query("UPDATE order_dependencies SET dispatch_target_ref=$2,dispatch_target_kind='group' WHERE id=$1",[f.dependencyId,f.groupRef]);
    await holder.query("COMMIT");
    await assert.rejects(mode,error => error.code==="ORDER_DEPENDENCY_TARGET_CHANGED");
    assert.equal(Number((await allocations(f))[0].allocated_quantity),6);
  } finally {await holder.query("ROLLBACK");holder.release();await removeCommittedFixture(f);}
});
