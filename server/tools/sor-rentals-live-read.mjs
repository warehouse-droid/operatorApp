import {query,closeDb} from '/app/src/db.js';
import {listDispatchOrders} from '/app/src/dispatch-repository.js';
import {suiteqlAll} from '/app/src/netsuite.js';
const {projectSorOrder,sorReturnDraft}=await import(/* SOR_POLICY_MODULE */ '');
try {
 const orders=(await listDispatchOrders({type:'SO'})).filter(order=>/^SOR\d+(?:-S\d+)?$/u.test(order.id));
 const ids=[...new Set(orders.flatMap(order=>(order.items||[]).map(item=>Number(item.itemId))).filter(Number.isSafeInteger))];
 const metadata=await suiteqlAll(`SELECT id,itemid,fullname,itemtype FROM item WHERE isinactive='F' AND (
   fullname LIKE '01 MBBS%' OR fullname LIKE '02 MBT%' OR fullname LIKE '03 MBR - Repair%'
   OR fullname LIKE '05 MBR Equip%' OR fullname LIKE '06 TM%' OR LOWER(itemid) LIKE '%/day' OR LOWER(itemid) LIKE '%/month'
   ${ids.length?`OR id IN (${ids.join(',')})`:''})`);
 const policies=new Map(metadata.map(row=>[String(row.id),{itemName:row.itemid,fullName:row.fullname,itemType:row.itemtype}]));
 const completed=(await query("SELECT DISTINCT jsonb_array_elements_text(order_refs) AS ref FROM driver_job_records WHERE stop_type='dropoff' AND status='complete' AND order_refs::text LIKE '%SOR%'")).rows.map(row=>row.ref);
 const existing=(await query("SELECT ref_number,status FROM dispatch_custom_orders WHERE ref_number ~ '^SOR[0-9]+(-S[0-9]+)?-Return$'")).rows;
 const definitions=(await query("SELECT split_ref,parent_order_ref,active,eligible FROM dispatch_global_order_splits WHERE parent_order_ref ~ '^SOR[0-9]+$'")).rows;
 const proposed=orders.map(order=>{
  const decorated=projectSorOrder(order,policies);const draft=sorReturnDraft(decorated);
  return {ref:order.id,sourceYard:order.sourceYard,pickupYard:decorated.sourceYard,completed:completed.includes(order.id),
   planned:order.planned,returnRef:draft?.refNumber,returnQty:draft?.salesQty,hasCustomerAddress:Boolean(draft?.pickupLocation),
   items:decorated.items.map(item=>({itemId:item.itemId,name:item.itemName,type:item.itemType,quantity:item.quantity,rental:item.rentalEquipment,autoReturn:item.sorAutoReturn}))};
 });
 const plans=(await query("SELECT p.id,p.plan_date::text,p.revision FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.status<>'cancelled' AND s.orders::text LIKE '%SOR%' ORDER BY p.plan_date DESC LIMIT 30")).rows;
 const migrations=(await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 4')).rows;
 console.log(JSON.stringify({metadata,proposed,definitions,existing,plans,migrations}));
} finally {await closeDb();}
