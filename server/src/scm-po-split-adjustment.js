function splitAmount(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error(`${label} must be zero or greater.`), {
      status: 400,
      code: "SCM_PO_SPLIT_QUANTITY_INVALID"
    });
  }
  return Math.round(amount * 1_000_000) / 1_000_000;
}

export function splitQuantityDelta({ current = 0, desired = 0 } = {}) {
  const cleanCurrent = splitAmount(current, "Current split quantity");
  const cleanDesired = splitAmount(desired, "Split quantity");
  return {
    current: cleanCurrent,
    desired: cleanDesired,
    delta: Math.round((cleanDesired - cleanCurrent) * 1_000_000) / 1_000_000
  };
}

export function assertSplitQuantityAvailable({ current = 0, desired = 0, sourceAvailable = 0 } = {}) {
  const change = splitQuantityDelta({ current, desired });
  const available = splitAmount(sourceAvailable, "Source available quantity");
  if (change.delta > available + 0.000001) {
    throw Object.assign(
      new Error(`Only ${available} additional source quantity is available for this split line.`),
      {
        status: 409,
        code: "SCM_PO_SPLIT_QUANTITY_EXCEEDS_SOURCE",
        available,
        requestedAdditional: change.delta
      }
    );
  }
  return change;
}

export function adjustBlanketSplitAllocation(allocation = {}, delta = 0) {
  const next = {
    planned: splitAmount(allocation.planned || 0, "Blanket planned quantity"),
    released: splitAmount(allocation.released || 0, "Blanket released quantity"),
    held: splitAmount(allocation.held || 0, "Blanket held quantity"),
    cancelled: splitAmount(allocation.cancelled || 0, "Blanket cancelled quantity")
  };
  const change = Number(delta);
  if (!Number.isFinite(change)) {
    throw Object.assign(new Error("Blanket split adjustment must be numeric."), {
      status: 400,
      code: "SCM_PO_SPLIT_QUANTITY_INVALID"
    });
  }
  if (change < 0) {
    const reduction = Math.round(Math.abs(change) * 1_000_000) / 1_000_000;
    if (reduction > next.released + 0.000001) {
      throw Object.assign(new Error("A split cannot reduce more than its released Blanket quantity."), {
        status: 409,
        code: "SCM_PO_SPLIT_BLANKET_RELEASE_EXCEEDED"
      });
    }
    next.released = Math.round((next.released - reduction) * 1_000_000) / 1_000_000;
    next.cancelled = Math.round((next.cancelled + reduction) * 1_000_000) / 1_000_000;
    return next;
  }
  if (change > 0) {
    const increase = Math.round(change * 1_000_000) / 1_000_000;
    const restored = Math.min(next.cancelled, increase);
    const expanded = Math.round((increase - restored) * 1_000_000) / 1_000_000;
    next.cancelled = Math.round((next.cancelled - restored) * 1_000_000) / 1_000_000;
    next.released = Math.round((next.released + increase) * 1_000_000) / 1_000_000;
    next.planned = Math.round((next.planned + expanded) * 1_000_000) / 1_000_000;
  }
  return next;
}
