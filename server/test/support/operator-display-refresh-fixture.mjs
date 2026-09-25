import { applyOperatorLinkedQuantityProjection } from "../../src/operator-linked-quantity-domain.js";

export const specialLine = {
  id: "456639", line_id: "4971989", item_id: "2055", item_name: "MBBS-Special Order",
  sku: "MBBS-Special Order", item_description: "Melville 60 DuraFusion Random Amber — 116.60 sqft/plt",
  item_type: "NonInvtPart", quantity: 2332, unit: "SQFT", pallet_qty: 20,
  layer_qty: 0, section_qty: 0, piece_qty: 0, to_plt: 0, to_lyr: 0, to_sec: 0, to_pcs: 0,
  packed_pallet_qty: 0, packed_sales_qty: 0, loaded_qty: 0, netsuite_active: true,
  pack_quantity_source: "netsuite_manual"
};
export const palletLine = {
  ...specialLine, id: "456647", line_id: "4972012", item_id: "1784", item_type: "InvtPart",
  sku: "PALLET", item_name: "PALLET", item_description: "PALLET DEPOSIT", quantity: 20,
  unit: "EACH", pallet_qty: 0, pack_quantity_source: "sales_only"
};
export function displayFixture() {
  const group = {
    netsuite_id: "GOB-120607-120608", tranid: "SOB120607+SOB120608", order_type: "sales_order",
    operator_status: "open", dispatch_planned: true, outbound_location_id: 1,
    expected_delivery_date: "2026-09-18", trandate: "2026-09-17", child_order_refs: ["SOB120607", "SOB120608"],
    lines: [specialLine, palletLine].map((line) => applyOperatorLinkedQuantityProjection(line, { linkedPo: { sales: line.quantity } }))
  };
  const active = [group, ...Array.from({ length: 37 }, (_, index) => ({
    netsuite_id: `active-${index}`, tranid: `SO-DISPLAY-${index}`, order_type: "sales_order",
    operator_status: "open", dispatch_planned: false, outbound_location_id: 1,
    expected_delivery_date: "2026-09-24", trandate: "2026-08-27", lines: []
  }))];
  const packed = [{
    netsuite_id: "VRMA:display", tranid: "VRMA-DISPLAY", order_type: "vrma_order", operator_status: "packed",
    dispatch_planned: true, outbound_location_id: 1, lines: [{ ...palletLine, quantity: 1, packed_sales_qty: 1 }]
  }];
  return { group, active, packed };
}

export function displayApiResponse(url, fixture, actor) {
  const notifications = fixture.notifications || { total: 0, items: [], salesOrder: {}, transferOrder: {} };
  const family = (orderType) => (url.searchParams.get("status") === "packed" ? fixture.packed : fixture.active)
    .filter((order) => order.order_type === orderType);
  const endpoints = {
    "/api/auth/me": () => ({ operator: actor }),
    "/api/delivery/bootstrap": () => ({ orders: { salesOrder: fixture.active, transferOrder: [], vrmaOrder: [] },
      savedOrderKeys: fixture.savedKeys || [], activeDraft: fixture.draft || null, notifications }),
    "/api/delivery/orders": () => family(url.searchParams.get("orderType")),
    "/api/delivery/vrma-orders": () => family("vrma_order"),
    "/api/delivery/notifications": () => notifications,
    "/api/delivery/current-draft": () => fixture.draft || null,
    "/api/delivery/saved-orders": () => fixture.active,
    "/api/delivery/load-orders": () => fixture.active,
    "/api/delivery/saved-order-keys": () => fixture.savedKeys || [],
    "/api/delivery/load-trucks": () => fixture.trucks || [],
    "/api/operator/requests": () => []
  };
  if (endpoints[url.pathname]) { return endpoints[url.pathname](); }
  if (url.pathname.startsWith('/api/operator/netsuite-posting-jobs/')) { return fixture.postingJob || { status: 'posting' }; }
  if (url.pathname.endsWith("/status")) { return { order: fixture.statusResult }; }
  if (url.pathname.startsWith("/api/delivery/orders/")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    return fixture.active.concat(fixture.packed).find((order) => String(order.netsuite_id) === id) || null;
  }
  return {};
}
