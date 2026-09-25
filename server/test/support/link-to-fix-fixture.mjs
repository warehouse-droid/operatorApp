import crypto from 'node:crypto';
import { query } from '../../src/db.js';
import { seedCoFixture, insertCoJob, insertLegacyCoJob } from './co-completion-fixture.mjs';
import { getOrderDependencyOptions, createOrderDependency, enrichDispatchOrdersWithDependencies,
  syncOrderDependenciesFromDispatchPlan } from '../../src/order-dependency-repository.js';
import { scmDependencyPayloadHash } from '../../src/scm-dependency-command-service.js';
import { syncDispatchDeliveryGroupsFromPlan } from '../../src/dispatch-delivery-group-repository.js';

export async function seedLinkGroup({ quantities = [4, 6] } = {}) {
  const f = await seedCoFixture();
  f.lines = [];
  for (const [index, ref] of f.members.entries()) {
    const row = (await query(`UPDATE sales_orders SET outbound_location_id=26,outbound_location='150',
      operator_status='open',local_yard_order_status='Open' WHERE tranid=$1 RETURNING netsuite_id`, [ref])).rows[0];
    f.lines.push((await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,
      item_type,item_type_text,quantity,piece_qty,to_pcs,unit,netsuite_backordered_qty,netsuite_active,confirmed)
      VALUES ($1,$2,2340,'LINK-ITEM','LINK-ITEM','InvtPart','Inventory Item',$3,$3,1,'EA',$3,true,false) RETURNING *`,
    [row.netsuite_id, index + 1, quantities[index]])).rows[0]);
  }
  const items = f.lines.map(line => ({ lineRowId: Number(line.id), lineId: line.line_id,
    itemId: 2340, itemName: 'LINK-ITEM', sku: 'LINK-ITEM', quantity: Number(line.quantity),
    pieces: Number(line.quantity), toPcs: 1, unit: 'EA' }));
  f.group = { id: f.groupRef, type: 'SO', sourceYard: '2967', pickupLocations: ['2967'],
    customer: 'Grouped Link Test', address: 'Customer address', childOrders: f.members,
    childOrderDetails: f.members.map((id, i) => ({ id, type: 'SO', items: [items[i]] })), items };
  f.plan.orders.push(f.group);
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [f.plan.id, JSON.stringify(f.plan.orders)]);
  await query(`UPDATE local_co_orders SET details=details||jsonb_build_object('childOrderIds',$2::jsonb)
    WHERE co_ref=$1`, [f.coRef, JSON.stringify(f.members)]);
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES($1,'SO',$2,$3,$4::jsonb,$4::jsonb)`, [f.groupRef, f.plan.id, f.plan.planDate, JSON.stringify(f.group)]);
  for (const [position, ref] of f.members.entries()) {
    await query('INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES($1,$2,$3)', [f.groupRef, ref, position]);
  }
  f.nextDate = (await query("SELECT ($1::date+1)::text AS date", [f.plan.planDate])).rows[0].date;
  f.transferId = 9_995_000_000 + crypto.randomInt(1_000_000);
  f.transferRef = `TO-LINK-${f.transferId}`;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,
    to_location_id,to_location,outbound_operator_status,local_yard_order_status,fulfillment_status,receiving_status,netsuite_active,dispatch_planned)
    VALUES($1,$2,'B','Transfer Order : Pending Fulfillment',28,'2967',26,'150','open','Open','not_fulfilled','not_received',true,false)`, [f.transferId, f.transferRef]);
  for (const stage of ['outbound', 'receiving']) {
    await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,item_name,sku,
      item_type,item_type_text,quantity,piece_qty,to_pcs,unit,netsuite_active,confirmed)
      VALUES($1,1,$2,2340,'LINK-ITEM','LINK-ITEM','InvtPart','Inventory Item',$3,$3,1,'EA',true,false)`,
    [f.transferId, stage, quantities.reduce((a, b) => a + b, 0)]);
  }
  return f;
}

export async function linkCommand(f, { planDate = f.nextDate, mode = 'direct_to_customer' } = {}) {
  const options = await getOrderDependencyOptions({ dispatchTargetRef: f.groupRef, transferOrderRef: f.transferRef, planDate });
  const command = { requestId: crypto.randomUUID(), action: 'link_to', targetRef: f.groupRef, planDate,
    targetSignature: options.targetSignature, payload: { transferOrderRef: f.transferRef, mode,
      allocations: options.matchingLines.map(line => ({ targetLineKey: line.targetLineKey, quantities: line.suggestedQuantities })) } };
  command.payloadHash = scmDependencyPayloadHash(command);
  return command;
}

export async function linkAndPlan(f, { status = 'confirmed', mode = 'direct_to_customer' } = {}) {
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  const command = await linkCommand(f, { planDate: f.plan.planDate, mode });
  f.dependency = await createOrderDependency({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    targetSignature: command.targetSignature, ...command.payload });
  const inserted = (await query('INSERT INTO dispatch_plans(plan_date,status) VALUES($1,$2) RETURNING id', [f.nextDate, status])).rows[0];
  const orders = await enrichDispatchOrdersWithDependencies([f.group]);
  f.deliveryPlan = { id: Number(inserted.id), planDate: f.nextDate, status, orders, trucks: [{ id: 'T-LINK',
    plate: 'LINK-TRUCK', driverLogin: 'link-driver', loads: [{ id: 'linked-load', name: 'Linked Load',
      truckPlate: 'LINK-TRUCK', parkingSpot: 'Spot 7', stops: [
        { id: 'linked-pick', type: 'pick', orderId: f.groupRef, orderRefs: [f.groupRef], location: '2967' },
        { id: 'linked-drop', type: 'drop', orderId: f.groupRef, location: 'Customer address' }
      ] }] }] };
  await query('INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,\'{}\')',
    [f.deliveryPlan.id, JSON.stringify(orders), JSON.stringify(f.deliveryPlan.trucks)]);
  await syncOrderDependenciesFromDispatchPlan(f.deliveryPlan);
  await syncDispatchDeliveryGroupsFromPlan(f.deliveryPlan);
  return f.deliveryPlan;
}

export async function completedSharedCo(f) {
  const other = { id: `TO-SHARED-${f.transferId}`, type: 'TO', sourceYard: '150', pickupLocations: ['150'],
    destinationYard: '2967', address: '2967 Kennedy Road', items: [{ itemId: 2340, quantity: 1, pieces: 1 }] };
  f.plan.orders.push(other);
  f.plan.trucks[0].loads[0].stops[0] = { id: 'co-pick', type: 'pick', orderId: other.id, location: '150',
    orderRefs: [other.id, f.coRef] };
  f.plan.trucks[0].loads[0].stops.push({ id: 'other-drop', type: 'drop', orderId: other.id, location: '150' });
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1',
    [f.plan.id, JSON.stringify(f.plan.orders), JSON.stringify(f.plan.trucks)]);
  const original = await insertLegacyCoJob(f);
  await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [original.id]);
  f.pickup = await insertCoJob(f, { jobId: `${f.plan.id}:T4:co-load:co-pick`, stopId: 'co-pick',
    stopType: 'pickup', location: '150', refs: [other.id, ...f.members], orderTypes: ['TO', 'SO'] });
  f.otherTransferRef = other.id;
  return f;
}

export async function protectedCoHistory(f) {
  return {
    co: (await query('SELECT * FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows,
    lines: (await query('SELECT l.* FROM local_co_order_lines l JOIN local_co_orders c ON c.id=l.co_id WHERE c.co_ref=$1 ORDER BY l.id', [f.coRef])).rows,
    jobs: (await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id', [f.plan.id])).rows,
    events: (await query('SELECT * FROM dispatch_order_completion_events WHERE plan_id=$1 ORDER BY id', [f.plan.id])).rows
  };
}
