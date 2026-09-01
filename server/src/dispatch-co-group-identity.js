export class DispatchCoGroupIdentityError extends Error {
  constructor(message = "Dispatch CO group identity is invalid.", code = "DISPATCH_CO_GROUP_IDENTITY_INVALID") {
    super(message);
    this.name = "DispatchCoGroupIdentityError";
    this.code = code;
    this.status = 409;
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function orderRef(order = {}) {
  return text(order.id || order.orderId || order.orderRef || order.tranid || order.refNumber);
}

function isCoMember(ref, detail = {}) {
  return text(detail?.type).toUpperCase() === "CO" || text(ref || orderRef(detail)).toUpperCase().startsWith("CO-");
}

function groupMembers(order = {}) {
  const details = Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [];
  const detailByRef = new Map(details
    .map((detail) => [orderRef(detail).toLowerCase(), detail])
    .filter(([ref]) => ref));
  const listed = Array.isArray(order.childOrders) ? order.childOrders.map(text).filter(Boolean) : [];
  const refs = listed.length ? listed : details.map(orderRef).filter(Boolean);
  return refs.map((ref, index) => ({
    ref,
    detail: detailByRef.get(ref.toLowerCase()) || details[index] || {}
  }));
}

function planOrderObjects(plan = {}) {
  const found = [];
  const visit = (order) => {
    if (!order || typeof order !== "object" || Array.isArray(order)) return;
    found.push(order);
    for (const child of Array.isArray(order.childOrderDetails) ? order.childOrderDetails : []) visit(child);
  };
  for (const order of Array.isArray(plan.orders) ? plan.orders : []) visit(order);
  for (const truck of Array.isArray(plan.trucks) ? plan.trucks : []) {
    for (const load of Array.isArray(truck?.loads) ? truck.loads : []) {
      for (const order of Array.isArray(load?.orders) ? load.orders : []) {
        if (order && typeof order === "object") visit(order);
      }
    }
  }
  return found;
}

function replaceMappedStrings(value, mappingsByOldRef) {
  if (typeof value === "string") {
    return mappingsByOldRef.get(text(value).toLowerCase()) || value;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = replaceMappedStrings(value[index], mappingsByOldRef);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    value[key] = replaceMappedStrings(value[key], mappingsByOldRef);
  }
  return value;
}

export function canonicalizeDispatchCoGroupIdentities(plan = {}) {
  const mappings = dispatchCoGroupIdentityMappings(plan);
  const copy = structuredClone(plan);
  if (!mappings.length) return copy;
  return replaceMappedStrings(copy, new Map(mappings.map(({ oldRef, newRef }) => [oldRef.toLowerCase(), newRef])));
}

export function dispatchCoGroupIdentityMappings(plan = {}) {
  const orders = planOrderObjects(plan);
  const identities = new Map();
  for (const order of orders) {
    const ref = orderRef(order);
    if (!ref) continue;
    const key = ref.toLowerCase();
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(order);
  }

  const mappingsByOldRef = new Map();
  for (const order of orders) {
    const members = groupMembers(order);
    if (members.length < 2) continue;
    const coFlags = members.map(({ ref, detail }) => isCoMember(ref, detail));
    const containsCo = coFlags.some(Boolean);
    const containsNonCo = coFlags.some((flag) => !flag);
    if (containsCo && containsNonCo) {
      throw new DispatchCoGroupIdentityError(
        "CO orders can only be grouped with other CO orders.",
        "DISPATCH_CO_GROUP_MIXED_TYPES"
      );
    }
    if (!containsCo) continue;
    const oldRef = orderRef(order);
    if (!oldRef || oldRef.toUpperCase().startsWith("CO-")) continue;
    const newRef = `CO-${oldRef}`;
    mappingsByOldRef.set(oldRef.toLowerCase(), { oldRef, newRef, sourceOrder: order });
  }

  for (const mapping of mappingsByOldRef.values()) {
    const targetKey = mapping.newRef.toLowerCase();
    const targetOrders = identities.get(targetKey) || [];
    if (targetOrders.some((order) => order !== mapping.sourceOrder)) {
      throw new DispatchCoGroupIdentityError(
        `Cannot rename ${mapping.oldRef} to ${mapping.newRef} because that identity already exists.`,
        "DISPATCH_CO_GROUP_IDENTITY_CONFLICT"
      );
    }
  }
  return [...mappingsByOldRef.values()].map(({ oldRef, newRef }) => ({ oldRef, newRef }));
}

export function isTerminalDispatchCoStatus(status = "") {
  return ["completed", "received"].includes(text(status).toLowerCase());
}
