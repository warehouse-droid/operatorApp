const QUANTITY_FIELDS = ["pallets", "layers", "sections", "pieces"];

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value, precision = 6) {
  const factor = 10 ** precision;
  const candidate = number(value);
  const floatingPointGuard = Number.EPSILON * Math.max(1, Math.abs(candidate)) * factor;
  return Math.round((candidate * factor) + floatingPointGuard) / factor;
}

function positiveDifference(total, allocated) {
  return rounded(Math.max(number(total) - number(allocated), 0));
}

function itemLineIdentity(item = {}) {
  return text(item.lineRowId ?? item.line_row_id ?? item.id);
}

function allocationLineIdentity(allocation = {}) {
  return text(allocation.po_line_id ?? allocation.poLineId);
}

function activeAllocation(allocation = {}) {
  const status = text(allocation.status).toLowerCase();
  return !status || status === "active";
}

function allocationDetails(allocation = {}) {
  const details = allocation.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {return details;}
  if (typeof details !== "string") {return {};}
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function directServiceLines(allocations = []) {
  const byLine = new Map();
  for (const allocation of allocations) {
    for (const line of allocationDetails(allocation).directServicePoLines || []) {
      const poLineId = text(line?.poLineId ?? line?.po_line_id ?? line?.id);
      if (poLineId && !byLine.has(poLineId)) {byLine.set(poLineId, { ...line, poLineId });}
    }
  }
  return [...byLine.values()];
}

function allocationMatchesItem(allocation = {}, item = {}) {
  const allocationLineId = allocationLineIdentity(allocation);
  const lineId = itemLineIdentity(item);
  if (allocationLineId) {return Boolean(lineId && allocationLineId === lineId);}
  const allocationItemId = text(allocation.item_id ?? allocation.itemId);
  const itemId = text(item.itemId ?? item.item_id);
  if (allocationItemId && itemId) {return allocationItemId === itemId;}
  const allocationSku = text(allocation.sku ?? allocation.item_name ?? allocation.itemName).toLowerCase();
  const itemSku = text(item.sku ?? item.itemName ?? item.item_name).toLowerCase();
  return Boolean(allocationSku && itemSku && allocationSku === itemSku);
}

function allocatedQuantity(allocation = {}, field) {
  const snake = {
    pallets: "allocated_pallet_qty",
    layers: "allocated_layer_qty",
    sections: "allocated_section_qty",
    pieces: "allocated_piece_qty",
    salesQty: "allocated_sales_qty"
  }[field];
  const camel = {
    pallets: "pallets",
    layers: "layers",
    sections: "sections",
    pieces: "pieces",
    salesQty: "salesQty"
  }[field];
  return Math.max(number(allocation[snake] ?? allocation[camel]), 0);
}

function residualLineWeight(item = {}, residual = {}) {
  const itemWeight = number(item.itemWeight ?? item.item_weight);
  if (itemWeight && residual.quantity) {return rounded(residual.quantity * itemWeight, 3);}
  const originalWeight = number(item.lineWeight ?? item.line_weight);
  const originalSalesQty = number(item.quantity ?? item.salesQty ?? item.sales_qty);
  if (originalWeight && originalSalesQty) {
    return rounded(originalWeight * Math.min(residual.quantity / originalSalesQty, 1), 3);
  }
  const physicalRatios = QUANTITY_FIELDS
    .map((field) => {
      const original = number(item[field] ?? item[`${field.slice(0, -1)}_qty`]);
      return original ? Math.min(number(residual[field]) / original, 1) : 0;
    })
    .filter((ratio) => ratio > 0);
  return originalWeight && physicalRatios.length
    ? rounded(originalWeight * Math.max(...physicalRatios), 3)
    : 0;
}

function hasRouteQuantity(item = {}) {
  return QUANTITY_FIELDS.some((field) => number(item[field]) > 0)
    || number(item.quantity ?? item.salesQty) > 0;
}

function residualItem(item = {}, allocations = []) {
  const matches = allocations.filter((allocation) => allocationMatchesItem(allocation, item));
  const residual = Object.fromEntries(QUANTITY_FIELDS.map((field) => [
    field,
    positiveDifference(
      item[field] ?? item[`${field.slice(0, -1)}_qty`],
      matches.reduce((sum, allocation) => sum + allocatedQuantity(allocation, field), 0)
    )
  ]));
  residual.quantity = positiveDifference(
    item.quantity ?? item.salesQty ?? item.sales_qty,
    matches.reduce((sum, allocation) => sum + allocatedQuantity(allocation, "salesQty"), 0)
  );
  residual.salesQty = residual.quantity;
  return {
    ...item,
    ...residual,
    lineWeight: residualLineWeight(item, residual)
  };
}

function destinationIdentity({ destinationLocationId = null, destinationYard = "" } = {}) {
  const locationId = text(destinationLocationId);
  return locationId ? `location:${locationId}` : `yard:${text(destinationYard).toLowerCase()}`;
}

function originalDropoffForItem(order = {}, item = {}) {
  const lineId = itemLineIdentity(item);
  const byLine = (order.dropoffs || []).find((dropoff) =>
    (dropoff.lineRowIds ?? dropoff.line_row_ids ?? []).map(text).includes(lineId)
  );
  if (byLine) {return byLine;}
  const itemDestination = destinationIdentity({
    destinationLocationId: item.destinationLocationId ?? item.destination_location_id,
    destinationYard: item.destinationYard ?? item.destination_yard
  });
  return (order.dropoffs || []).find((dropoff) => destinationIdentity({
    destinationLocationId: dropoff.destinationLocationId ?? dropoff.destination_location_id,
    destinationYard: dropoff.destinationYard ?? dropoff.destination_yard
  }) === itemDestination) || null;
}

function routeDropoffs(order = {}, items = []) {
  const groups = new Map();
  for (const item of items) {
    const original = originalDropoffForItem(order, item) || {};
    const explicitDestinationYard = text(
      original.destinationYard
      ?? original.destination_yard
      ?? item.destinationYard
      ?? item.destination_yard
    );
    const explicitDestinationLocationId = original.destinationLocationId
      ?? original.destination_location_id
      ?? item.destinationLocationId
      ?? item.destination_location_id;
    const destinationLocationId = explicitDestinationLocationId
      ?? (explicitDestinationYard ? null : order.destinationLocationId ?? order.destination_location_id ?? null);
    const destinationYard = explicitDestinationYard || text(order.destinationYard ?? order.destination_yard);
    const key = text(original.key) || destinationIdentity({ destinationLocationId, destinationYard });
    const group = groups.get(key) || {
      key,
      destinationLocationId,
      destinationYard,
      defaultAddress: text(original.defaultAddress ?? original.default_address ?? order.defaultDestinationAddress),
      address: text(order.deliveryAddressOverride ?? order.delivery_address_override)
        || text(original.address ?? order.destinationAddress ?? order.destination_address ?? destinationYard),
      lineRowIds: [],
      pallets: 0,
      layers: 0,
      sections: 0,
      pieces: 0,
      salesQty: 0,
      weight: 0
    };
    const lineId = itemLineIdentity(item);
    if (lineId && !group.lineRowIds.map(text).includes(lineId)) {group.lineRowIds.push(lineId);}
    for (const field of QUANTITY_FIELDS) {group[field] += number(item[field]);}
    group.salesQty += number(item.quantity ?? item.salesQty);
    group.weight += number(item.lineWeight ?? item.line_weight);
    groups.set(key, group);
  }
  return [...groups.values()].map((dropoff) => ({
    ...dropoff,
    ...Object.fromEntries(QUANTITY_FIELDS.map((field) => [field, rounded(dropoff[field])])),
    salesQty: rounded(dropoff.salesQty),
    weight: rounded(dropoff.weight, 3)
  }));
}

function allocationEvidence(allocation = {}) {
  return {
    id: Number(allocation.id) || null,
    targetRef: text(allocation.dispatch_target_ref ?? allocation.dispatchTargetRef ?? allocation.sales_order_ref ?? allocation.salesOrderRef),
    salesOrderRef: text(allocation.sales_order_ref ?? allocation.salesOrderRef),
    poOrderRef: text(allocation.po_order_ref ?? allocation.poOrderRef),
    poLineId: allocationLineIdentity(allocation),
    pallets: allocatedQuantity(allocation, "pallets"),
    layers: allocatedQuantity(allocation, "layers"),
    sections: allocatedQuantity(allocation, "sections"),
    pieces: allocatedQuantity(allocation, "pieces"),
    salesQty: allocatedQuantity(allocation, "salesQty")
  };
}

export function purchaseOrderRouteProjection(order = {}) {
  const source = order && typeof order === "object" ? order : {};
  const projection = source.poRouteProjection ?? source.po_route_projection;
  return text(source.type || source.orderType || source.order_type).toUpperCase() === "PO"
    && projection
    && Number(projection.version || 0) >= 1
    ? projection
    : null;
}

export function purchaseOrderRouteItems(order = {}) {
  const source = order && typeof order === "object" ? order : {};
  const projection = purchaseOrderRouteProjection(source);
  return Array.isArray(projection?.items) ? projection.items : (source.items || []);
}

export function projectPurchaseOrderRouteResidual(order = {}, allocationRows = [], {
  force = false,
  targetRefs: releasedTargetRefs = []
} = {}) {
  const allocations = (Array.isArray(allocationRows) ? allocationRows : []).filter(activeAllocation);
  if (text(order.type).toUpperCase() !== "PO" || (!allocations.length && !force)) {return order;}
  const directLines = directServiceLines(allocations);
  const directLineIds = new Set(directLines.map((line) => text(line.poLineId)).filter(Boolean));
  const items = (order.items || [])
    .filter((item) => !directLineIds.has(itemLineIdentity(item)))
    .map((item) => residualItem(item, allocations))
    .filter(hasRouteQuantity);
  const dropoffs = routeDropoffs(order, items);
  const targetRefs = [...new Set([
    ...allocations.map((allocation) => text(
      allocation.dispatch_target_ref
      ?? allocation.dispatchTargetRef
      ?? allocation.sales_order_ref
      ?? allocation.salesOrderRef
    )),
    ...(Array.isArray(releasedTargetRefs) ? releasedTargetRefs : []),
    ...(force && !allocations.length ? (order.poRouteProjection?.targetRefs || []) : [])
  ].map(text).filter(Boolean))];
  const totals = Object.fromEntries(QUANTITY_FIELDS.map((field) => [
    field,
    rounded(items.reduce((sum, item) => sum + number(item[field]), 0))
  ]));
  const salesQty = rounded(items.reduce((sum, item) => sum + number(item.quantity ?? item.salesQty), 0));
  const weight = rounded(items.reduce((sum, item) => sum + number(item.lineWeight ?? item.line_weight), 0), 3);
  return {
    ...order,
    poRouteProjection: {
      version: 1,
      hasResidual: items.length > 0,
      targetRefs,
      allocationIds: allocations.map((allocation) => Number(allocation.id)).filter(Number.isFinite),
      allocations: allocations.map(allocationEvidence),
      directServiceLines: directLines,
      items,
      dropoffs,
      ...totals,
      salesQty,
      weight
    }
  };
}
