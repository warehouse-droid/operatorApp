function text(value) {
  return String(value ?? "").trim();
}

function key(value) {
  return text(value).toLowerCase();
}

function containerKey(primary, secondary, fallback) {
  return key(primary) || key(secondary) || fallback;
}

function placementKey({ truck, load, location }) {
  return JSON.stringify({ truck, load, location });
}

/**
 * Return stable PO/TO dispatch assignments keyed by normalized order ref.
 *
 * Drop stops own the assignment. Pickup stops are intentionally ignored when
 * a drop exists because the planning UI may regenerate or reassign shared
 * pickup representatives while saving an otherwise unrelated edit.
 */
export function dispatchScmAssignmentMap(plan = {}) {
  const assignments = new Map();
  for (const order of Array.isArray(plan?.orders) ? plan.orders : []) {
    const kind = text(order?.type).toUpperCase();
    const ref = text(order?.id);
    const refKey = key(ref);
    if (!refKey || !["PO", "TO"].includes(kind)) continue;
    assignments.set(refKey, {
      ref,
      kind,
      drops: [],
      fallbackStops: []
    });
  }

  for (const [truckIndex, truck] of (Array.isArray(plan?.trucks) ? plan.trucks : []).entries()) {
    const truckKey = containerKey(truck?.id, truck?.plate, `truck:${truckIndex}`);
    for (const [loadIndex, load] of (Array.isArray(truck?.loads) ? truck.loads : []).entries()) {
      const loadKey = containerKey(load?.id, load?.name, `${truckKey}:load:${loadIndex}`);
      for (const stop of Array.isArray(load?.stops) ? load.stops : []) {
        const assignment = assignments.get(key(stop?.orderId));
        if (!assignment) continue;
        const placement = placementKey({
          truck: truckKey,
          load: loadKey,
          location: key(stop?.location || stop?.address || stop?.dropLocation)
        });
        const stopType = key(stop?.type);
        if (["drop", "dropoff"].includes(stopType)) assignment.drops.push(placement);
        else assignment.fallbackStops.push(`${stopType}:${placement}`);
      }
    }
  }

  return new Map([...assignments].map(([refKey, assignment]) => {
    const placements = assignment.drops.length ? assignment.drops : assignment.fallbackStops;
    return [refKey, {
      ref: assignment.ref,
      placed: placements.length > 0,
      signature: JSON.stringify({
        kind: assignment.kind,
        placements: [...placements].sort()
      })
    }];
  }));
}

/**
 * Identify PO/TO orders that are placed after the edit and whose actual
 * truck/load assignment is new or changed.
 */
export function changedPlacedDispatchScmAssignmentRefs(beforePlan = {}, afterPlan = {}) {
  const before = dispatchScmAssignmentMap(beforePlan);
  const after = dispatchScmAssignmentMap(afterPlan);
  return [...after.entries()]
    .filter(([refKey, assignment]) => (
      assignment.placed && before.get(refKey)?.signature !== assignment.signature
    ))
    .map(([, assignment]) => assignment.ref);
}
