export function activityAllocationScopeFixture({ quantity = 13, status = "complete" } = {}) {
  const children = [
    { id: "SOA08111", type: "SO", items: [{ itemId: 1, sku: "STONE", unit: "PLT", quantity }] },
    { id: "SOA08113", type: "SO", items: [{ itemId: 2, sku: "PALLET", unit: "EACH", quantity: 16 }] }
  ];
  const group = {
    id: "GOA-8111-8113", type: "SO", sourceYard: "3445", pickupLocations: ["3445"],
    childOrders: children.map(order => order.id), childOrderDetails: children,
    items: children.flatMap(order => order.items)
  };
  const previousPlan = {
    id: "scope-plan", planDate: "2026-09-13", revision: 16,
    orders: [{ ...structuredClone(group), id: "CO-GOA-8111-8113", type: "CO" }, group],
    trucks: [{ id: "T8", plate: "TEST-PLATE", driverLogin: "li", loads: [{
      id: "executed", name: "Load 1", driverSequence: 0,
      stops: [
        { id: "pickup", type: "pick", orderId: group.id, orderRefs: [group.id], location: "3445" },
        { id: "drop", type: "drop", orderId: group.id, location: "Original destination" }
      ]
    }] }]
  };
  const nextPlan = structuredClone(previousPlan);
  nextPlan.orders.shift();
  nextPlan.orders.push({ id: "CO-SOM06255-S1", type: "CO", items: [] });
  nextPlan.trucks[0].loads.push({ id: "later", name: "Load 5", driverSequence: 1,
    stops: [{ id: "later-drop", type: "drop", orderId: "CO-SOM06255-S1", location: "Later destination" }] });
  const activity = [
    { status, load_id: "executed", stop_id: "pickup", stop_type: "pickup", order_refs: children.map(order => order.id) },
    { status, load_id: "executed", stop_id: "drop", stop_type: "dropoff", order_refs: children.map(order => order.id) }
  ];
  return { previousPlan, nextPlan, activity };
}
