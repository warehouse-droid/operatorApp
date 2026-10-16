import crypto from "node:crypto";
import { query } from "../../../src/db.js";
import { createDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { syncDispatchPlanOrderAssignments } from "../../../src/dispatch-planner-v2-repository.js";
import { seedSalesOrder } from "./fulfilled-so-fixture.js";

export function sourceSplit(parent = "SOA09143") {
  return { id: `${parent}-S2`, type: "SO", originalOrderId: parent, sourceTable: "sales_orders",
    customer: "Resplit fixture", operatorStatus: "open", localYardOrderStatus: "Open",
    pickupLocations: ["3445"], sourceYard: "3445", address: "Retained customer address",
    destinationAddress: "Retained customer address", notes: "Keep delivery instruction",
    dispatchDetailsOverride: { address: "Retained customer address" }, salesQty: 109, pallets: 0,
    items: [{ lineId: 1, itemId: 817159900, itemName: "PALLET", sku: "PALLET", itemType: "InvtPart",
      quantity: 106, unit: "EA", pallets: 0, layers: 0, sections: 0, pieces: 0, itemWeight: 40 },
    { lineId: 2, itemId: 1987, itemName: "Delivery Charge", sku: "Delivery Charge", itemType: "OthCharge",
      quantity: 3, unit: "QTY", pallets: 0, layers: 0, sections: 0, pieces: 0 }] };
}

export function threeParts(source = sourceSplit()) {
  return [36, 35, 35].map(quantity => ({ items: [{ ...source.items[0], quantity },
    { ...source.items[1], quantity: 1 }] }));
}

export async function seedUnfinishedSplit({ date = "2097-10-12", completedFirst = true } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const id = 8_300_000_000 + Number.parseInt(suffix, 16);
  const parent = `SO-RESPLIT-${suffix}`;
  await seedSalesOrder(id, parent, { status: "B" });
  await query("UPDATE sales_order_lines SET quantity=136,pallet_qty=0,item_type='InvtPart',sku='PALLET',item_name='PALLET',item_weight=40 WHERE sales_order_id=$1", [id]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,quantity,netsuite_active)
    VALUES($1,2,1987,'Delivery Charge','Delivery Charge','OthCharge',4,true)`, [id]);
  const source = sourceSplit(parent);
  source.netsuiteId = String(-id);
  await seedSalesOrder(-id, source.id, { status: "B" });
  await query("UPDATE sales_orders SET dispatch_parse_source='dispatch-split' WHERE netsuite_id=$1", [-id]);
  await query("UPDATE sales_order_lines SET quantity=106,pallet_qty=0,item_type='InvtPart',sku='PALLET',item_name='PALLET',item_weight=40 WHERE sales_order_id=$1", [-id]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,quantity,netsuite_active)
    VALUES($1,2,1987,'Delivery Charge','Delivery Charge','OthCharge',3,true)`, [-id]);
  await query(`INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref,status)
    VALUES($1,$2,$3,$4,'active')`, [id, parent, -id, source.id]);
  const historical = await createDispatchPlan({ planDate: "2097-10-02" });
  const current = await createDispatchPlan({ planDate: date });
  const first = { ...structuredClone(source), id: `${parent}-S1`, salesQty: 31,
    items: source.items.map((item, index) => ({ ...item, quantity: index ? 1 : 30 })) };
  const group = { ...structuredClone(first), id: `GOA-RESPLIT-${suffix}`, originalOrderId: "",
    childOrders: [first.id], childOrderDetails: [first], dispatchPlanned: true };
  const trucks = [{ id: `T-${suffix}`, plate: "RESPLIT-HISTORY", loads: [{ id: `L-${suffix}`, name: "Load 1",
    stops: [{ id: `D-${suffix}`, type: "drop", orderId: group.id, orderRefs: [first.id], location: group.address }] }] }];
  const oldPlan = { ...historical, orders: [first, source, group], trucks };
  await syncDispatchDeliveryGroupsFromPlan(oldPlan);
  await syncDispatchPlanOrderAssignments({ ...oldPlan, orders: [source, group] });
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1",
    [historical.id, JSON.stringify([source, group]), JSON.stringify(trucks)]);
  if (completedFirst) { await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,stop_id,driver_login,stop_type,order_refs,status,
    started_at,completed_at,photo_data_urls,job_details) VALUES($1,$2,'2097-10-02',$3,$4,'history','dropoff',$5::jsonb,
    'complete',now(),now(),'["r2://resplit/s1-photo-1","r2://resplit/s1-photo-2"]'::jsonb,$6::jsonb)`,
  [`job-${suffix}`, historical.id, trucks[0].loads[0].id, trucks[0].loads[0].stops[0].id,
    JSON.stringify([first.id]), JSON.stringify({ orderRefs: [first.id], address: group.address })]); }
  const history = async () => ({
    nativeFirst: (await query("SELECT to_jsonb(s) AS value FROM sales_orders s WHERE tranid=$1", [first.id])).rows,
    nativeFirstLines: (await query("SELECT to_jsonb(l) AS value FROM sales_order_lines l JOIN sales_orders s ON s.netsuite_id=l.sales_order_id WHERE s.tranid=$1 ORDER BY l.id", [first.id])).rows,
    first: (await query("SELECT to_jsonb(s) AS value FROM dispatch_global_order_splits s WHERE split_ref=$1", [first.id])).rows,
    group: (await query("SELECT to_jsonb(g) AS value FROM dispatch_global_order_groups g WHERE group_ref=$1", [group.id])).rows,
    driver: (await query("SELECT to_jsonb(j) AS value FROM driver_job_records j WHERE job_id=$1", [`job-${suffix}`])).rows,
    assignments: (await query("SELECT to_jsonb(a) AS value FROM dispatch_plan_order_assignments a WHERE plan_id=$1 AND order_ref<>$2 ORDER BY order_ref", [historical.id, source.id])).rows,
    snapshot: (await query(`SELECT trucks, (SELECT jsonb_agg(o) FROM jsonb_array_elements(orders) o WHERE o->>'id'=$2) AS completed
      FROM dispatch_plan_snapshots WHERE plan_id=$1`, [historical.id, group.id])).rows
  });
  return { id, parent, source, first, group, historical, current, history, parts: threeParts(source) };
}

export async function seedResplitPoLink(fixture, target = fixture.source.id) {
  const poId = fixture.id + 1;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor,status,netsuite_active) VALUES($1,$2,'Resplit vendor','pendingReceipt',true)", [poId, `PO-${fixture.parent}`]);
  const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,quantity,netsuite_active)
    VALUES($1,1,817159900,'PALLET','PALLET',136,true) RETURNING id`, [poId])).rows[0].id;
  const salesId = target === fixture.source.id ? -fixture.id : fixture.id;
  const salesLine = (await query("SELECT id FROM sales_order_lines WHERE sales_order_id=$1 AND line_id=1", [salesId])).rows[0].id;
  await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,
    po_line_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
    VALUES($1,$2,$3,$4,$5,$6,30,$7,'split',$8)`, [salesId, target, salesLine, poId, `PO-${fixture.parent}`, line, target, `${target}::${fixture.parent}::1`]);
}
