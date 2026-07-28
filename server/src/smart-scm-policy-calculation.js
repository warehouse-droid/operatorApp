function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

const EPSILON = 0.000001;
export const LOWER_STOCK_POLICY_MINIMUM_SAFETY_PALLETS = 1;

export function calculateSmartScmOrderRequirement({
  positionPallets = 0,
  reorderPointPallets = 0,
  preferredPallets = 0,
  capacityPallets = 0,
  minimumOrderPallets = 1
} = {}) {
  const position = number(positionPallets);
  const reorderPoint = positive(reorderPointPallets);
  const preferred = positive(preferredPallets);
  const capacity = positive(capacityPallets);
  const minimumOrder = positive(minimumOrderPallets, 1);
  const requiredGapPallets = Math.max(0, preferred - position);
  const capacityGapPallets = Math.max(0, capacity - position);
  const requestedPallets = Math.ceil(Math.max(requiredGapPallets, minimumOrder));
  const capacityBelowMinimum = position < reorderPoint - EPSILON
    && capacityGapPallets + EPSILON < minimumOrder;
  const requiredPallets = position < reorderPoint - EPSILON && !capacityBelowMinimum
    ? Math.max(0, Math.min(requestedPallets, Math.floor(capacityGapPallets + EPSILON)))
    : 0;
  return {
    minimumOrderPallets: minimumOrder,
    requiredGapPallets,
    capacityGapPallets,
    requestedPallets,
    capacityBelowMinimum,
    requiredPallets
  };
}

function serviceFactor(policy = {}, settings = {}) {
  return String(policy.yard_code) === "12441"
    ? positive(settings.delivery_safety_factor, 1.645)
    : positive(settings.pickup_safety_factor, 1.3);
}

function forecastQuantileForPolicy(forecast = {}, policy = {}) {
  const target = number(policy.service_quantile, String(policy.yard_code) === "12441" ? 0.95 : 0.90);
  if (target >= 0.95) return number(forecast.lead_time_p95);
  if (target >= 0.90) return number(forecast.lead_time_p90);
  return number(forecast.lead_time_p75);
}

export function calculateSmartScmPolicyLevels(policy = {}, forecast = null, settings = {}) {
  const forecastModel = String(forecast?.authoritative_model || "formula");
  const lowerStockPolicyEnabled = policy.lower_stock_policy_enabled === true
    || policy.lowerStockPolicyEnabled === true;
  const leadWeeks = Math.max(
    1 / 7,
    positive(policy.effective_lead_time_days || policy.lead_time_days || policy.purchase_lead_time_days || 7) / 7
  );
  const weeklyDemand = !forecast || forecast.authoritative_model === "formula"
    ? positive(forecast?.formula_weekly_demand ?? forecast?.baseline_weekly)
    : positive(forecast?.p50_weekly || forecast?.baseline_weekly);
  const weeklyDemandSd = forecast?.formula_weekly_sd === null || forecast?.formula_weekly_sd === undefined
    ? Math.max(0, (positive(forecast?.p90_weekly) - positive(forecast?.p50_weekly)) / 1.282)
    : positive(forecast.formula_weekly_sd);
  const selectedServiceFactor = serviceFactor(policy, settings);
  const configuredMinimumSafetyPallets = positive(
    policy.minimum_safety_pallets ?? policy.minimumSafetyPallets
  );
  const effectiveMinimumSafetyPallets = lowerStockPolicyEnabled
    ? Math.min(configuredMinimumSafetyPallets, LOWER_STOCK_POLICY_MINIMUM_SAFETY_PALLETS)
    : configuredMinimumSafetyPallets;
  const variabilitySafetyPallets = weeklyDemandSd * selectedServiceFactor * Math.sqrt(leadWeeks);
  const standardFormulaSafety = Math.max(
    configuredMinimumSafetyPallets,
    variabilitySafetyPallets
  );
  const formulaSafety = Math.max(
    effectiveMinimumSafetyPallets,
    variabilitySafetyPallets
  );
  const standardFormulaRop = Math.max(1, Math.round(standardFormulaSafety + (weeklyDemand * leadWeeks)));
  const formulaRop = Math.max(1, Math.round(formulaSafety + (weeklyDemand * leadWeeks)));
  const capacity = positive(policy.capacity_pallets, 25);
  const standardFormulaPreferred = Math.min(capacity, Math.ceil(standardFormulaRop + (weeklyDemand * leadWeeks)));
  const formulaPreferred = Math.min(capacity, Math.ceil(formulaRop + (weeklyDemand * leadWeeks)));
  const usePrediction = Boolean(forecast && forecastModel !== "formula");
  const standardPredictedRop = Math.max(1, Math.ceil(forecastQuantileForPolicy(forecast || {}, policy)));
  const predictedReview = number(policy.service_quantile) >= 0.95
    ? positive(forecast?.p95_weekly)
    : positive(forecast?.p90_weekly);
  const standardPredictedSafety = Math.max(
    configuredMinimumSafetyPallets,
    standardPredictedRop - (weeklyDemand * leadWeeks)
  );
  const predictedSafety = Math.max(
    effectiveMinimumSafetyPallets,
    standardPredictedRop - (weeklyDemand * leadWeeks)
  );
  const standardPredictedPreferred = Math.min(capacity, Math.ceil(standardPredictedRop + predictedReview));
  // A promoted prediction model's lead-time quantile is its service target.
  // The optional floor may lower the safety-floor display, but it must not
  // subtract from that quantile or silently weaken the selected service level.
  const predictedRop = standardPredictedRop;
  const predictedPreferred = standardPredictedPreferred;
  const standardSafetyStockPallets = usePrediction ? standardPredictedSafety : standardFormulaSafety;
  const safetyStockPallets = usePrediction
    ? predictedSafety
    : formulaSafety;
  const standardBaseReorderPointPallets = usePrediction ? standardPredictedRop : standardFormulaRop;
  const baseReorderPointPallets = usePrediction ? predictedRop : formulaRop;
  const standardBasePreferredPallets = usePrediction ? standardPredictedPreferred : standardFormulaPreferred;
  const basePreferredPallets = usePrediction ? predictedPreferred : formulaPreferred;
  const zeroDemandCoverageApplied = Boolean(forecast?.zero_demand_coverage_applied);
  const coverageFloorPallets = zeroDemandCoverageApplied ? positive(forecast?.coverage_floor_pallets) : 0;
  const standardReorderPointPallets = Math.max(standardBaseReorderPointPallets, coverageFloorPallets);
  const reorderPointPallets = Math.max(baseReorderPointPallets, coverageFloorPallets);
  const standardPreferredPallets = Math.min(
    capacity,
    Math.max(standardBasePreferredPallets, standardReorderPointPallets)
  );
  const preferredPallets = Math.min(capacity, Math.max(basePreferredPallets, reorderPointPallets));
  const lowerStockPolicyApplied = lowerStockPolicyEnabled && (
    safetyStockPallets < standardSafetyStockPallets - EPSILON
    || reorderPointPallets < standardReorderPointPallets - EPSILON
    || preferredPallets < standardPreferredPallets - EPSILON
  );

  return {
    forecastModel,
    usesPrediction: usePrediction,
    lowerStockPolicyEnabled,
    lowerStockPolicyApplied,
    configuredMinimumSafetyPallets,
    effectiveMinimumSafetyPallets,
    leadWeeks,
    weeklyDemandPallets: weeklyDemand,
    weeklyDemandSdPallets: weeklyDemandSd,
    serviceFactor: selectedServiceFactor,
    standardSafetyStockPallets,
    safetyStockPallets,
    standardBaseReorderPointPallets,
    baseReorderPointPallets,
    standardBasePreferredPallets,
    basePreferredPallets,
    zeroDemandCoverageApplied,
    coverageFloorPallets,
    capacityPallets: capacity,
    standardReorderPointPallets,
    reorderPointPallets,
    standardPreferredPallets,
    preferredPallets
  };
}
