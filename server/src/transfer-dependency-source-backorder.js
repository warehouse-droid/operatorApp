const EPSILON = 0.000001;

function quantity(value) {
  const parsed = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.max(0, Number(parsed.toFixed(6))) : 0;
}

export function transferDependencySourceBackorderDecision({
  requestedQuantity = 0,
  backorderEligibleQuantity = 0,
  availableQuantity = 0
} = {}) {
  const requested = quantity(requestedQuantity);
  const eligible = Math.min(requested, quantity(backorderEligibleQuantity));
  const available = quantity(availableQuantity);
  const protectedQuantity = quantity(Math.max(0, requested - eligible));
  return {
    allowed: protectedQuantity <= available + EPSILON,
    requestedQuantity: requested,
    backorderEligibleQuantity: eligible,
    protectedQuantity,
    availableQuantity: available,
    backorderQuantity: quantity(Math.max(0, requested - available))
  };
}
