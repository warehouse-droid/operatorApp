export const groupRef = "GOA-10724S1-10878S1";
export const splitRef = "SOA10878-S1";
export function cacheFixture() {
  const dependency = { id: 300, transferOrderRef: "TOB01264", salesOrderRef: splitRef,
    canonicalSalesOrderRef: "SOA10878", dispatchTargetRef: splitRef, mode: "direct_to_customer",
    status: "active", sourceLocation: "2967", sourceLocationId: 28,
    lines: [{ itemId: 8500100, allocatedQuantity: 3, pieceQty: 3, unit: "EA" }] };
  const child = { id: splitRef, type: "SO", originalOrderId: "SOA10878", sourceYard: "3445",
    pickupLocations: ["3445", "2967"], address: "100 Synthetic Street", pallets: 1, salesQty: 5,
    items: [{ itemId: 8500100, quantity: 5, pieces: 5, unit: "EA", pallets: 1 }],
    orderDependencies: [dependency], dependencyDirectPickup: true,
    directPickupManifest: [{ dependencyId: 300, transferOrderRef: "TOB01264", location: "2967", items: dependency.lines }] };
  const stale = { ...structuredClone(child), id: groupRef, originalOrderId: "", isGrouped: true,
    childOrders: [splitRef], childOrderDetails: [child], planOwned: true };
  const cleanChild = { ...structuredClone(child), pickupLocations: ["3445"], orderDependencies: [],
    directPickupManifest: [], dependencyDirectPickup: false };
  const clean = { ...structuredClone(stale), pickupLocations: ["3445"], orderDependencies: [],
    directPickupManifest: [], dependencyDirectPickup: false, childOrderDetails: [cleanChild] };
  const trucks = [{ id: "TEST-TRUCK", plate: "TEST-PLATE", name: "Synthetic truck", capacity: 24,
    loads: [{ id: "TEST-LOAD", name: "Synthetic load", pickupVisitSchemaVersion: 1, stops: [
      { id: "native-pick", type: "pick", orderId: groupRef, orderRefs: [groupRef], location: "3445" },
      { id: "stale-pick", type: "pick", orderId: groupRef, orderRefs: [groupRef], location: "2967" },
      { id: "group-drop", type: "drop", orderId: groupRef, location: "100 Synthetic Street" }
    ] }] }];
  const before = { id: "cache-plan", planDate: "2099-10-30", revision: 1, digest: "before", status: "draft",
    orders: [stale], trucks: structuredClone(trucks), summary: {} };
  const after = { ...structuredClone(before), revision: 2, digest: "after", orders: [clean] };
  after.trucks[0].loads[0].stops.splice(1, 1);
  return { dependency, stale, clean, before, after };
}
