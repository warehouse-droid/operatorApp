function routeText(value) {
  return String(value || "").trim();
}

function routeKey(value) {
  return routeText(value).toLowerCase();
}

function sortedUniqueYards(options = []) {
  const byKey = new Map();
  for (const option of Array.isArray(options) ? options : []) {
    const yard = routeText(typeof option === "string" ? option : option?.yard);
    if (yard && !byKey.has(routeKey(yard))) {
      byKey.set(routeKey(yard), yard);
    }
  }
  return [...byKey.values()].sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base"
  }));
}

export function scmScheduleVendorYardIntersection(memberOptions = []) {
  if (!Array.isArray(memberOptions) || !memberOptions.length) {
    return [];
  }
  const normalized = memberOptions.map((options) => sortedUniqueYards(options));
  if (normalized.some((options) => !options.length)) {
    return [];
  }
  const allowed = normalized.slice(1).map((options) => new Set(options.map(routeKey)));
  return normalized[0].filter((yard) => allowed.every((keys) => keys.has(routeKey(yard))));
}

function optionsForFirstRef(row = {}, vendorOptionsByRef = new Map()) {
  const refs = [
    row.orderRef, row.order_ref,
    row.dispatchRef, row.dispatch_ref,
    row.sourceRef, row.source_ref,
    row.displayRef, row.display_ref
  ];
  for (const ref of refs) {
    const options = vendorOptionsByRef.get(routeKey(ref));
    if (Array.isArray(options) && options.length) {
      return sortedUniqueYards(options);
    }
  }
  return [];
}

function routeRowValue(row, camel, snake) {
  const camelValue = routeText(row[camel]);
  if (camelValue) {
    return camelValue;
  }
  return routeText(row[snake]);
}

function scheduleGroupRef(row) {
  const explicit = routeRowValue(row, "groupRef", "group_ref");
  if (explicit) {
    return explicit;
  }
  const orderRef = routeRowValue(row, "orderRef", "order_ref");
  return orderRef.toUpperCase().startsWith("PGOB-") ? orderRef : "";
}

function normalizedOwnYards(ownYards) {
  const own = [];
  const ownKeys = new Set();
  for (const value of Array.isArray(ownYards) ? ownYards : []) {
    const yard = routeText(value);
    const key = routeKey(yard);
    if (!key || ownKeys.has(key)) {
      continue;
    }
    ownKeys.add(key);
    own.push(yard);
  }
  return own;
}

function purchaseOrderPickupOptions(row, vendorOptionsByRef, groupMembersByRef) {
  const groupRef = scheduleGroupRef(row);
  const members = groupRef ? groupMembersByRef.get(routeKey(groupRef)) : null;
  if (!Array.isArray(members)) {
    return optionsForFirstRef(row, vendorOptionsByRef);
  }
  if (!members.length) {
    return optionsForFirstRef(row, vendorOptionsByRef);
  }
  return scmScheduleVendorYardIntersection(members.map((memberRef) => {
    const options = vendorOptionsByRef.get(routeKey(memberRef));
    return Array.isArray(options) ? options : [];
  }));
}

export function scmScheduleRouteOptions(row = {}, {
  vendorOptionsByRef = new Map(),
  groupMembersByRef = new Map(),
  ownYards = []
} = {}) {
  const kind = routeRowValue(row, "orderKind", "order_kind").toUpperCase();
  const own = normalizedOwnYards(ownYards);
  if (kind === "TO") {
    return { pickupOptions: own, dropoffOptions: own };
  }
  if (kind === "VRMA") {
    return {
      pickupOptions: sortedUniqueYards([routeRowValue(row, "pickupPoint", "pickup_point")]),
      dropoffOptions: sortedUniqueYards([routeRowValue(row, "dropoffPoint", "dropoff_point")])
    };
  }
  if (kind !== "PO") {
    return { pickupOptions: [], dropoffOptions: own };
  }

  const pickupOptions = purchaseOrderPickupOptions(row, vendorOptionsByRef, groupMembersByRef);
  return { pickupOptions, dropoffOptions: own };
}
