const EPSILON = 0.000001;
const MAX_RESERVATION_OVERRIDES = 100;
const RESERVATION_OVERRIDE_POLICY = "selected_full_netsuite_available_unsent_drafts_v2";

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function reservationError(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "TRANSFER_DEPENDENCY_RESERVATION_OVERRIDE_INVALID"
  });
}

function overrideSource(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.reservationOverrides)) return value.reservationOverrides;
  if (Array.isArray(value?.reservation_overrides)) return value.reservation_overrides;
  return [];
}

export function transferDependencyReservationOverrideKey(itemId, locationId) {
  const item = positiveInteger(itemId);
  const location = positiveInteger(locationId);
  return item && location ? `${item}:${location}` : "";
}

export function normalizeTransferDependencyReservationOverrides(
  value,
  { strict = false, max = MAX_RESERVATION_OVERRIDES } = {}
) {
  const source = overrideSource(value);
  if (strict && value !== undefined && value !== null && !Array.isArray(value)) {
    throw reservationError("Reservation overrides must be an array of item and yard selections.");
  }
  if (source.length > max) {
    throw reservationError(`A maximum of ${max} reservation overrides can be selected at one time.`);
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of source) {
    const itemId = positiveInteger(entry?.itemId ?? entry?.item_id);
    const locationId = positiveInteger(entry?.locationId ?? entry?.location_id);
    const key = transferDependencyReservationOverrideKey(itemId, locationId);
    if (!key) {
      if (strict) {
        throw reservationError("Every reservation override must identify a valid NetSuite item and source yard.");
      }
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      ...(entry && typeof entry === "object" ? entry : {}),
      itemId,
      locationId
    });
  }
  return normalized;
}

export function transferDependencyReservationOverrideSet(value) {
  return new Set(normalizeTransferDependencyReservationOverrides(value)
    .map((entry) => transferDependencyReservationOverrideKey(entry.itemId, entry.locationId))
    .filter(Boolean));
}

export function transferDependencyReservationOverridesFromSnapshot(value) {
  const policy = String(
    value?.reservationOverridePolicy
      ?? value?.reservation_override_policy
      ?? ""
  ).trim();
  return policy === RESERVATION_OVERRIDE_POLICY
    ? normalizeTransferDependencyReservationOverrides(value)
    : [];
}

export function transferDependencyReservationOverrideSetFromSnapshot(value) {
  return transferDependencyReservationOverrideSet(
    transferDependencyReservationOverridesFromSnapshot(value)
  );
}

export function transferDependencyPlanningAvailability(balance = {}, overrideKeys = new Set()) {
  const key = transferDependencyReservationOverrideKey(
    balance.itemId ?? balance.item_id,
    balance.locationId ?? balance.location_id
  );
  const quantityAvailable = Number(balance.quantityAvailable ?? balance.quantity_available ?? 0);
  const effectiveAvailable = Number(balance.effectiveAvailable ?? balance.effective_available ?? 0);
  const overridden = Boolean(key && overrideKeys?.has?.(key));
  const selected = overridden ? quantityAvailable : effectiveAvailable;
  return {
    key,
    overridden,
    quantityAvailable: Number.isFinite(quantityAvailable) ? Math.max(0, quantityAvailable) : 0,
    effectiveAvailable: Number.isFinite(effectiveAvailable) ? Math.max(0, effectiveAvailable) : 0,
    planningAvailable: Number.isFinite(selected) ? Math.max(0, selected) : 0,
    localReservationIgnored: overridden
      ? Math.max(0, (Number.isFinite(quantityAvailable) ? quantityAvailable : 0)
        - (Number.isFinite(effectiveAvailable) ? effectiveAvailable : 0))
      : 0
  };
}

export const transferDependencyReservationContract = Object.freeze({
  policy: RESERVATION_OVERRIDE_POLICY,
  maxOverrides: MAX_RESERVATION_OVERRIDES,
  epsilon: EPSILON
});
