import { query } from './db.js';

const ref = value => String(value || '').trim().toUpperCase();

export async function readSpecialDispatchPlans() {
  // Read only identity/schedule fields, not the large item/address snapshots.
  return (await query(`WITH RECURSIVE active AS (
    SELECT plan.id,plan.plan_date::text,plan.status,snapshot.orders,snapshot.trucks
      FROM dispatch_plans plan JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id=plan.id
      WHERE plan.status <> 'cancelled' AND jsonb_array_length(snapshot.trucks)>0
  ), nodes(plan_id,order_ref,type,"originalOrderId","childOrders","childOrderDetails") AS (
    SELECT active.id,node.* FROM active CROSS JOIN LATERAL jsonb_to_recordset(orders)
      AS node(id text, type text, "originalOrderId" text, "childOrders" jsonb, "childOrderDetails" jsonb)
    UNION ALL SELECT nodes.plan_id,child.* FROM nodes CROSS JOIN LATERAL jsonb_to_recordset(
      CASE WHEN jsonb_typeof("childOrderDetails")='array' THEN "childOrderDetails" ELSE '[]'::jsonb END)
      AS child(id text, type text, "originalOrderId" text, "childOrders" jsonb, "childOrderDetails" jsonb)
  ), identities AS (
    SELECT plan_id AS id,jsonb_agg(jsonb_build_object('id',order_ref,'type',type,'originalOrderId',"originalOrderId",
      'childOrders',COALESCE("childOrders",'[]') || COALESCE((SELECT jsonb_agg(child.id)
        FROM jsonb_to_recordset(CASE WHEN jsonb_typeof("childOrderDetails")='array' THEN "childOrderDetails" ELSE '[]'::jsonb END) AS child(id text)),'[]'))) AS orders
      FROM nodes GROUP BY plan_id
  ), schedules AS (
    SELECT id,jsonb_agg(jsonb_build_object('plate',truck->'plate','loads',jsonb_build_array(jsonb_build_object(
      'name',load->'name','returnOnly',load->'returnOnly','stops',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'type',stop->'type','orderId',stop->'orderId','orderRefs',stop->'orderRefs','timing',jsonb_build_object('arrival',stop->'timing'->'arrival')))
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(load->'stops')='array' THEN load->'stops' ELSE '[]'::jsonb END) stop),'[]'))))) AS trucks
      FROM active CROSS JOIN LATERAL jsonb_array_elements(trucks) truck
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(truck->'loads')='array' THEN truck->'loads' ELSE '[]'::jsonb END) load GROUP BY id
  ) SELECT active.id,active.plan_date,active.status,COALESCE(identities.orders,'[]') AS orders,schedules.trucks
    FROM active JOIN schedules USING(id) LEFT JOIN identities USING(id)`)).rows.map(plan => ({ ...plan, plannedOrderReferences: plannedReferences(plan) }));
}

function plannedReferences(plan) {
  const orders = new Map(), planned = new Map();
  function index(order) {
    if (!order || !ref(order.id) || orders.has(ref(order.id))) return;
    orders.set(ref(order.id), order);
    for (const child of order.childOrderDetails || []) index(child);
  }
  for (const order of plan.orders || []) index(order);
  for (const truck of plan.trucks || []) for (const load of truck.loads || []) {
    if (load.returnOnly) continue;
    const loadInfo = { planId: String(plan.id), planDate: String(plan.plan_date || plan.planDate || '').slice(0,10),
      truck: truck.plate || '', load: load.name || '' };
    const visited = new Set();
    function add(value, info) {
      const key = ref(value); if (!key || visited.has(key)) return; visited.add(key);
      // Pickup timing is not the delivery ETA; retain an already mapped drop.
      if (info.estimatedArrivalMinute === null && planned.get(key)?.estimatedArrivalMinute != null) return;
      planned.set(key, info);
      const order = orders.get(key);
      if (order?.type === 'CO') return;
      const parent = ref(order?.originalOrderId) || key.replace(/-S\d+$/, '');
      planned.set(parent, info);
      for (const child of order?.childOrders || []) add(child, info);
      for (const child of order?.childOrderDetails || []) add(child.id, info);
    }
    for (const stop of load.stops || []) {
      if (!['drop','delivery','pickup','pick'].includes(stop.type)) continue;
      visited.clear();
      const arrival = stop.timing?.arrival;
      const estimatedArrivalMinute = ['drop','delivery'].includes(stop.type)
        && arrival !== null && arrival !== undefined && arrival !== ''
        && Number.isFinite(Number(arrival)) && Number(arrival) >= 0 ? Number(arrival) : null;
      const info = { ...loadInfo, estimatedArrivalMinute };
      add(stop.orderId, info); for (const orderRef of stop.orderRefs || []) add(orderRef, info);
    }
  }
  return planned;
}

export function specialPlannedOrderRefs(plan) { return new Set(plannedReferences(plan).keys()); }

export function specialDispatchPlanning(detail, plans) {
  const salesOrder = { planned: false, plans: [] }, purchaseOrder = { planned: false, plans: [] };
  for (const plan of plans) {
    if (plan.status === 'cancelled') continue;
    const refs = plan.plannedOrderReferences || plannedReferences(plan);
    for (const [target, id, name] of [[salesOrder,detail.salesOrderId,detail.salesOrderRef],[purchaseOrder,detail.purchaseOrderId,detail.purchaseOrderRef],[purchaseOrder,detail.purchaseOrderId,detail.purchaseOrderReference]]) {
      const assignment = id && refs.get(ref(name));
      if (assignment) { target.planned = true; target.plans.push(assignment); }
    }
  }
  return { anyPlanned: salesOrder.planned || purchaseOrder.planned, salesOrder, purchaseOrder };
}
