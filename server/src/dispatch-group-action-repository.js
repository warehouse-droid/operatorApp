import { query, withTransaction } from "./db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { assertNoClosedNetSuiteOrders } from "./netsuite-closed-order-repository.js";
import { upsertDispatchOrderCatalog } from "./dispatch-order-catalog-repository.js";
import { compactDispatchOrderCard, dispatchOrderSearchText } from "./dispatch-planner-optimization.js";
import { aggregateGlobalGroup } from "./dispatch-delivery-group-repository.js";
import { applyActiveTransitCoMetadata } from "./dispatch-planner-performance.js";

const deliveryFields = ["address", "destinationAddress", "defaultDestinationAddress", "deliveryAddressOverride",
  "pickupAddressOverride", "sourceAddress", "defaultSourceAddress", "expectedDeliveryDate", "windowStart", "windowEnd",
  "vendorYard", "instructions", "parseSource"];
const text = value => String(value ?? "").trim();
const failure = (message, code = "DISPATCH_GROUP_ACTION_INVALID") => Object.assign(new Error(message), { status: 409, code });

async function groupDefinition(ref) {
  return (await query(`SELECT group_ref,order_type,full_order,active FROM dispatch_global_order_groups
    WHERE lower(group_ref)=lower($1) FOR UPDATE`, [ref])).rows[0];
}

async function expandGroup(row, state, path = new Set()) {
  const key = row.group_ref.toLowerCase();
  if (!row.active) {
    throw failure(`${row.group_ref} was retired. Reload Dispatch before editing it.`, "DISPATCH_DERIVED_ORDER_RETIRED");
  }
  if (path.has(key)) { throw failure("The grouped order has circular membership. Reload Dispatch."); }
  if (row.order_type !== state.type) { throw failure("Grouped actions require children of the same order type."); }
  const refs = [...new Set((row.full_order.childOrders || []).map(text).filter(Boolean))];
  if (!refs.length) { throw failure("The grouped order has no child orders."); }
  state.groups.set(key, row);
  const nextPath = new Set([...path, key]);
  for (const ref of refs) {
    const nested = await groupDefinition(ref);
    if (nested) { await expandGroup(nested, state, nextPath); }
    else { state.leaves.add(ref); }
    if (state.leaves.size + state.groups.size > 200) { throw failure("This group is too large for one edit."); }
  }
}

function actionSnapshot(order, childOrderDetails) {
  const next = aggregateGlobalGroup(order, childOrderDetails, { preserveTransitCo: true });
  const representative = childOrderDetails[0];
  for (const field of deliveryFields) {
    if (Object.hasOwn(representative, field)) { next[field] = representative[field]; }
  }
  const co = order.transitCo;
  return applyActiveTransitCoMetadata(next, co ? [{ ...co, coRef: co.id, sourceOrderRef: order.id }] : []);
}

async function persistGroups(state, children) {
  const byRef = new Map(children.map(order => [order.id.toLowerCase(), order]));
  for (const row of [...state.groups.values()].reverse()) {
    const childOrderDetails = row.full_order.childOrders.map(ref => byRef.get(ref.toLowerCase()));
    if (childOrderDetails.some(child => !child)) { throw failure("A grouped child is unavailable. Reload Dispatch."); }
    const current = (await groupDefinition(row.group_ref)).full_order;
    const next = await state.projectGroup(actionSnapshot(current, childOrderDetails));
    await query(`UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,
      search_text=$4,updated_at=now() WHERE group_ref=$1`,
    [row.group_ref, JSON.stringify(next), JSON.stringify(compactDispatchOrderCard(next)), dispatchOrderSearchText(next)]);
    byRef.set(row.group_ref.toLowerCase(), next);
  }
  return byRef;
}

// Membership comes from canonical definitions, never the caller's card or a
// formatted reference. One transaction protects both source rows and projections.
export async function applyDispatchGroupAction(orderRef, { types, updateChild, loadChildren, projectGroup }) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const root = await groupDefinition(orderRef);
    if (!root) { return null; }
    if (!types.includes(root.order_type)) {
      throw failure("This group does not support that edit. Use Manage CO to change a CO route.");
    }
    const state = { type: root.order_type, groups: new Map(), leaves: new Set(), projectGroup };
    await expandGroup(root, state);
    const refs = [...state.leaves].sort();
    await assertNoClosedNetSuiteOrders(refs, "change grouped Dispatch details");
    for (const ref of refs) { await updateChild(ref, state.type); }
    const children = await loadChildren(refs, state.type);
    if (children.length !== refs.length || children.some(child => child.type !== state.type)) {
      throw failure("A grouped child is unavailable. No changes were saved. Reload Dispatch.");
    }
    await upsertDispatchOrderCatalog({ orders: children, source: "dispatch-group-action" });
    const byRef = await persistGroups(state, children);
    const order = byRef.get(root.group_ref.toLowerCase());
    await query(`UPDATE dispatch_order_catalog_state SET generation=generation+1,updated_at=now() WHERE singleton=true`);
    return { tranid: root.group_ref, child_order_refs: refs, dispatch_address: order.address, order };
  });
}
