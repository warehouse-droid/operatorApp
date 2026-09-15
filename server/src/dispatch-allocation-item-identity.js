const text = (value) => String(value ?? "").trim().toLowerCase();

function visitPlanOrders(plan, visit) {
  const walk = (order) => {
    if (!order || typeof order !== "object") return;
    visit(order);
    for (const child of order.childOrderDetails || []) walk(child);
  };
  for (const order of plan.orders || []) walk(order);
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      for (const order of load.orders || []) walk(order);
    }
  }
}

// An older compact card may lack itemId. Resolve only a unique SKU within the
// same order, using evidence from BOTH plans; conflicting IDs stay conflicting.
// This is comparison-only: never rewrite either caller's saved/draft evidence.
export function comparableAllocationPlans(previousPlan, nextPlan) {
  const idsByOrder = new Map();
  const observe = (order) => {
    const orderId = text(order.id || order.orderId || order.orderRef);
    if (!orderId) return;
    if (!idsByOrder.has(orderId)) idsByOrder.set(orderId, new Map());
    const bySku = idsByOrder.get(orderId);
    for (const item of order.items || []) {
      const sku = text(item.sku);
      const itemId = text(item.itemId ?? item.item_id);
      if (!sku || !itemId) continue;
      if (!bySku.has(sku)) bySku.set(sku, new Set());
      bySku.get(sku).add(itemId);
    }
  };
  visitPlanOrders(previousPlan, observe);
  visitPlanOrders(nextPlan, observe);
  const normalize = (plan) => {
    const copy = structuredClone(plan);
    visitPlanOrders(copy, (order) => {
      const bySku = idsByOrder.get(text(order.id || order.orderId || order.orderRef));
      for (const item of order.items || []) {
        if (text(item.itemId ?? item.item_id)) {
          if (item.itemId !== undefined) item.itemId = text(item.itemId);
          continue;
        }
        const ids = bySku?.get(text(item.sku));
        if (ids?.size === 1) item.itemId = [...ids][0];
      }
    });
    return copy;
  };
  return [normalize(previousPlan), normalize(nextPlan)];
}
