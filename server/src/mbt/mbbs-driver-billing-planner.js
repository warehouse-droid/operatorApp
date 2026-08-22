// @ts-check

import { MbtError } from "./errors.js";
import { requireMbbsRateCardPolicy } from "./mbbs-rate-card-policy.js";

const SOURCE_ORDER = Object.freeze({ SO: 10, TO: 20, PO: 30, VRMA: 40, CUSTOM: 50 });

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function array(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function normalizedAddress(value) {
  return text(value).toLowerCase().replaceAll(/[^a-z0-9]+/gu, " ").trim();
}

/** @param {unknown} value */
function sourceType(value) {
  const normalized = text(value).toUpperCase().replaceAll(/[^A-Z]/gu, "_");
  return /** @type {Record<string, string | undefined>} */ ({
    SO: "SO",
    SALES_ORDER: "SO",
    SALESORDER: "SO",
    TO: "TO",
    TRANSFER_ORDER: "TO",
    TRANSFERORDER: "TO",
    PO: "PO",
    PURCHASE_ORDER: "PO",
    PURCHASEORDER: "PO",
    VRMA: "VRMA",
    VENDOR_RETURN_AUTHORIZATION: "VRMA",
    CUSTOM: "CUSTOM",
    CUSTOM_ORDER: "CUSTOM"
  })[normalized] || null;
}

/** @param {string} reference */
function inferredSourceType(reference) {
  const normalized = reference.toUpperCase();
  if (normalized.startsWith("VRMA")) {
    return "VRMA";
  }
  if (normalized.startsWith("TO")) {
    return "TO";
  }
  if (normalized.startsWith("PO")) {
    return "PO";
  }
  if (normalized.startsWith("SO")) {
    return "SO";
  }
  return null;
}

/** @param {string} type @param {string} reference */
function rootReference(type, reference) {
  return type === "SO" ? reference.replace(/-S[0-9]+$/iu, "") : reference;
}

/** @param {unknown} value @param {string} code @param {string} message */
function invalid(value, code, message) {
  if (!Number.isSafeInteger(value)) {
    throw new MbtError({ status: 422, code, message });
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function nonnegativeMoney(value, label) {
  const amount = invalid(
    value,
    "MBT_BILLING_MANUAL_AMOUNT_INVALID",
    `${label} must be exact integer cents within the supported range.`
  );
  if (amount < 0) {
    throw new MbtError({
      status: 422,
      code: "MBT_BILLING_FINAL_AMOUNT_INVALID",
      message: `${label} cannot be negative.`
    });
  }
  return amount;
}

/** @param {unknown} value @param {string} label */
function signedMoney(value, label) {
  return invalid(
    value,
    "MBT_BILLING_MANUAL_AMOUNT_INVALID",
    `${label} must be exact signed integer cents within the supported range.`
  );
}

/** @param {number[]} values */
function safeSum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new MbtError({
        status: 422,
        code: "MBT_BILLING_MANUAL_AMOUNT_INVALID",
        message: "The billing amount exceeds the supported cent range."
      });
    }
  }
  return total;
}

/** @param {number} value @param {number} quantity */
function safeProduct(value, quantity) {
  const total = value * quantity;
  if (!Number.isSafeInteger(total)) {
    throw new MbtError({
      status: 422,
      code: "MBT_BILLING_MANUAL_AMOUNT_INVALID",
      message: "The billing amount exceeds the supported cent range."
    });
  }
  return total;
}

/**
 * Resolve the two editable fields without trusting browser arithmetic.
 * Either field may be omitted, but when both are supplied they must agree.
 *
 * @param {unknown} rawInput
 */
export function resolveManualBillingAmount(rawInput) {
  const input = object(rawInput);
  const calculatedAmountMinor = nonnegativeMoney(input.calculatedAmountMinor, "Calculated charge");
  const hasAdjustment = input.adjustmentMinor !== undefined && input.adjustmentMinor !== null;
  const hasFinal = input.finalAmountMinor !== undefined && input.finalAmountMinor !== null;
  const adjustmentMinor = hasAdjustment
    ? signedMoney(input.adjustmentMinor, "Manual adjustment")
    : hasFinal
      ? safeSum([
          nonnegativeMoney(input.finalAmountMinor, "Final charge"),
          -calculatedAmountMinor
        ])
      : 0;
  const expectedFinal = safeSum([calculatedAmountMinor, adjustmentMinor]);
  if (expectedFinal < 0) {
    throw new MbtError({
      status: 422,
      code: "MBT_BILLING_FINAL_AMOUNT_INVALID",
      message: "The final charge cannot be negative."
    });
  }
  const finalAmountMinor = hasFinal
    ? nonnegativeMoney(input.finalAmountMinor, "Final charge")
    : expectedFinal;
  if (finalAmountMinor !== expectedFinal) {
    throw new MbtError({
      status: 409,
      code: "MBT_BILLING_MANUAL_AMOUNT_MISMATCH",
      message: "Final charge must equal the current server calculation plus the signed adjustment."
    });
  }
  return { calculatedAmountMinor, adjustmentMinor, finalAmountMinor };
}

/**
 * Apply staff-approved billing policy to one business billing unit.
 * Driver load boundaries deliberately do not participate in this arithmetic.
 *
 * @param {unknown} rawInput
 */
// eslint-disable-next-line complexity -- The allowlisted SO/TO/PO billing rules deliberately converge at one exact-cent policy boundary.
export function calculateBillingUnitAmount(rawInput) {
  const input = object(rawInput);
  const policy = requireMbbsRateCardPolicy(input.mbbsChargingPolicy);
  const billingRule = text(input.billingRule);
  if (!["so_order", "so_group", "to_replenishment", "to_replenishment_multi_drop", "to_direct_additional_drop", "po_shared_leg", "po_group", "custom_order", "reconciliation"].includes(billingRule)) {
    throw new MbtError({
      status: 422,
      code: "MBT_BILLING_RULE_INVALID",
      message: "The completed order has no supported billing rule."
    });
  }
  const rateAmount = nonnegativeMoney(input.distanceBandAmountMinor, "Distance-band charge");
  const dropCount = invalid(
    input.dropCount,
    "MBT_BILLING_ROUTE_INVALID",
    "Drop count must be a positive safe integer."
  );
  if (dropCount < 1) {
    throw new MbtError({ status: 422, code: "MBT_BILLING_ROUTE_INVALID", message: "At least one drop is required." });
  }
  const directTransfer = billingRule === "to_direct_additional_drop";
  const additionalDropCount = directTransfer
    ? 1
    : billingRule === "to_replenishment_multi_drop"
      ? Math.max(0, dropCount - 1)
    : ["po_shared_leg", "po_group"].includes(billingRule)
      ? Math.max(0, dropCount - 1)
      : 0;
  const configuredAdditionalDropUnitAmountMinor = directTransfer
    ? policy.directPickupUnitAmountMinor
    : billingRule === "to_replenishment_multi_drop"
      ? "toReplenishmentAdditionalDropUnitAmountMinor" in policy
        ? policy.toReplenishmentAdditionalDropUnitAmountMinor
        : "poVrmaAdditionalStopUnitAmountMinor" in policy
          ? policy.poVrmaAdditionalStopUnitAmountMinor
          : policy.poAdditionalDropUnitAmountMinor
    : ["po_shared_leg", "po_group"].includes(billingRule)
      ? "poVrmaAdditionalStopUnitAmountMinor" in policy
        ? policy.poVrmaAdditionalStopUnitAmountMinor
        : policy.poAdditionalDropUnitAmountMinor
      : 0;
  const additionalDropUnitAmountMinor = nonnegativeMoney(
    configuredAdditionalDropUnitAmountMinor,
    "Additional-drop unit price"
  );
  const distanceBandAmountMinor = directTransfer ? 0 : rateAmount;
  const additionalDropFeeMinor = safeProduct(additionalDropUnitAmountMinor, additionalDropCount);
  return {
    distanceBandAmountMinor,
    additionalDropCount,
    additionalDropUnitAmountMinor,
    additionalDropFeeMinor,
    calculatedAmountMinor: safeSum([distanceBandAmountMinor, additionalDropFeeMinor])
  };
}

/** @param {Record<string, any>} record */
function recordAddress(record) {
  const details = object(record.details);
  return text(details.address)
    || text(record.stopType === "dropoff" ? details.dropAddress : details.pickupLocation)
    || text(details.location);
}

/** @param {Record<string, any>} record */
// eslint-disable-next-line complexity
function referencesOnRecord(record) {
  const details = object(record.details);
  const orders = array(details.orders).map(object);
  /** @type {Map<string, {sourceType: string, rootReference: string, directDependency: boolean}>} */
  const found = new Map();
  const orderTypes = new Map();
  for (const order of orders) {
    const reference = text(order.orderRef);
    const type = sourceType(order.orderType) || inferredSourceType(reference);
    if (!reference || !type) {
      continue;
    }
    orderTypes.set(reference.toUpperCase(), type);
    const root = rootReference(type, reference);
    found.set(`${type}|${root.toUpperCase()}`, {
      sourceType: type,
      rootReference: root,
      directDependency: text(order.source).toLowerCase() === "direct_dependency"
    });
  }
  const declaredTypes = array(details.orderTypes).map(sourceType).filter(Boolean);
  for (const rawReference of array(record.orderRefs)) {
    const reference = text(rawReference);
    const type = orderTypes.get(reference.toUpperCase())
      || (declaredTypes.length === 1 ? declaredTypes[0] : null)
      || inferredSourceType(reference);
    if (!reference || !type) {
      continue;
    }
    const root = rootReference(type, reference);
    const key = `${type}|${root.toUpperCase()}`;
    if (!found.has(key)) {
      found.set(key, { sourceType: type, rootReference: root, directDependency: false });
    }
  }
  for (const manifest of array(details.dependencyPickupManifests).map(object)) {
    const reference = text(manifest.transferOrderRef);
    if (!reference) {
      continue;
    }
    const root = rootReference("TO", reference);
    found.set(`TO|${root.toUpperCase()}`, {
      sourceType: "TO",
      rootReference: root,
      directDependency: true
    });
  }
  return [...found.values()];
}

/** @param {Record<string, any>} record */
function recordCompletedAt(record) {
  const parsed = new Date(text(record.completedAt || record.completed_at));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** @param {Array<Record<string, any>>} records @param {Record<string, any>} load */
function physicalVisits(records, load) {
  /** @type {Map<string, Record<string, any>>} */
  const visits = new Map();
  // eslint-disable-next-line complexity
  records.forEach((record, ordinal) => {
    const stopType = text(record.stopType || record.stop_type).toLowerCase();
    if (!["pickup", "dropoff"].includes(stopType)) {
      return;
    }
    const details = object(record.details || record.job_details);
    const physicalIds = array(details.physicalVisitStopIds).map(text).filter(Boolean).sort();
    const key = physicalIds.length
      ? `${stopType}|physical|${physicalIds.join("|")}`
      : `${stopType}|record|${text(record.id) || ordinal}`;
    const current = visits.get(key) || {
      key,
      ordinal,
      stopType,
      addressText: recordAddress({ ...record, stopType, details }),
      references: new Map(),
      completedAt: null,
      driverLoadId: text(load.loadId),
      driverLoadNumber: text(load.loadName) || text(load.loadId)
    };
    current.ordinal = Math.min(current.ordinal, ordinal);
    current.addressText ||= recordAddress({ ...record, stopType, details });
    for (const reference of referencesOnRecord({ ...record, details })) {
      const referenceKey = `${reference.sourceType}|${reference.rootReference.toUpperCase()}`;
      const retained = current.references.get(referenceKey);
      current.references.set(referenceKey, {
        ...reference,
        directDependency: reference.directDependency || retained?.directDependency === true
      });
    }
    const completedAt = recordCompletedAt(record);
    if (completedAt && (!current.completedAt || completedAt > current.completedAt)) {
      current.completedAt = completedAt;
    }
    visits.set(key, current);
  });
  return [...visits.values()].sort((left, right) => left.ordinal - right.ordinal);
}

/** @param {unknown} value */
function normalizedLoads(value) {
  const input = object(value);
  const rawLoads = Array.isArray(input.loads)
    ? input.loads
    : [{
        loadId: input.loadId,
        loadName: input.loadName,
        completedAt: input.completedAt,
        records: input.records
      }];
  return rawLoads.map((rawLoad) => {
    const load = object(rawLoad);
    return {
      loadId: text(load.loadId),
      loadName: text(load.loadName) || text(load.loadId),
      completedAt: text(load.completedAt || input.completedAt),
      records: array(load.records).map(object)
    };
  });
}

/** @param {unknown} value */
function canonicalMap(value) {
  const input = object(value);
  /** @type {Map<string, Record<string, any>>} */
  const result = new Map();
  for (const rawOrder of array(input.canonicalOrders)) {
    const order = object(rawOrder);
    const type = sourceType(order.sourceType);
    const reference = text(order.rootReference);
    if (!type || !reference) {
      continue;
    }
    result.set(`${type}|${rootReference(type, reference).toUpperCase()}`, {
      sourceType: type,
      rootReference: rootReference(type, reference),
      originAddress: text(order.originAddress),
      destinationAddress: text(order.destinationAddress),
      originAddressOverride: text(order.originAddressOverride),
      destinationAddressOverride: text(order.destinationAddressOverride),
      billingGroupKey: text(order.billingGroupKey),
      billingReference: text(order.billingReference) || rootReference(type, reference),
      orderGroupKey: text(order.orderGroupKey),
      orderGroupReference: text(order.orderGroupReference),
      orderGroupMembers: array(order.orderGroupMembers).map(text).filter(Boolean),
      orderGroupPosition: Number.isSafeInteger(Number(order.orderGroupPosition))
        ? Number(order.orderGroupPosition)
        : Number.MAX_SAFE_INTEGER
    });
  }
  return result;
}

/** @param {Array<Record<string, any>>} visits */
function occurrences(visits) {
  /** @type {Map<string, Record<string, any>>} */
  const result = new Map();
  for (const visit of visits) {
    for (const reference of visit.references.values()) {
      const baseKey = `${reference.sourceType}|${reference.rootReference.toUpperCase()}`;
      const retainedLoadId = text(visit.driverLoadId);
      const key = ["PO", "VRMA"].includes(reference.sourceType) && retainedLoadId
        ? `${baseKey}|DRIVER_LOAD|${retainedLoadId}`
        : baseKey;
      const current = result.get(key) || {
        sourceType: reference.sourceType,
        rootReference: reference.rootReference,
        pickups: [],
        drops: [],
        directDependency: false,
        driverLoadId: retainedLoadId
      };
      current[visit.stopType === "pickup" ? "pickups" : "drops"].push(visit);
      current.directDependency ||= reference.directDependency === true;
      result.set(key, current);
    }
  }
  return result;
}

/** @param {Array<Record<string, any>>} visits */
function evidenceLoads(visits) {
  const byId = new Map();
  for (const visit of visits) {
    if (!visit.driverLoadId) {
      continue;
    }
    byId.set(visit.driverLoadId, visit.driverLoadNumber || visit.driverLoadId);
  }
  const ordered = [...byId].sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]));
  return {
    driverLoadIds: ordered.map(([id]) => id),
    driverLoadNumbers: ordered.map(([, name]) => name)
  };
}

/** @param {Array<Record<string, any>>} visits */
function lastCompletion(visits) {
  const completed = visits.map((visit) => text(visit.completedAt)).filter(Boolean).sort();
  return completed.at(-1) || null;
}

/** @param {Array<Record<string, any>>} visits */
function uniqueVisitAddresses(visits) {
  const found = new Map();
  for (const visit of visits) {
    const normalized = normalizedAddress(visit.addressText);
    if (normalized && !found.has(normalized)) {
      found.set(normalized, text(visit.addressText));
    }
  }
  return [...found.values()];
}

/** @param {Record<string, any>} occurrence @param {Record<string, any>} canonical */
function orderRoute(occurrence, canonical) {
  const pickupAddresses = uniqueVisitAddresses(occurrence.pickups);
  const dropAddresses = uniqueVisitAddresses(occurrence.drops);
  // Explicit Dispatch endpoint edits are billing instructions. When blank,
  // retain the historical evidence precedence for each order type.
  const origin = text(canonical.originAddressOverride)
    || pickupAddresses[0]
    || text(canonical.originAddress)
    || "";
  const destination = text(canonical.destinationAddressOverride)
    || (occurrence.sourceType === "TO"
      ? dropAddresses.at(-1) || text(canonical.destinationAddress) || ""
      : text(canonical.destinationAddress) || dropAddresses.at(-1) || "");
  return origin && destination
    ? [{ addressText: origin, stopType: "pickup" }, { addressText: destination, stopType: "dropoff" }]
    : [];
}

/** @param {Array<Record<string, any>>} values */
function uniqueReferences(values) {
  const found = new Map();
  for (const rawReference of values) {
    const reference = object(rawReference);
    const type = sourceType(reference.sourceType);
    const root = text(reference.rootReference);
    if (!type || !root) {
      continue;
    }
    const key = `${type}|${root.toUpperCase()}`;
    if (!found.has(key)) {
      found.set(key, { sourceType: type, rootReference: root });
    }
  }
  return [...found.values()];
}

/** @param {Record<string, any>} canonicalOrder @param {string} fallbackType */
function canonicalGroupMembers(canonicalOrder, fallbackType) {
  const type = sourceType(canonicalOrder.sourceType) || fallbackType;
  return uniqueReferences(array(canonicalOrder.orderGroupMembers).map((member) => ({
    sourceType: type,
    rootReference: text(member)
  })));
}

/**
 * @param {Map<string, Record<string, any>>} groups
 * @param {Record<string, any>} occurrence
 * @param {Record<string, any>} canonicalOrder
 */
function retainExplicitGroup(groups, occurrence, canonicalOrder) {
  const groupKey = text(canonicalOrder.orderGroupKey);
  const groupReference = text(canonicalOrder.orderGroupReference);
  if (!groupKey || !groupReference) {
    return false;
  }
  const current = groups.get(groupKey) || {
    groupKey,
    sourceType: occurrence.sourceType,
    groupReference,
    members: new Map(),
    entries: [],
    visits: []
  };
  if (current.sourceType !== occurrence.sourceType || current.groupReference !== groupReference) {
    return false;
  }
  for (const member of canonicalGroupMembers(canonicalOrder, occurrence.sourceType)) {
    const position = array(canonicalOrder.orderGroupMembers)
      .map(text)
      .findIndex((reference) => reference.toUpperCase() === member.rootReference.toUpperCase());
    const retained = current.members.get(member.rootReference.toUpperCase());
    current.members.set(member.rootReference.toUpperCase(), {
      ...member,
      position: position >= 0 ? position : retained?.position ?? Number.MAX_SAFE_INTEGER
    });
  }
  if (occurrence.rootReference.toUpperCase() !== groupReference.toUpperCase()) {
    current.members.set(occurrence.rootReference.toUpperCase(), {
      sourceType: occurrence.sourceType,
      rootReference: occurrence.rootReference,
      position: Number(canonicalOrder.orderGroupPosition)
    });
  }
  current.entries.push({ occurrence, canonicalOrder });
  current.visits.push(...occurrence.pickups, ...occurrence.drops);
  groups.set(groupKey, current);
  return true;
}

/** @param {Record<string, any>} group */
function orderedGroupMembers(group) {
  return [...group.members.values()]
    .sort((left, right) => Number(left.position) - Number(right.position)
      || left.rootReference.localeCompare(right.rootReference))
    .map(({ sourceType: type, rootReference: root }) => ({ sourceType: type, rootReference: root }));
}

/** @param {Record<string, any>} group */
function groupedSalesRoute(group) {
  const entries = [...group.entries].sort((left, right) =>
    Number(left.canonicalOrder.orderGroupPosition) - Number(right.canonicalOrder.orderGroupPosition)
      || left.occurrence.rootReference.localeCompare(right.occurrence.rootReference)
  );
  const origin = entries.map((entry) => text(entry.canonicalOrder.originAddressOverride)).find(Boolean)
    || uniqueVisitAddresses(group.visits.filter((/** @type {Record<string, any>} */ visit) => visit.stopType === "pickup"))[0]
    || entries.map((entry) => text(entry.canonicalOrder.originAddress)).find(Boolean)
    || "";
  const destination = entries.map((entry) => text(entry.canonicalOrder.destinationAddressOverride)).find(Boolean)
    || entries.map((entry) => text(entry.canonicalOrder.destinationAddress)).find(Boolean)
    || uniqueVisitAddresses(group.visits.filter((/** @type {Record<string, any>} */ visit) => visit.stopType === "dropoff"))[0]
    || "";
  return origin && destination
    ? [{ addressText: origin, stopType: "pickup" }, { addressText: destination, stopType: "dropoff" }]
    : [];
}

/** @param {Record<string, any>} unit */
function unitSortKey(unit) {
  const type = unit.references[0]?.sourceType || "";
  const sourceOrder = /** @type {Record<string, number>} */ (SOURCE_ORDER);
  return `${String(sourceOrder[type] ?? 999).padStart(3, "0")}|${unit.unitKey}`;
}

/**
 * Convert Driver evidence into business billing units. An immutable Driver
 * load scopes an ordinary PO/VRMA physical leg; non-unique display labels do
 * not. Explicit groups retain their separately authorized group identity.
 *
 * @param {unknown} rawInput
 */
// eslint-disable-next-line complexity
export function planDriverBillingUnits(rawInput) {
  const input = object(rawInput);
  const loads = normalizedLoads(input);
  const canonical = canonicalMap(input);
  const allVisits = loads.flatMap((load) => physicalVisits(load.records, load));
  const byReference = occurrences(allVisits);
  /** @type {Array<Record<string, any>>} */
  const units = [];

  /** @type {Map<string, Record<string, any>>} */
  const explicitSalesGroups = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const replenishmentTransferGroups = new Map();

  for (const occurrence of byReference.values()) {
    if (!["SO", "TO"].includes(occurrence.sourceType)) {
      continue;
    }
    const canonicalOrder = canonical.get(`${occurrence.sourceType}|${occurrence.rootReference.toUpperCase()}`) || {};
    if (occurrence.sourceType === "SO" && retainExplicitGroup(explicitSalesGroups, occurrence, canonicalOrder)) {
      continue;
    }
    if (occurrence.sourceType === "TO" && occurrence.directDependency !== true) {
      const retainedReference = text(canonicalOrder.billingReference) || occurrence.rootReference;
      const physicalPickups = [...new Map(occurrence.pickups.map(
        (/** @type {Record<string, any>} */ visit) => [visit.key, visit]
      )).values()];
      const sharedPickup = physicalPickups.length === 1 ? physicalPickups[0] : null;
      const driverLoadId = text(sharedPickup?.driverLoadId);
      const groupKey = sharedPickup && driverLoadId
        ? `DRIVER_LOAD|${driverLoadId}|PICKUP|${text(sharedPickup.key)}`
        : `TO|${retainedReference.toUpperCase()}`;
      const group = replenishmentTransferGroups.get(groupKey) || {
        groupKey,
        references: new Map(),
        entries: [],
        visits: []
      };
      group.references.set(`TO|${retainedReference.toUpperCase()}`, {
        sourceType: "TO",
        rootReference: retainedReference
      });
      group.entries.push({ occurrence, canonicalOrder });
      group.visits.push(...occurrence.pickups, ...occurrence.drops);
      replenishmentTransferGroups.set(groupKey, group);
      continue;
    }
    const routeStops = orderRoute(occurrence, canonicalOrder);
    const directTransfer = occurrence.sourceType === "TO" && occurrence.directDependency;
    const billingRule = occurrence.sourceType === "SO"
      ? "so_order"
      : directTransfer
        ? "to_direct_additional_drop"
        : "to_replenishment";
    const evidenceVisits = [...occurrence.pickups, ...occurrence.drops];
    const loadsEvidence = evidenceLoads(evidenceVisits);
    const retainedReference = text(canonicalOrder.billingReference) || occurrence.rootReference;
    units.push({
      unitKey: `${occurrence.sourceType}|${retainedReference.toUpperCase()}`,
      billingRule,
      references: [{ sourceType: occurrence.sourceType, rootReference: retainedReference }],
      routeStops,
      originLabel: routeStops[0]?.addressText || "",
      destinationLabel: routeStops.at(-1)?.addressText || "",
      dropCount: routeStops.filter((stop) => stop.stopType === "dropoff").length,
      completedAt: lastCompletion(evidenceVisits),
      ...loadsEvidence,
      loadNumber: loadsEvidence.driverLoadNumbers.join(" + "),
      relationship: {
        code: billingRule,
        summary: billingRule === "so_order"
          ? "Sales Order charged independently, once for the order."
          : directTransfer
            ? "Direct-pickup Transfer Order counted as one additional drop."
            : "Replenishment Transfer Order charged in full, once for the order."
      }
    });
  }

  for (const group of replenishmentTransferGroups.values()) {
    const references = [...group.references.values()];
    const pickupVisits = group.entries.flatMap(
      (/** @type {Record<string, any>} */ entry) => entry.occurrence.pickups
    );
    const origin = group.entries.map(
      (/** @type {Record<string, any>} */ entry) => text(entry.canonicalOrder.originAddressOverride)
    ).find(Boolean)
      || uniqueVisitAddresses(pickupVisits)[0]
      || group.entries.map(
        (/** @type {Record<string, any>} */ entry) => text(entry.canonicalOrder.originAddress)
      ).find(Boolean)
      || "";
    /** @type {string[]} */
    const destinations = [];
    for (const entry of group.entries) {
      const override = text(entry.canonicalOrder.destinationAddressOverride);
      const actual = uniqueVisitAddresses(entry.occurrence.drops);
      const retained = override
        ? [override]
        : actual.length
          ? actual
          : [text(entry.canonicalOrder.destinationAddress)].filter(Boolean);
      for (const destination of retained) {
        if (!destinations.some((current) => normalizedAddress(current) === normalizedAddress(destination))) {
          destinations.push(destination);
        }
      }
    }
    const routeStops = origin
      ? [
          { addressText: origin, stopType: "pickup" },
          ...destinations.map((addressText) => ({ addressText, stopType: "dropoff" }))
        ]
      : [];
    const loadsEvidence = evidenceLoads(group.visits);
    const multiOrderOrDrop = references.length > 1 || destinations.length > 1;
    const billingRule = multiOrderOrDrop
      ? "to_replenishment_multi_drop"
      : "to_replenishment";
    units.push({
      unitKey: `TO_LEG|${group.groupKey}|${references.map((reference) => reference.rootReference.toUpperCase()).join("+")}`,
      billingRule,
      references,
      routeStops,
      originLabel: origin,
      destinationLabel: destinations.join(" → "),
      dropCount: destinations.length,
      completedAt: lastCompletion(group.visits),
      ...loadsEvidence,
      loadNumber: loadsEvidence.driverLoadNumbers.join(" + "),
      ...(billingRule === "to_replenishment_multi_drop"
        ? { distanceStrategy: "longest_origin_to_drop" }
        : {}),
      relationship: {
        code: billingRule,
        summary: billingRule === "to_replenishment_multi_drop"
          ? `${references.length} replenishment Transfer Order reference(s) share one immutable Driver load and physical pickup; charge the longest origin-to-drop distance once plus each additional distinct drop.`
          : "Replenishment Transfer Order charged in full, once for the order."
      }
    });
  }

  for (const group of explicitSalesGroups.values()) {
    const routeStops = groupedSalesRoute(group);
    const loadsEvidence = evidenceLoads(group.visits);
    const memberReferences = orderedGroupMembers(group);
    units.push({
      unitKey: `SO_GROUP|${group.groupReference.toUpperCase()}`,
      billingRule: "so_group",
      references: [{ sourceType: "SO", rootReference: group.groupReference }],
      memberReferences,
      routeStops,
      originLabel: routeStops[0]?.addressText || "",
      destinationLabel: routeStops.at(-1)?.addressText || "",
      dropCount: routeStops.filter((stop) => stop.stopType === "dropoff").length,
      completedAt: lastCompletion(group.visits),
      ...loadsEvidence,
      loadNumber: loadsEvidence.driverLoadNumbers.join(" + "),
      relationship: {
        code: "so_group",
        summary: `${group.groupReference} is charged once as one Sales Order group; ${memberReferences.length} child Sales Order reference(s) are retained as audit evidence. Dispatch load splits do not change the charge.`
      }
    });
  }

  /** @type {Map<string, Record<string, any>>} */
  const poGroups = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const explicitPurchaseGroups = new Map();
  for (const occurrence of byReference.values()) {
    if (!new Set(["PO", "VRMA"]).has(occurrence.sourceType)) {
      continue;
    }
    const canonicalOrder = canonical.get(`${occurrence.sourceType}|${occurrence.rootReference.toUpperCase()}`) || {};
    if (occurrence.sourceType === "PO" && retainExplicitGroup(explicitPurchaseGroups, occurrence, canonicalOrder)) {
      continue;
    }
    const pickupAddresses = uniqueVisitAddresses(occurrence.pickups);
    const actualDrops = uniqueVisitAddresses(occurrence.drops);
    const origin = text(canonicalOrder.originAddressOverride)
      || text(canonicalOrder.originAddress)
      || pickupAddresses[0]
      || "";
    const destinationOverride = text(canonicalOrder.destinationAddressOverride);
    const destinations = destinationOverride
      ? [destinationOverride]
      : actualDrops.length
        ? actualDrops
        : text(canonicalOrder.destinationAddress)
          ? [text(canonicalOrder.destinationAddress)]
          : [];
    const routeKey = `${normalizedAddress(origin)}>${destinations.map(normalizedAddress).join(">")}`;
    const driverLoadId = text(occurrence.driverLoadId);
    const normalizedOrigin = normalizedAddress(origin);
    const missingOriginScope = `${occurrence.sourceType}|${occurrence.rootReference.toUpperCase()}`;
    const groupKey = driverLoadId
      ? `DRIVER_LOAD|${driverLoadId}|ORIGIN|${normalizedOrigin || missingOriginScope}`
      : `LEGACY|${text(canonicalOrder.billingGroupKey) || routeKey || missingOriginScope}`;
    const retainedReference = text(canonicalOrder.billingReference) || occurrence.rootReference;
    const group = poGroups.get(groupKey) || {
      groupKey,
      driverLoadId,
      references: new Map(),
      origin,
      destinations: new Map(),
      visits: []
    };
    group.references.set(`${occurrence.sourceType}|${retainedReference.toUpperCase()}`, {
      sourceType: occurrence.sourceType,
      rootReference: retainedReference
    });
    for (const destination of destinations) {
      const destinationKey = normalizedAddress(destination);
      if (!group.destinations.has(destinationKey)) {
        group.destinations.set(destinationKey, destination);
      }
    }
    group.visits.push(...occurrence.pickups, ...occurrence.drops);
    poGroups.set(groupKey, group);
  }
  for (const group of poGroups.values()) {
    const references = [...group.references.values()].sort((left, right) =>
      left.sourceType.localeCompare(right.sourceType) || left.rootReference.localeCompare(right.rootReference)
    );
    const destinations = [...group.destinations.values()];
    const routeStops = group.origin
      ? [
          { addressText: group.origin, stopType: "pickup" },
          ...destinations.map((addressText) => ({ addressText, stopType: "dropoff" }))
        ]
      : [];
    const loadsEvidence = evidenceLoads(group.visits);
    const referenceKey = references.map((reference) => `${reference.sourceType}|${reference.rootReference.toUpperCase()}`).join("+");
    const retainedLoadIdentity = group.driverLoadId
      ? `DRIVER_LOAD|${group.driverLoadId}`
      : "LEGACY_LOAD";
    units.push({
      unitKey: `PO_LEG|${retainedLoadIdentity}|${referenceKey}|${normalizedAddress(group.origin)}|${destinations.map(normalizedAddress).join(">")}`,
      billingRule: "po_shared_leg",
      references,
      routeStops,
      originLabel: routeStops[0]?.addressText || "",
      destinationLabel: destinations.join(" → "),
      dropCount: destinations.length,
      completedAt: lastCompletion(group.visits),
      ...loadsEvidence,
      loadNumber: loadsEvidence.driverLoadNumbers.join(" + "),
      relationship: {
        code: "po_shared_leg",
        summary: group.driverLoadId
          ? `${references.length} Purchase Order/VRMA reference(s) share immutable Driver load ${group.driverLoadId}; this specific physical leg is charged once and allocated evenly.`
          : `${references.length} legacy Purchase Order/VRMA reference(s) share one retained business leg; the leg total is allocated evenly.`
      }
    });
  }
  for (const group of explicitPurchaseGroups.values()) {
    const entries = [...group.entries].sort((left, right) =>
      Number(left.canonicalOrder.orderGroupPosition) - Number(right.canonicalOrder.orderGroupPosition)
        || left.occurrence.rootReference.localeCompare(right.occurrence.rootReference)
    );
    const origin = entries.map((entry) => text(entry.canonicalOrder.originAddressOverride)).find(Boolean)
      || entries.map((entry) => text(entry.canonicalOrder.originAddress)).find(Boolean)
      || uniqueVisitAddresses(group.visits.filter((/** @type {Record<string, any>} */ visit) => visit.stopType === "pickup"))[0]
      || "";
    const destinations = new Map();
    for (const entry of entries) {
      const override = text(entry.canonicalOrder.destinationAddressOverride);
      const actual = uniqueVisitAddresses(entry.occurrence.drops);
      const retained = override
        ? [override]
        : actual.length
          ? actual
          : [text(entry.canonicalOrder.destinationAddress)].filter(Boolean);
      for (const destination of retained) {
        if (!destinations.has(normalizedAddress(destination))) {
          destinations.set(normalizedAddress(destination), destination);
        }
      }
    }
    const retainedDestinations = [...destinations.values()];
    const routeStops = origin
      ? [
          { addressText: origin, stopType: "pickup" },
          ...retainedDestinations.map((addressText) => ({ addressText, stopType: "dropoff" }))
        ]
      : [];
    const loadsEvidence = evidenceLoads(group.visits);
    const memberReferences = orderedGroupMembers(group);
    units.push({
      unitKey: `PO_GROUP|${group.groupReference.toUpperCase()}`,
      billingRule: "po_group",
      references: [{ sourceType: "PO", rootReference: group.groupReference }],
      memberReferences,
      routeStops,
      originLabel: routeStops[0]?.addressText || "",
      destinationLabel: retainedDestinations.join(" → "),
      dropCount: retainedDestinations.length,
      completedAt: lastCompletion(group.visits),
      ...loadsEvidence,
      loadNumber: loadsEvidence.driverLoadNumbers.join(" + "),
      relationship: {
        code: "po_group",
        summary: `${group.groupReference} is charged once as one Purchase Order group; ${memberReferences.length} child Purchase Order reference(s) are retained as audit evidence. Dispatch load splits do not change the charge.`
      }
    });
  }

  units.sort((left, right) => unitSortKey(left).localeCompare(unitSortKey(right)));
  const fallbackCompletedAt = (() => {
    const values = loads.map((load) => text(load.completedAt)).filter(Boolean).sort();
    return values.at(-1) || "";
  })();
  return units.map((unit, index) => ({
    ...unit,
    planId: text(input.planId),
    planDate: text(input.planDate),
    completedAt: unit.completedAt || fallbackCompletedAt,
    legNumber: index + 1,
    routeStopCount: unit.routeStops.length,
    chargeable: unit.references.length > 0 && unit.routeStops.length >= 2 && unit.dropCount > 0,
    reason: unit.references.length === 0
      ? "No billable reference is retained."
      : unit.routeStops.length < 2 || unit.dropCount < 1
        ? "At least one origin and one destination are required."
        : null
  }));
}
