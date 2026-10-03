const key = value => String(value ?? "").trim().toLowerCase();

function startedPhysicalOrderRefs(recordedPlan, activity) {
  const refs = new Set();
  const loads = new Map((recordedPlan.trucks || []).flatMap(truck => truck.loads || []).map(load => [key(load.id), load]));
  for (const record of activity) {
    if (!["in_progress", "complete"].includes(key(record.status))) continue;
    if (!["pick", "pickup", "drop", "dropoff"].includes(key(record.stop_type || record.stopType))) continue;
    const load = loads.get(key(record.load_id || record.loadId));
    if (!load) continue;
    const stop = (load.stops || []).find(candidate => key(candidate.id) === key(record.stop_id || record.stopId));
    const recordedRefs = record.order_refs || record.orderRefs || [];
    for (const ref of [...(Array.isArray(recordedRefs) ? recordedRefs : []), stop?.orderId, stop?.orderRef,
      ...(Array.isArray(stop?.orderRefs) ? stop.orderRefs : [])]) {
      if (key(ref)) refs.add(key(ref));
    }
  }
  return refs;
}

/** Freeze derived transport cargo from published evidence, never from a client payload. */
export function freezeRecordedPurchaseOrderProjections({ recordedPlan = {}, projectedOrders = [], activity = [] } = {}) {
  const startedRefs = startedPhysicalOrderRefs(recordedPlan, activity);
  const recordedByRef = new Map((recordedPlan.orders || [])
    .filter(order => ["po", "to"].includes(key(order.type)) && startedRefs.has(key(order.id)))
    .map(order => [key(order.id), order]));
  const preservedPoOrderRefs = new Set(recordedByRef.keys());
  const orders = projectedOrders.map(order => {
    const recorded = recordedByRef.get(key(order.id));
    if (!recorded) return order;
    const frozen = { ...order };
    if (key(order.type) === "to") {
      delete frozen.toRouteProjection;
      if (recorded.toRouteProjection !== undefined) {frozen.toRouteProjection = structuredClone(recorded.toRouteProjection);}
      return frozen;
    }
    const published = recorded.poRouteProjection ?? recorded.po_route_projection;
    delete frozen.poRouteProjection;
    delete frozen.po_route_projection;
    if (published !== undefined) frozen.poRouteProjection = structuredClone(published);
    return frozen;
  });
  return { orders, preservedPoOrderRefs };
}
