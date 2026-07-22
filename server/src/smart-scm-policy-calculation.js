function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
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
  const formulaSafety = Math.max(
    positive(policy.minimum_safety_pallets),
    weeklyDemandSd * selectedServiceFactor * Math.sqrt(leadWeeks)
  );
  const formulaRop = Math.max(1, Math.round(formulaSafety + (weeklyDemand * leadWeeks)));
  const capacity = positive(policy.capacity_pallets, 25);
  const formulaPreferred = Math.min(capacity, Math.ceil(formulaRop + (weeklyDemand * leadWeeks)));
  const usePrediction = Boolean(forecast && forecastModel !== "formula");
  const predictedRop = Math.max(1, Math.ceil(forecastQuantileForPolicy(forecast || {}, policy)));
  const predictedReview = number(policy.service_quantile) >= 0.95
    ? positive(forecast?.p95_weekly)
    : positive(forecast?.p90_weekly);
  const predictedPreferred = Math.min(capacity, Math.ceil(predictedRop + predictedReview));
  const safetyStockPallets = usePrediction
    ? Math.max(positive(policy.minimum_safety_pallets), predictedRop - (weeklyDemand * leadWeeks))
    : formulaSafety;
  const baseReorderPointPallets = usePrediction ? predictedRop : formulaRop;
  const basePreferredPallets = usePrediction ? predictedPreferred : formulaPreferred;
  const zeroDemandCoverageApplied = Boolean(forecast?.zero_demand_coverage_applied);
  const coverageFloorPallets = zeroDemandCoverageApplied ? positive(forecast?.coverage_floor_pallets) : 0;
  const reorderPointPallets = Math.max(baseReorderPointPallets, coverageFloorPallets);
  const preferredPallets = Math.min(capacity, Math.max(basePreferredPallets, reorderPointPallets));

  return {
    forecastModel,
    usesPrediction: usePrediction,
    leadWeeks,
    weeklyDemandPallets: weeklyDemand,
    weeklyDemandSdPallets: weeklyDemandSd,
    serviceFactor: selectedServiceFactor,
    safetyStockPallets,
    baseReorderPointPallets,
    basePreferredPallets,
    zeroDemandCoverageApplied,
    coverageFloorPallets,
    capacityPallets: capacity,
    reorderPointPallets,
    preferredPallets
  };
}
