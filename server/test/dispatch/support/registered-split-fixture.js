import { query } from "../../../src/db.js";
import { overlayFulfilledSalesDeliveryPlanning } from "../../../src/dispatch-fulfilled-so-repository.js";

export async function registerSalesSplit(parent, {
  suffix = "S2", active = true, kind = "split", type = "SO", ref = `${parent}-${suffix}`, order
} = {}) {
  const record = order || { id: ref, type, originalOrderId: parent, scm: { status: "Queued" } };
  await query(`INSERT INTO dispatch_global_order_splits
    (split_ref,order_type,parent_order_ref,source_plan_date,full_order,card,active,definition_kind)
    VALUES ($1,$2,$3,'2096-10-07',$4::jsonb,$4::jsonb,$5,$6)`,
  [ref, type, parent, JSON.stringify(record), active, kind]);
  return ref;
}

export const splitGroup = (refs, id = "GOA-REGISTERED-SPLIT") => ({
  id, type: "SO", childOrders: refs, scm: { status: "Queued" },
  childOrderDetails: refs.map(ref => ({ id: ref, type: "SO", scm: { status: "Queued" } }))
});

export async function registerSplitGroup(order) {
  await query(`INSERT INTO dispatch_global_order_groups
    (group_ref,order_type,source_plan_date,full_order,card,search_text)
    VALUES ($1,'SO','2096-10-07',$2::jsonb,$2::jsonb,$3)`,
  [order.id, JSON.stringify(order), order.id.toLowerCase()]);
  for (const [position, ref] of order.childOrders.entries()) {
    await query(`INSERT INTO dispatch_global_order_group_members (group_ref,member_order_ref,position)
      VALUES ($1,$2,$3)`, [order.id, ref, position]);
  }
}

export const readSplitGroup = async refs => (await overlayFulfilledSalesDeliveryPlanning([splitGroup(refs)]))[0];
