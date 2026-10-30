import {query} from '../../src/db.js';
import {seed,source} from './partial-linked-posting-fixture.mjs';

export async function splitSeed(amount=27, sibling=2) {
  const f=await seed(40);
  Object.assign(f,{amount,sibling,group:`GROUP-${f.so}`,child:`${f.so}-S1`,other:`${f.so}-S2`,pickStop:'pickup',dropStop:'delivery'});
  const line=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,quantity,unit,location_id,location,netsuite_active)
    VALUES($1,102,2,1784,'PALLET','PALLET','InvtPart',$2,'EACH',26,'150',true) RETURNING id`,[f.id,amount+sibling])).rows[0].id;
  await query('UPDATE purchase_order_lines SET quantity=$2 WHERE id=$1',[f.pallet,amount]);
  f.splitLine=line;
  f.splitAllocation=(await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,
    allocated_sales_qty,status,dispatch_target_kind,dispatch_target_ref,dispatch_target_line_key,details)
    VALUES($1,$2,$3,$4,$5,$6,1784,'PALLET','PALLET',$7,'active','group',$8,$8||'::'||$2||'::'||$3::bigint::text,'{"poVendorYard":"Partial Vendor"}') RETURNING id`,
    [f.id,f.so,line,f.id+1,f.po,f.pallet,amount,f.group])).rows[0].id;
  f.orders=[{id:f.group,childOrders:[f.child],childOrderDetails:[{id:f.child,originalOrderId:f.so,netsuiteId:String(f.id),items:[{lineRowId:String(line),itemId:1784,quantity:amount}]}]},
    {id:f.other,originalOrderId:f.so,items:[{lineRowId:String(line),itemId:1784,quantity:sibling}]}];
  f.trucks=[{id:'truck',loads:[{id:f.load,stops:[{id:f.pickStop,orderId:f.group,type:'pick'},{id:f.dropStop,orderId:f.group,type:'drop'}]}]}];
  await query('INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks) VALUES($1,$2::jsonb,$3::jsonb)',[f.plan,JSON.stringify(f.orders),JSON.stringify(f.trucks)]);
  return f;
}
export async function splitPickup(f) {
  return (await query(`UPDATE driver_job_records SET order_refs=$2::jsonb,stop_id=$3,
    job_details=job_details||$4::jsonb WHERE job_id=$1 RETURNING id`,
    [f.pick,JSON.stringify([f.child]),f.pickStop,JSON.stringify({orders:[{orderRef:f.child,orderId:f.id}]})])).rows[0].id;
}
export async function splitDrop(f) {
  return (await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,stop_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,current_date,$3,$4,'split-fixture','dropoff',$5::jsonb,'complete',now(),$6::jsonb) RETURNING id`,
    [f.drop,f.plan,f.load,f.dropStop,JSON.stringify([f.child]),JSON.stringify({orders:[{orderRef:f.child,orderId:f.id}],location:'Customer'})])).rows[0].id;
}
export async function splitEvents(f) {
  return (await query('SELECT phase,allocated_sales_qty FROM dispatch_so_po_allocation_execution_events WHERE allocation_id=$1 ORDER BY id',[f.splitAllocation])).rows;
}
export function splitSource(f) {
  const live=source(f);live.lines[1]={...live.lines[1],quantity:f.amount,orderedQuantity:f.amount,remainingQuantity:f.amount};return live;
}
