import crypto from 'node:crypto';
import { query } from '../../src/db.js';

export function coPlan({ members = ['SOM06531', 'SOM06537'], groupedTransfers = false, extraTransfer = false } = {}) {
  const children = members.map(id => ({ id, type: 'SO', sourceYard: '2967', address: 'Customer address' }));
  const id = 'CO-GOM-6531-6537';
  const order = { id, type: 'CO', sourceTable: groupedTransfers ? '' : 'local_co_orders',
    sourceOrderId: 'GOM-6531-6537', sourceYard: '150', destinationYard: '2967',
    address: '2967 Kennedy Road, Toronto, ON', childOrders: groupedTransfers ? members.map(ref => `CO-${ref}`) : members,
    childOrderDetails: groupedTransfers ? children.map(child => ({ ...child, id: `CO-${child.id}`, type: 'CO',
      sourceTable: 'local_co_orders', sourceOrderId: child.id, sourceYard: '150', destinationYard: '2967' })) : children };
  const orders = [order];
  const stops = [{ id: 'co-pick', type: 'pick', orderId: id, location: '150' },
    { id: 'co-drop', type: 'drop', orderId: id, location: '150' }];
  if (extraTransfer) {
    orders.push({ id: 'TOB01106', type: 'TO', sourceYard: '150', destinationYard: '2967', address: order.address });
    stops.push({ id: 'to-drop', type: 'drop', orderId: 'TOB01106', location: '150' });
  }
  return { id: 330, planDate: '2039-09-18', orders, trucks: [{ id: 'T4', plate: 'CO-TEST', base: '150',
    driverLogin: 'co-driver', driver: 'CO Driver', loads: [{ id: 'co-load', name: 'CO Load', driverLogin: 'co-driver',
      driverName: 'CO Driver', truckId: 'T4', truckPlate: 'CO-TEST', switchYard: '150', plannedStartMinute: 480,
      plannedFinishMinute: 600, driverSequence: 0, stops }] }] };
}

export async function seedCoFixture() {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const members = [`SO-CO-A-${suffix}`, `SO-CO-B-${suffix}`];
  const plan = coPlan({ members });
  const coRef = `CO-GROUP-${suffix}`;
  const groupRef = `GROUP-${suffix}`;
  plan.orders[0].id = coRef;
  plan.orders[0].sourceOrderId = groupRef;
  for (const stop of plan.trucks[0].loads[0].stops) { stop.orderId = coRef; }
  const inserted = await query(`INSERT INTO dispatch_plans (plan_date,status,note)
    VALUES (DATE '2039-09-18' + nextval('dispatch_plans_id_seq')::int,'draft','CO completion fixture') RETURNING id,plan_date::text`);
  plan.id = Number(inserted.rows[0].id);
  plan.planDate = inserted.rows[0].plan_date;
  await query(`INSERT INTO dispatch_plan_snapshots (plan_id,orders,trucks,summary)
    VALUES ($1,$2::jsonb,$3::jsonb,'{}')`, [plan.id, JSON.stringify(plan.orders), JSON.stringify(plan.trucks)]);
  for (const ref of members) {
    const netsuiteId = 9_992_000_000 + crypto.randomInt(1_000_000);
    await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,fulfillment_status,outbound_location_id,
      outbound_location,sales_order_type,netsuite_active) VALUES ($1,$2,'B','Sales Order : Pending Fulfillment','not_fulfilled',28,'2967','Delivery',true)`, [netsuiteId, ref]);
  }
  await query(`INSERT INTO local_co_orders (co_ref,source_order_ref,from_location_id,from_location,to_location_id,to_location,
    status,delivery_order_id,created_at,updated_at,details) VALUES ($1,$2,26,'150',28,'2967','pending_load',
    -9992000000-nextval('local_co_orders_id_seq'),'2039-09-17','2039-09-17',$3::jsonb)`,
  [coRef, groupRef, JSON.stringify({ sourceOrderId: groupRef, sourceOrderType: 'SO' })]);
  return { plan, coRef, groupRef, members, jobId: `${plan.id}:T4:co-load:co-drop` };
}

export async function insertCoJob(f, { refs = f.members, stopId = 'co-drop', stopType = 'dropoff', location = '2967',
  status = 'complete', jobId = f.jobId, planId = f.plan.id, orderTypes = ['SO'] } = {}) {
  return (await query(`INSERT INTO driver_job_records (job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,
    load_id,load_name,stop_id,stop_type,order_refs,status,started_at,completed_at,photo_data_urls,job_details)
    VALUES ($1,$2,'2039-09-18','co-driver','T4','CO-TEST','co-load','CO Load',$3,$4,$5::jsonb,$6,
      '2039-09-18T17:00:00Z',CASE WHEN $6='complete' THEN '2039-09-18T18:27:33Z'::timestamptz ELSE NULL END,
      '["r2://co-test/original-a","r2://co-test/original-b"]',$7::jsonb) RETURNING *`,
  [jobId, planId, stopId, stopType, JSON.stringify(refs), status, JSON.stringify({ location, dropLocation: location,
    orderTypes, orders: f.members.map(orderRef => ({ orderRef, orderType: 'SALES_ORDER' })) })])).rows[0];
}

export async function insertLegacyCoJob(f) {
  const exists = (await query(`SELECT 1 FROM pg_trigger WHERE tgname='trg_00_driver_co_execution_identity'`)).rowCount;
  if (exists) { await query('ALTER TABLE driver_job_records DISABLE TRIGGER trg_00_driver_co_execution_identity'); }
  try { return await insertCoJob(f); }
  finally { if (exists) { await query('ALTER TABLE driver_job_records ENABLE TRIGGER trg_00_driver_co_execution_identity'); } }
}
