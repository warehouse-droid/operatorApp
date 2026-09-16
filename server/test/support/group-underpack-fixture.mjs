import { query } from "../../src/db.js";

let nextId = 998190000;
function orderTarget(transfer) {
  return transfer ? {
    table: "transfer_orders", yard: "from_location_id,from_location,to_location_id,to_location", status: "outbound_operator_status",
    yardValues: "1,'3445',28,'Other yard'", lineTable: "transfer_order_lines", orderColumn: "transfer_order_id", stageColumn: ",line_stage", stageValue: ",'outbound'"
  } : {
    table: "sales_orders", yard: "outbound_location_id,outbound_location,sales_order_type,customer", status: "operator_status",
    yardValues: "1,'3445','Delivery','Packing fixture'", lineTable: "sales_order_lines", orderColumn: "sales_order_id", stageColumn: "", stageValue: ""
  };
}
export async function packingOrder(values = {}) {
  const { transfer, ref, quantity, layers, conversion, loaded, salesOnly } = {
    transfer: false, ref: null, quantity: 93.26, layers: 8, conversion: 11.657, loaded: 0, salesOnly: false, ...values
  };
  const packed = values.packed ?? layers;
  const id = ++nextId, orderRef = ref || `${transfer ? "TOB" : "SOB"}${id}`;
  const { table, yard, status, yardValues, lineTable, orderColumn, stageColumn, stageValue } = orderTarget(transfer);
  await query(`INSERT INTO ${table}(netsuite_id,tranid,trandate,status,status_text,${yard},${status},local_yard_order_status,netsuite_active,fulfillment_status)
    VALUES($1,$2,current_date,'B','Pending Fulfillment',${yardValues},'packed','Open',true,'not_fulfilled')`, [id, orderRef]);
  const result = await query(`INSERT INTO ${lineTable}(${orderColumn},line_id,item_id,item_name,sku,item_type,quantity,unit,location_id,location,
    layer_qty,to_lyr,packed_layer_qty,packed_sales_qty,loaded_qty,netsuite_active${stageColumn})
    VALUES($1,1,998190001,'Packing fixture','PACKING-FIXTURE','InvtPart',$2,'SQFT',1,'3445',$3,$4,$5,$6,$7,true${stageValue}) RETURNING id`,
  [id, quantity, salesOnly ? 0 : layers, salesOnly ? 0 : conversion, salesOnly ? 0 : packed, salesOnly ? packed : 0, loaded]);
  return { id, ref: orderRef, lineId: result.rows[0].id, transfer, lineTable };
}

export async function packingGroup(orders) {
  let plan = (await query("SELECT id FROM dispatch_plans WHERE plan_date=current_date LIMIT 1")).rows[0];
  if (!plan) {plan = (await query("INSERT INTO dispatch_plans(plan_date) VALUES(current_date) RETURNING id")).rows[0];}
  const id = `GRP-PACKING-${++nextId}`;
  await query("INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type) VALUES($1,$2,current_date,$3)",
    [id, plan.id, orders[0].transfer ? "transfer_order" : "sales_order"]);
  for (const [position, order] of orders.entries()) {
    await query("INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position) VALUES($1,$2,$3)", [id, order.ref, position]);
  }
  return id;
}

export async function packingState(order) {
  const orderTable = order.transfer ? "transfer_orders" : "sales_orders";
  const column = order.transfer ? "transfer_order_id" : "sales_order_id";
  return { header: (await query(`SELECT * FROM ${orderTable} WHERE netsuite_id=$1`, [order.id])).rows,
    lines: (await query(`SELECT * FROM ${order.lineTable} WHERE ${column}=$1 ORDER BY id`, [order.id])).rows };
}
