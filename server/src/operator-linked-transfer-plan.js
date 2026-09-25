// A direct TO rides the SO's route. Operator needs that assignment while Dispatch
// must continue treating the TO as linked, not independently scheduled.
export function operatorLinkedTransferPlanJoinSql(alias = "transfer_orders") {
  return `LEFT JOIN LATERAL (
    SELECT dependency.planned_plan_id AS linked_plan_id,
           dependency.planned_date AS linked_plan_date,
           dependency.planned_truck_plate AS linked_truck_plate,
           dependency.planned_load_name AS linked_load_name,
           COALESCE(NULLIF(load.value->>'parkingSpot',''),truck.value->>'parkingSpot','') AS linked_parking_spot,
           GREATEST(dependency.created_at,COALESCE(plan.confirmed_at,plan.created_at)) AS linked_planned_at
      FROM order_dependencies dependency
      JOIN dispatch_plans plan ON plan.id=dependency.planned_plan_id AND plan.status='confirmed'
      JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id=plan.id
      CROSS JOIN LATERAL jsonb_array_elements(snapshot.trucks) truck(value)
      CROSS JOIN LATERAL jsonb_array_elements(truck.value->'loads') load(value)
     WHERE dependency.transfer_order_id=${alias}.netsuite_id
       AND NOT COALESCE(${alias}.dispatch_planned,false)
       AND dependency.dependency_mode='direct_to_customer'
       AND dependency.status NOT IN ('cancelled','attention')
       AND dependency.planned_date=plan.plan_date
       AND load.value->>'id'=dependency.planned_load_id
       AND COALESCE(load.value->>'returnOnly','false')<>'true'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(load.value->'stops') stop(value)
         JOIN LATERAL jsonb_array_elements(snapshot.orders) target(value)
           ON target.value->>'id'=stop.value->>'orderId' AND target.value->>'type'='SO'
         WHERE stop.value->>'type'='drop' AND (
           target.value->>'id'=COALESCE(dependency.dispatch_target_ref,dependency.sales_order_ref)
           OR target.value->'childOrders' ? COALESCE(dependency.dispatch_target_ref,dependency.sales_order_ref)
         )
       )
     ORDER BY dependency.id LIMIT 1
  ) operator_linked_plan ON true`;
}

export function operatorTransferPlanValueSql(field, alias = "transfer_orders") {
  if (field === "dispatch_planned") {return `(linked_plan_id IS NOT NULL OR COALESCE(${alias}.dispatch_planned,false))`;}
  const linked = {
    dispatch_plan_date: "linked_plan_date", dispatch_planned_at: "linked_planned_at",
    dispatch_truck_plate: "linked_truck_plate", dispatch_load_name: "linked_load_name",
    dispatch_parking_spot: "linked_parking_spot"
  }[field];
  if (!linked) {throw new Error(`Unsupported Operator plan field: ${field}`);}
  return `COALESCE(${linked},${alias}.${field})`;
}

export function operatorTransferPlanColumnsSql(alias = "transfer_orders") {
  return ["dispatch_planned", "dispatch_plan_date", "dispatch_planned_at", "dispatch_truck_plate",
    "dispatch_load_name", "dispatch_parking_spot"]
    .map(field => `${operatorTransferPlanValueSql(field, alias)} AS ${field}`).join(",\n");
}
