function pickupText(value) {
  return String(value || "").trim();
}

function samePickup(left, right) {
  const cleanLeft = pickupText(left);
  const cleanRight = pickupText(right);
  return Boolean(cleanLeft && cleanRight && cleanLeft.toLowerCase() === cleanRight.toLowerCase());
}

export function scmPoPickupNeedsNetSuiteAddressLookup({
  requestedPickup = "",
  currentPickup = "",
  groupRef = ""
} = {}) {
  return Boolean(pickupText(requestedPickup)
    && !pickupText(currentPickup)
    && !pickupText(groupRef));
}

export function isUnchangedScmPoPickup({
  requestedPickup = "",
  currentPickup = "",
  groupRef = "",
  netSuiteAddressVendor = ""
} = {}) {
  const requested = pickupText(requestedPickup);
  const stored = pickupText(currentPickup);
  if (!requested) return false;
  if (stored) return samePickup(requested, stored);
  if (pickupText(groupRef)) return false;
  return samePickup(requested, netSuiteAddressVendor);
}
