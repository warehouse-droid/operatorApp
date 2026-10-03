import { query } from "./db.js";

export async function assertDirectLinkedCargoPlanningAllowed(orderRefs = [], action = "plan these orders") {
  const refs = [...new Set(orderRefs.map(ref => String(ref || "").trim().toLowerCase()).filter(Boolean))];
  if (!refs.length) {return;}
  const { rows } = await query(`
    WITH RECURSIVE group_edges AS (
      SELECT lower(btrim(member.group_ref)) AS parent,lower(btrim(member.member_order_ref)) AS child
        FROM dispatch_global_order_group_members member
        JOIN dispatch_global_order_groups definition ON definition.group_ref=member.group_ref AND definition.active
      UNION
      SELECT lower(btrim(member.group_ref)),lower(btrim(member.member_order_ref))
        FROM dispatch_delivery_group_members member
        JOIN dispatch_delivery_groups definition ON definition.group_ref=member.group_ref AND definition.active
    ), requested(root_ref,ref) AS (
      SELECT ref,ref FROM unnest($1::text[]) ref
      UNION
      SELECT requested.root_ref,edge.child FROM requested JOIN group_edges edge ON edge.parent=requested.ref
    )
    SELECT DISTINCT requested.root_ref AS order_ref
      FROM requested
     WHERE EXISTS (
       SELECT 1 FROM purchase_orders po
        WHERE requested.ref IN (lower(btrim(po.tranid)), lower(btrim(po.dispatch_ref)))
          AND dispatch_po_link_fully_covers(po.netsuite_id)
     ) OR EXISTS (
       SELECT 1 FROM order_dependencies dependency
        WHERE lower(btrim(dependency.transfer_order_ref))=requested.ref
          AND dependency.dependency_mode='direct_to_customer' AND dependency.status<>'cancelled'
          AND (requested.root_ref<>requested.ref OR NOT dispatch_direct_to_has_residual(dependency.transfer_order_id))
     )`, [refs]);
  if (!rows.length) {return;}
  throw Object.assign(new Error(`Cannot ${action}: ${rows.map(row => row.order_ref).join(", ")} contains cargo linked to its Sales Order route. Plan any remaining TO cargo using the TO itself.`), {
    status: 409, code: "DISPATCH_LINKED_CARGO_ONLY", conflicts: rows.map(row => ({ orderRef: row.order_ref }))
  });
}
