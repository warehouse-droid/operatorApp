// @ts-check
export const OUTBOUND_YARD_IDS = Object.freeze([1, 28, 15, 26]);

/** @param {any} value */
function locationId(value) {
  const raw = value && typeof value === 'object' ? value.id : value;
  if (!/^[1-9]\d*$/.test(String(raw ?? ''))) {return null;}
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** @param {any[]} rows */
export function buildOutboundLocationHierarchy(rows = OUTBOUND_YARD_IDS.map(id => ({ id }))) {
  const directory = new Map(rows.map(row => [locationId(row.id), row]));
  /** @param {any} value */
  function yardFor(value) {
    let id = locationId(value);
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const row = directory.get(id);
      if (!row || /^(?:T|TRUE|1)$/i.test(String(row.isinactive ?? false))) {return null;}
      if (OUTBOUND_YARD_IDS.includes(id)) {return id;}
      id = locationId(row.parent);
    }
    return null;
  }
  return {
    yardFor,
    /** @param {any} yard */
    locationsFor(yard) {
      const root = locationId(yard);
      if (!root || !OUTBOUND_YARD_IDS.includes(root)) {return [];}
      return [...directory.keys()].filter(id => id !== null && yardFor(id) === root)
        .map(Number).sort((a, b) => a - b);
    },
    /** @param {any} id */
    nameFor(id) {
      const row = directory.get(locationId(id));
      return String(row?.fullname || row?.name || id);
    }
  };
}

let cachedHierarchy = buildOutboundLocationHierarchy();
export function getOutboundLocationHierarchy() { return cachedHierarchy; }
/** @param {any[]} rows */
export function setOutboundLocationDirectory(rows) {
  cachedHierarchy = buildOutboundLocationHierarchy(rows);
  return cachedHierarchy;
}
/** @param {any} value */
export function outboundYardLocationId(value) { return cachedHierarchy.yardFor(value); }
/** @param {any} yard */
export function outboundLocationIds(yard) { return cachedHierarchy.locationsFor(yard); }

/** @param {any} child */
function orderLocations(child) {
  const header = child.outbound_location_id ?? child.source_location_id;
  const locations = [header].filter(value => value !== null && value !== undefined);
  if (child.order_type !== 'transfer_order') {
    for (const line of (child.lines || []).filter(activeInventoryLine)) {
      locations.push(line.location_id ?? line.location?.id ?? header);
    }
  }
  if (!locations.length && !(child.child_orders || []).length) { locations.push(null); }
  return locations;
}

/** @param {any} line */
function activeInventoryLine(line) {
  return line.netsuite_active !== false && (!line.item_type || ['InvtPart', 'NonInvtPart'].includes(line.item_type));
}

/** @param {any} order @param {ReturnType<typeof buildOutboundLocationHierarchy>} [hierarchy] */
export function outboundOrderYards(order, hierarchy = cachedHierarchy) {
  const yards = new Set();
  for (const child of [order, ...(order.child_orders || [])]) {
    for (const id of orderLocations(child)) {
      const yard = hierarchy.yardFor(id);
      if (!yard) {throw Object.assign(new Error('The outbound inventory location has no active supported parent yard.'), {
        code: 'OUTBOUND_LOCATION_UNSUPPORTED', status: 409
      });}
      yards.add(yard);
    }
  }
  return [...yards].sort((a, b) => a - b);
}
