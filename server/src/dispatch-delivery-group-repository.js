import { query, withTransaction } from "./db.js";
import { dispatchLoadAssignment } from "./dispatch-load-assignment.js";

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isGroupedDispatchOrder(order = {}) {
  return ["SO", "TO"].includes(String(order.type || ""))
    && Array.isArray(order.childOrders)
    && order.childOrders.length > 0;
}

function childOrderRefs(order = {}) {
  const refs = new Set();
  const visiting = new Set();

  const visit = (candidate) => {
    const candidateId = String(candidate?.id || "").trim();
    const children = (Array.isArray(candidate?.childOrders) ? candidate.childOrders : [])
      .map((ref) => String(ref || "").trim())
      .filter(Boolean);
    if (!children.length) {
      if (candidateId) refs.add(candidateId);
      return;
    }
    if (candidateId && visiting.has(candidateId)) return;
    if (candidateId) visiting.add(candidateId);

    const detailById = new Map(
      (Array.isArray(candidate?.childOrderDetails) ? candidate.childOrderDetails : [])
        .filter((detail) => detail?.id)
        .map((detail) => [String(detail.id), detail])
    );
    for (const childRef of children) {
      const detail = detailById.get(childRef);
      if (detail && Array.isArray(detail.childOrders) && detail.childOrders.length) visit(detail);
      else refs.add(childRef);
    }
    if (candidateId) visiting.delete(candidateId);
  };

  visit(order);
  return [...refs].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

function findGroupAssignment(plan, groupRef) {
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      if (!(load.stops || []).some((stop) => stop?.type === "drop" && String(stop.orderId || "") === groupRef)) continue;
      const assignment = dispatchLoadAssignment(truck, load);
      return {
        truckPlate: assignment.truckPlate,
        loadName: String(load.name || ""),
        parkingSpot: assignment.parkingSpot
      };
    }
  }
  return null;
}

function projectGroups(plan = {}) {
  const planDate = dateOnly(plan.planDate || plan.plan_date);
  if (!plan.id || !planDate) return [];
  const groups = [];
  for (const order of plan.orders || []) {
    if (!isGroupedDispatchOrder(order)) continue;
    const groupRef = String(order.id || "").trim();
    if (!groupRef) continue;
    const memberRefs = childOrderRefs(order);
    const assignment = findGroupAssignment(plan, groupRef);
    if (!memberRefs.length || !assignment) continue;
    groups.push({
      groupRef,
      planId: Number(plan.id),
      planDate,
      orderType: order.type === "TO" ? "transfer_order" : "sales_order",
      memberRefs,
      ...assignment
    });
  }
  return groups;
}

export async function syncDispatchDeliveryGroupsFromPlan(plan = {}) {
  const groups = projectGroups(plan);
  const planId = Number(plan.id);
  if (!Number.isInteger(planId)) return { groups: 0, members: 0 };

  await query(
    `UPDATE dispatch_delivery_groups
        SET active = false,
            updated_at = now()
      WHERE plan_id = $1`,
    [planId]
  );
  if (!groups.length) return { groups: 0, members: 0 };

  await query(
    `INSERT INTO dispatch_delivery_groups (
       group_ref, plan_id, plan_date, order_type, truck_plate, load_name,
       parking_spot, active, updated_at
     )
     SELECT value->>'groupRef',
            (value->>'planId')::bigint,
            (value->>'planDate')::date,
            value->>'orderType',
            COALESCE(value->>'truckPlate', ''),
            COALESCE(value->>'loadName', ''),
            COALESCE(value->>'parkingSpot', ''),
            true,
            now()
       FROM jsonb_array_elements($1::jsonb) AS projected(value)
     ON CONFLICT (group_ref) DO UPDATE
       SET plan_id = EXCLUDED.plan_id,
           plan_date = EXCLUDED.plan_date,
           order_type = EXCLUDED.order_type,
           truck_plate = EXCLUDED.truck_plate,
           load_name = EXCLUDED.load_name,
           parking_spot = EXCLUDED.parking_spot,
           active = true,
           updated_at = now()`,
    [JSON.stringify(groups)]
  );

  const groupRefs = groups.map((group) => group.groupRef);
  await query("DELETE FROM dispatch_delivery_group_members WHERE group_ref = ANY($1::text[])", [groupRefs]);
  const members = groups.flatMap((group) => group.memberRefs.map((memberOrderRef, position) => ({
    groupRef: group.groupRef,
    memberOrderRef,
    position
  })));
  await query(
    `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
     SELECT value->>'groupRef', value->>'memberOrderRef', (value->>'position')::integer
       FROM jsonb_array_elements($1::jsonb) AS projected(value)
     ON CONFLICT (group_ref, member_order_ref) DO UPDATE
       SET position = EXCLUDED.position`,
    [JSON.stringify(members)]
  );
  return { groups: groups.length, members: members.length };
}

function mapGroup(row) {
  if (!row) return null;
  return {
    id: row.group_ref,
    type: row.order_type === "transfer_order" ? "TO" : "SO",
    orderType: row.order_type,
    childRefs: Array.isArray(row.child_refs) ? row.child_refs : [],
    planId: row.plan_id,
    planDate: dateOnly(row.plan_date),
    truckPlate: row.truck_plate || "",
    loadName: row.load_name || "",
    parkingSpot: row.parking_spot || ""
  };
}

export async function listDispatchDeliveryGroups({ orderType = "sales_order", includePast = false } = {}) {
  const result = await query(
    `SELECT g.*,
            COALESCE(jsonb_agg(m.member_order_ref ORDER BY m.position)
              FILTER (WHERE m.member_order_ref IS NOT NULL), '[]'::jsonb) AS child_refs
       FROM dispatch_delivery_groups g
       LEFT JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
      WHERE g.active = true
        AND g.order_type = $1
        ${includePast ? "" : "AND g.plan_date >= CURRENT_DATE"}
      GROUP BY g.group_ref
      ORDER BY g.plan_date DESC, g.updated_at DESC, g.group_ref`,
    [orderType]
  );
  return result.rows.map(mapGroup);
}

export async function getDispatchDeliveryGroup(groupRef) {
  const result = await query(
    `SELECT g.*,
            COALESCE(jsonb_agg(m.member_order_ref ORDER BY m.position)
              FILTER (WHERE m.member_order_ref IS NOT NULL), '[]'::jsonb) AS child_refs
       FROM dispatch_delivery_groups g
       LEFT JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
      WHERE g.group_ref = $1
        AND g.active = true
      GROUP BY g.group_ref
      LIMIT 1`,
    [String(groupRef || "").trim()]
  );
  return mapGroup(result.rows[0]);
}

export async function rebuildDispatchDeliveryGroups() {
  return withTransaction(async () => {
    await query("UPDATE dispatch_delivery_groups SET active = false, updated_at = now() WHERE active = true");
    const result = await query(
      `SELECT p.id, p.plan_date::text AS plan_date, s.orders, s.trucks
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.status <> 'cancelled'
        ORDER BY p.updated_at, p.id`
    );
    let groupCount = 0;
    let memberCount = 0;
    for (const row of result.rows) {
      const synced = await syncDispatchDeliveryGroupsFromPlan({
        id: row.id,
        planDate: row.plan_date,
        orders: row.orders || [],
        trucks: row.trucks || []
      });
      groupCount += synced.groups;
      memberCount += synced.members;
    }
    return { plans: result.rowCount, groups: groupCount, members: memberCount };
  });
}
