import crypto from "node:crypto";
import { query } from "../../../src/db.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";

export const mossbrook = "94 Mossbrook Crescent, Scarborough, ON M1W 2W9";
export const heatherside = "76 Heatherside Dr, Scarborough, ON M1W 1T7";
export const changedParentAddress = "12 Parent Refresh Road";

export async function seedSplitAddress({ override = false, planDate = "2096-11-12" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const parentId = 8_200_000_000 + Number.parseInt(suffix, 16);
  const parentRef = `SO-ADDR-${suffix}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,
    fulfillment_status,outbound_location_id,outbound_location,sales_order_type,operator_status,
    local_yard_order_status,dispatch_address,netsuite_active)
    VALUES($1,$2,'Address fixture','B','Pending Fulfillment','not_fulfilled',28,'2967',
    'Delivery','open','Open',$3,true)`, [parentId, parentRef, mossbrook]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,
    quantity,unit,piece_qty,to_pcs,netsuite_active) VALUES($1,1,$1,'Address test','ADDRESS',10,'PC',10,1,true)`, [parentId]);
  const parent = (await listDispatchOrders({ type: "SO", exactOrderRefs: [parentRef] }))[0];
  const splits = [1, 2].map(index => ({ ...structuredClone(parent), id: `${parentRef}-S${index}`,
    originalOrderId: parentRef, isSplit: true, pieces: 5, salesQty: 5,
    items: parent.items.map(item => ({ ...item, pieces: 5, quantity: 5, salesQty: 5 })) }));
  if (override) {Object.assign(splits[1], { address: heatherside, destinationAddress: heatherside,
    defaultDestinationAddress: heatherside, dispatchDetailsOverride: { address: heatherside } });}
  const row = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES($1::date,'draft',1) RETURNING id", [planDate])).rows[0];
  const plan = { id: String(row.id), planDate, revision: 1, status: "confirmed", orders: splits,
    trucks: [{ id: `ADDR-${suffix}`, loads: [{ id: `ADDR-LOAD-${suffix}`, stops: splits.map(order => ({
      id: `drop-${order.id}`, type: "drop", orderId: order.id, location: "2967" })) }] }] };
  await syncDispatchDeliveryGroupsFromPlan(plan);
  return { parent, parentId, parentRef, plan, splits };
}
