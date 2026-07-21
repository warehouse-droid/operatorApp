import { query } from "./db.js";
import { writeAudit } from "./auth-repository.js";

const EPSILON = 0.000001;
const BUSINESS_SEASONAL_PRIOR = Object.freeze([
  0.35, 0.40, 0.65, 0.90, 1.15, 1.35,
  1.45, 1.35, 1.15, 0.80, 0.35, 0.25
]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function wholeWeeks(value, fallback = 6) {
  return Math.min(52, Math.max(2, Math.round(number(value, fallback))));
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(number(value, fallback))));
}

function median(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values = [], ratio = 0.5) {
  const sorted = values.map(Number).filter((value) => Number.isFinite(value) && value > EPSILON).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * Math.min(0.75, Math.max(0.25, number(ratio, 0.5)));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function normalizedDeliveryMethod(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function expectedDeliveryMethod(policy = {}) {
  return String(policy.yard_code) === "12441" ? "delivery" : "pickup";
}

function normalizedCoverageGroup(policy = {}) {
  return String(policy.series || policy.vendor || "all").trim().toLowerCase() || "all";
}

export function smartScmCoverageFloor({ representativeOrderPallets = 0, orderCount = 0, capacityPallets = 0 } = {}) {
  const rawFloorPallets = Math.max(0, number(representativeOrderPallets)) * Math.max(0, number(orderCount));
  const requestedFloorPallets = rawFloorPallets > EPSILON ? Math.ceil(rawFloorPallets - EPSILON) : 0;
  const capacity = Math.max(0, number(capacityPallets));
  return {
    rawFloorPallets: round(rawFloorPallets),
    requestedFloorPallets,
    coverageFloorPallets: Math.min(capacity, requestedFloorPallets),
    capacityShortfall: requestedFloorPallets > capacity + EPSILON
  };
}

function standardDeviation(values = []) {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + number(value), 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((number(value) - average) ** 2), 0) / (values.length - 1));
}

function mondayUtc(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date;
}

function weekKey(date) {
  return date.toISOString().slice(0, 10);
}
function latestCompletedWeek(value) {
  const monday = mondayUtc(value);
  if (!monday) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if ((date.getUTCDay() || 7) !== 7) monday.setUTCDate(monday.getUTCDate() - 7);
  return monday;
}


function weeklyTimeline(facts = [], completedThrough = null, padThroughCompletedWeek = false) {
  if (!facts.length) return { dates: [], values: [] };
  const weekly = new Map();
  const end = completedThrough ? new Date(completedThrough) : null;
  for (const fact of facts) {
    const monday = mondayUtc(fact.transaction_date);
    if (!monday) continue;
    if (end && monday > end) continue;
    const key = weekKey(monday);
    weekly.set(key, number(weekly.get(key)) + number(fact.pallet_quantity));
  }
  const dates = [...weekly.keys()].map((key) => new Date(`${key}T00:00:00Z`)).sort((a, b) => a - b);
  if (!dates.length) return { dates: [], values: [] };
  const latestItemWeek = dates[dates.length - 1];
  const last = end && end < latestItemWeek ? end : (padThroughCompletedWeek && end ? end : latestItemWeek);
  const values = [];
  const keys = [];
  for (let cursor = new Date(dates[0]); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const key = weekKey(cursor);
    keys.push(key);
    values.push(number(weekly.get(key)));
  }
  return { dates: keys, values };
}

function trailingAverage(values, weeks) {
  const selected = values.slice(-Math.max(1, weeks));
  return selected.length ? selected.reduce((sum, value) => sum + number(value), 0) / selected.length : 0;
}
function fixedWindow(values = [], weeks = 6) {
  const count = wholeWeeks(weeks);
  const selected = values.slice(-count).map((value) => Math.max(0, number(value)));
  return selected.length < count ? [...Array(count - selected.length).fill(0), ...selected] : selected;
}

function formulaDemandEvidence(policy, values = [], settings = {}) {
  const averageWeeks = wholeWeeks(settings.formula_average_weeks, 6);
  const stockoutWeeks = wholeWeeks(settings.stockout_benchmark_weeks, 6);
  const toPlt = number(policy.to_plt);
  const availablePallets = toPlt > EPSILON ? Math.max(0, number(policy.quantity_available)) / toPlt : 0;
  const stockout = toPlt > EPSILON && availablePallets < 1 - EPSILON;
  const windowWeeks = stockout ? stockoutWeeks : averageWeeks;
  const selected = fixedWindow(values, windowWeeks);
  const multiplier = expectedDemandMultiplier(policy.expected_demand_change);
  const average = trailingAverage(selected, windowWeeks);
  const peak = selected.length ? Math.max(...selected) : 0;
  return {
    demand: Math.max(0, stockout ? peak : average) * multiplier,
    standardDeviation: standardDeviation(selected) * multiplier,
    stockout,
    windowWeeks,
    availablePallets
  };
}


function crostonSba(values = [], alpha = 0.15) {
  let demand = 0;
  let interval = 1;
  let gap = 1;
  let initialized = false;
  for (const raw of values) {
    const value = Math.max(0, number(raw));
    if (value > EPSILON) {
      if (!initialized) {
        demand = value;
        interval = gap;
        initialized = true;
      } else {
        demand += alpha * (value - demand);
        interval += alpha * (gap - interval);
      }
      gap = 1;
    } else {
      gap += 1;
    }
  }
  return initialized ? Math.max(0, (1 - (alpha / 2)) * demand / Math.max(interval, EPSILON)) : 0;
}

function tsb(values = [], alpha = 0.15, beta = 0.15) {
  let probability = 0;
  let demand = 0;
  let initialized = false;
  for (const raw of values) {
    const value = Math.max(0, number(raw));
    const occurred = value > EPSILON ? 1 : 0;
    if (!initialized && occurred) {
      probability = 1;
      demand = value;
      initialized = true;
      continue;
    }
    probability += beta * (occurred - probability);
    if (occurred) demand += alpha * (value - demand);
  }
  return initialized ? Math.max(0, probability * demand) : 0;
}

function normalizeSeasonalFactors(values = []) {
  const clean = values.map((value) => Math.max(0.1, number(value, 1)));
  const average = clean.reduce((sum, value) => sum + value, 0) / Math.max(1, clean.length);
  return clean.map((value) => value / Math.max(average, EPSILON));
}

function seasonalProfile(dates = [], values = []) {
  const prior = normalizeSeasonalFactors(BUSINESS_SEASONAL_PRIOR);
  const overall = values.length ? values.reduce((sum, value) => sum + Math.max(0, number(value)), 0) / values.length : 0;
  if (overall <= EPSILON) return { factors: prior, source: "business_prior", observations: Array(12).fill(0) };
  const totals = Array(12).fill(0);
  const observations = Array(12).fill(0);
  dates.forEach((dateValue, index) => {
    const date = new Date(`${dateValue}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return;
    const month = date.getUTCMonth();
    totals[month] += Math.max(0, number(values[index]));
    observations[month] += 1;
  });
  const blended = prior.map((priorFactor, month) => {
    if (!observations[month]) return priorFactor;
    const empirical = (totals[month] / observations[month]) / overall;
    const evidenceWeight = Math.min(0.75, observations[month] / (observations[month] + 8));
    return (priorFactor * (1 - evidenceWeight)) + (Math.max(0.1, empirical) * evidenceWeight);
  });
  return { factors: normalizeSeasonalFactors(blended), source: "business_prior_plus_history", observations };
}

function dateAfterLastWeek(dates = []) {
  const last = dates.at(-1);
  const date = last ? new Date(`${last}T00:00:00Z`) : new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  return date;
}

function pureSeasonalForecast(values = [], dates = [], targetDate = dateAfterLastWeek(dates)) {
  if (!values.length) return 0;
  const profile = seasonalProfile(dates, values);
  const deseasonalized = values.map((value, index) => {
    const date = new Date(`${dates[index]}T00:00:00Z`);
    const factor = profile.factors[Number.isNaN(date.getTime()) ? 0 : date.getUTCMonth()];
    return Math.max(0, number(value)) / Math.max(factor, EPSILON);
  });
  const base = trailingAverage(deseasonalized, Math.min(26, Math.max(1, deseasonalized.length)));
  return Math.max(0, base * profile.factors[targetDate.getUTCMonth()]);
}

function formulaAverageForecast(values = [], weeks = 6) {
  return trailingAverage(fixedWindow(values, weeks), wholeWeeks(weeks));
}

function candidateForecasts(values = [], groupMedian = 0, dates = [], targetDate = dateAfterLastWeek(dates), formulaWeeks = 6) {
  const baseline = formulaAverageForecast(values, formulaWeeks);
  return {
    formula: baseline,
    moving_4: trailingAverage(values, 4),
    seasonal: pureSeasonalForecast(values, dates, targetDate),
    croston_sba: crostonSba(values),
    tsb: tsb(values),
    hierarchical: (baseline * 0.65) + (Math.max(0, groupMedian) * 0.35)
  };
}

function forecastValue(model, values, groupMedian = 0, dates = [], targetDate = dateAfterLastWeek(dates), formulaWeeks = 6) {
  if (model === "formula") return formulaAverageForecast(values, formulaWeeks);
  if (model === "moving_4") return trailingAverage(values, 4);
  if (model === "seasonal") return pureSeasonalForecast(values, dates, targetDate);
  if (model === "croston_sba") return crostonSba(values);
  if (model === "tsb") return tsb(values);
  if (model === "hierarchical") {
    return (formulaAverageForecast(values, formulaWeeks) * 0.65) + (Math.max(0, groupMedian) * 0.35);
  }
  return 0;
}

function scoreModel(model, values = [], groupMedian = 0, dates = [], formulaWeeks = 6) {
  const cutoffs = Math.min(8, Math.max(0, values.length - 4));
  if (cutoffs < 4) return { wape: null, bias: null, cutoffs };
  const start = values.length - cutoffs;
  let absoluteError = 0;
  let signedError = 0;
  let actualTotal = 0;
  for (let index = start; index < values.length; index += 1) {
    const targetDate = new Date(`${dates[index]}T00:00:00Z`);
    const prediction = forecastValue(model, values.slice(0, index), groupMedian, dates.slice(0, index), targetDate, formulaWeeks);
    const actual = number(values[index]);
    absoluteError += Math.abs(prediction - actual);
    signedError += prediction - actual;
    actualTotal += actual;
  }
  return {
    wape: actualTotal > EPSILON ? absoluteError / actualTotal : null,
    bias: actualTotal > EPSILON ? signedError / actualTotal : null,
    cutoffs
  };
}

function seasonalLeadDemand(weeklyValue, targetDate, weeks, factors = Array(12).fill(1)) {
  if (!(weeks > 0) || !(weeklyValue > 0)) return 0;
  const targetFactor = Math.max(EPSILON, number(factors[targetDate.getUTCMonth()], 1));
  const base = weeklyValue / targetFactor;
  let remaining = weeks;
  let total = 0;
  const cursor = new Date(targetDate);
  while (remaining > EPSILON) {
    const portion = Math.min(1, remaining);
    total += base * number(factors[cursor.getUTCMonth()], 1) * portion;
    cursor.setUTCDate(cursor.getUTCDate() + 7);
    remaining -= portion;
  }
  return Math.max(0, total);
}

function expectedDemandMultiplier(value) {
  const change = number(value);
  if (!change) return 1;
  const ratio = Math.abs(change) > 1 ? change / 100 : change;
  return Math.max(0, 1 + ratio);
}

function modelSegmentActive(settings = {}, policy = {}) {
  const active = settings.model_active_segments || {};
  const yard = String(policy.yard_code || "");
  const series = String(policy.series || "").trim().toLowerCase() || "all";
  return active[`${yard}:${series}`] === true || active[`${yard}:*`] === true || active["*:*"] === true;
}

async function smartScmSettings() {
  const result = await query("SELECT * FROM scm_smart_settings WHERE id = 1");
  return result.rows[0] || {};
}

async function forecastPolicies() {
  const result = await query(
    `SELECT p.*,
            COALESCE(i.item_name, p.item_name) AS item_name,
            COALESCE(i.vendor, p.vendor) AS vendor,
            COALESCE(i.series, p.series) AS series,
            COALESCE(i.to_plt, p.to_plt) AS to_plt,
            COALESCE(p.lead_time_days, i.netsuite_lead_time_days, p.purchase_lead_time_days, 7) AS effective_lead_time_days,
            y.location_id, y.yard_code, y.eligible, y.capacity_pallets,
            y.service_quantile, y.minimum_safety_pallets,
            COALESCE(b.quantity_available, 0) AS quantity_available
       FROM scm_smart_item_policies p
       JOIN scm_smart_item_yard_policies y ON y.item_id = p.item_id
       LEFT JOIN inventory_items i ON i.item_id = p.item_id
       LEFT JOIN inventory_balances b ON b.item_id = p.item_id AND b.location_id = y.location_id
      WHERE y.eligible = true
        AND p.planning_enabled = true
        AND p.inactive = false
        AND p.discontinued = false
      ORDER BY p.item_id, y.location_id`
  );
  return result.rows;
}

async function salesFactsForPolicies(policies = []) {
  if (!policies.length) return [];
  const itemIds = [...new Set(policies.map((policy) => Number(policy.item_id)).filter(Number.isInteger))];
  const result = await query(
    `WITH selected_source AS (
       SELECT CASE
         WHEN EXISTS (SELECT 1 FROM scm_smart_sales_facts WHERE source = 'csv') THEN 'csv'
         WHEN EXISTS (SELECT 1 FROM scm_smart_sales_facts WHERE source = 'netsuite') THEN 'netsuite'
         ELSE 'workbook'
       END AS source
     )
     SELECT sf.id, sf.source_key, sf.transaction_date::text, sf.document_ref, sf.item_id, sf.location_id,
            sf.quantity, sf.delivery_method
       FROM scm_smart_sales_facts sf
       CROSS JOIN selected_source selected
      WHERE sf.source = selected.source
        AND sf.item_id = ANY($1::bigint[])
        AND sf.location_id IS NOT NULL
        AND sf.quantity > 0
      ORDER BY sf.transaction_date`,
    [itemIds]
  );
  return result.rows;
}

function blendEvidence(observed, prior, samples, strength) {
  if (!(observed > EPSILON)) return Math.max(0, number(prior));
  if (!(prior > EPSILON)) return Math.max(0, number(observed));
  const weight = Math.max(0, number(samples)) / (Math.max(0, number(samples)) + Math.max(1, number(strength, 8)));
  return (observed * weight) + (prior * (1 - weight));
}

function coverageOrderEvidence(policies = [], facts = [], completedThrough = null, settings = {}) {
  const ratio = Math.min(0.75, Math.max(0.25, number(settings.coverage_order_percentile, 0.5)));
  const historyWeeks = boundedInteger(settings.coverage_history_weeks, 104, 26, 260);
  const priorStrength = boundedInteger(settings.coverage_prior_strength_orders, 8, 1, 100);
  const end = completedThrough ? new Date(completedThrough) : null;
  const start = end ? new Date(end) : null;
  if (start) start.setUTCDate(start.getUTCDate() - ((historyWeeks - 1) * 7));
  const policyByItem = new Map();
  for (const policy of policies) {
    if (!policyByItem.has(String(policy.item_id))) policyByItem.set(String(policy.item_id), policy);
  }

  const orderTotals = new Map();
  for (const fact of facts) {
    const method = normalizedDeliveryMethod(fact.delivery_method);
    if (method !== "pickup" && method !== "delivery") continue;
    const policy = policyByItem.get(String(fact.item_id));
    const toPlt = number(policy?.to_plt);
    const locationId = Number(fact.location_id);
    const factWeek = mondayUtc(fact.transaction_date);
    if (!policy || !(toPlt > EPSILON) || !Number.isInteger(locationId) || !factWeek) continue;
    if (end && factWeek > end) continue;
    if (start && factWeek < start) continue;
    const documentRef = String(fact.document_ref || fact.source_key || `fact:${fact.id}`);
    const key = `${fact.item_id}|${locationId}|${method}|${documentRef}`;
    const current = orderTotals.get(key) || {
      itemId: Number(fact.item_id),
      locationId,
      method,
      pallets: 0
    };
    current.pallets += Math.max(0, number(fact.quantity)) / toPlt;
    orderTotals.set(key, current);
  }

  const samplesByKey = new Map();
  for (const order of orderTotals.values()) {
    if (!(order.pallets > EPSILON)) continue;
    const key = `${order.itemId}|${order.locationId}|${order.method}`;
    if (!samplesByKey.has(key)) samplesByKey.set(key, []);
    samplesByKey.get(key).push(order.pallets);
  }
  const statsByKey = new Map([...samplesByKey].map(([key, values]) => [key, {
    value: percentile(values, ratio),
    samples: values.length
  }]));

  const donorStats = new Map();
  const seriesValues = new Map();
  const channelValues = new Map();
  for (const [key, stats] of statsByKey) {
    const [itemId, locationId, method] = key.split("|");
    if (Number(locationId) !== 1 || !(stats.value > EPSILON)) continue;
    donorStats.set(`${itemId}|${method}`, stats);
    const policy = policyByItem.get(String(itemId));
    if (!policy) continue;
    const seriesKey = `${method}|${normalizedCoverageGroup(policy)}`;
    if (!seriesValues.has(seriesKey)) seriesValues.set(seriesKey, []);
    seriesValues.get(seriesKey).push(stats.value);
    if (!channelValues.has(method)) channelValues.set(method, []);
    channelValues.get(method).push(stats.value);
  }

  const evidenceByKey = new Map();
  for (const policy of policies) {
    const itemId = String(policy.item_id);
    const locationId = Number(policy.location_id);
    const method = expectedDeliveryMethod(policy);
    const local = statsByKey.get(`${itemId}|${locationId}|${method}`) || { value: 0, samples: 0 };
    const donor = donorStats.get(`${itemId}|${method}`) || { value: 0, samples: 0 };
    const seriesPrior = percentile(seriesValues.get(`${method}|${normalizedCoverageGroup(policy)}`) || [], ratio);
    const channelPrior = percentile(channelValues.get(method) || [], ratio);
    const fallbackPrior = seriesPrior > EPSILON ? seriesPrior : channelPrior;
    let prior = 0;
    let priorSource = "none";
    if (donor.value > EPSILON) {
      prior = blendEvidence(donor.value, fallbackPrior, donor.samples, priorStrength);
      priorSource = "donor_item_3445";
    } else if (seriesPrior > EPSILON) {
      prior = seriesPrior;
      priorSource = "series_channel";
    } else if (channelPrior > EPSILON) {
      prior = channelPrior;
      priorSource = "channel";
    }

    let representative = prior;
    let source = priorSource;
    if (locationId === 1) {
      if (local.value > EPSILON) {
        representative = blendEvidence(local.value, fallbackPrior, local.samples, priorStrength);
        source = local.samples >= priorStrength ? "local_item" : "local_item_blend";
      }
    } else if (local.value > EPSILON) {
      representative = blendEvidence(local.value, prior, local.samples, priorStrength);
      source = local.samples >= priorStrength ? "local_item" : "local_item_blend";
    }

    const orderCount = String(policy.yard_code) === "12441"
      ? boundedInteger(settings.zero_demand_delivery_order_count, 1, 1, 50)
      : boundedInteger(settings.zero_demand_pickup_order_count, 5, 1, 50);
    const floor = smartScmCoverageFloor({
      representativeOrderPallets: representative,
      orderCount,
      capacityPallets: policy.capacity_pallets
    });
    evidenceByKey.set(`${policy.item_id}:${policy.location_id}`, {
      representativeOrderPallets: round(representative),
      coverageOrderCount: orderCount,
      coverageFloorPallets: floor.coverageFloorPallets,
      coverageSource: source,
      coverageLocalSamples: local.samples,
      coverageDonorSamples: donor.samples,
      coverageCapacityShortfall: floor.capacityShortfall
    });
  }
  return evidenceByKey;
}

async function insertForecastRows(rows = []) {
  const columns = [
    "run_id", "item_id", "location_id", "yard_code", "selected_model", "authoritative_model", "confidence",
    "history_weeks", "positive_weeks", "baseline_weekly", "p50_weekly", "p75_weekly", "p90_weekly", "p95_weekly",
    "lead_time_p50", "lead_time_p75", "lead_time_p90", "lead_time_p95", "wape", "bias",
    "formula_weekly_demand", "formula_weekly_sd", "formula_stockout", "formula_window_weeks",
    "current_available_pallets",
    "representative_order_pallets", "coverage_order_count", "coverage_floor_pallets", "coverage_source",
    "coverage_local_samples", "coverage_donor_samples", "zero_demand_coverage_applied",
    "coverage_capacity_shortfall",
    "eligible_for_promotion", "drivers"
  ];
  for (let offset = 0; offset < rows.length; offset += 150) {
    const group = rows.slice(offset, offset + 150);
    const params = [];
    const values = group.map((row) => `(${columns.map((column) => {
      params.push(column === "drivers" ? JSON.stringify(row[column] || []) : row[column]);
      return `$${params.length}${column === "drivers" ? "::jsonb" : ""}`;
    }).join(", ")})`);
    await query(`INSERT INTO scm_smart_forecasts (${columns.join(", ")}) VALUES ${values.join(", ")}`, params);
  }
}

function publicForecast(row) {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    itemId: Number(row.item_id),
    itemName: row.item_name,
    series: row.series,
    yardCode: row.yard_code,
    locationId: Number(row.location_id),
    selectedModel: row.selected_model,
    authoritativeModel: row.authoritative_model,
    confidence: row.confidence,
    historyWeeks: Number(row.history_weeks || 0),
    positiveWeeks: Number(row.positive_weeks || 0),
    formulaWeeklyDemand: number(row.formula_weekly_demand),
    formulaWeeklySd: number(row.formula_weekly_sd),
    formulaStockout: Boolean(row.formula_stockout),
    formulaWindowWeeks: Number(row.formula_window_weeks || 0),
    currentAvailablePallets: number(row.current_available_pallets),
    representativeOrderPallets: number(row.representative_order_pallets),
    coverageOrderCount: Number(row.coverage_order_count || 0),
    coverageFloorPallets: number(row.coverage_floor_pallets),
    coverageSource: row.coverage_source || "none",
    coverageLocalSamples: Number(row.coverage_local_samples || 0),
    coverageDonorSamples: Number(row.coverage_donor_samples || 0),
    zeroDemandCoverageApplied: Boolean(row.zero_demand_coverage_applied),
    coverageCapacityShortfall: Boolean(row.coverage_capacity_shortfall),
    baselineWeekly: number(row.baseline_weekly),
    p50Weekly: number(row.p50_weekly),
    p75Weekly: number(row.p75_weekly),
    p90Weekly: number(row.p90_weekly),
    p95Weekly: number(row.p95_weekly),
    leadTimeP50: number(row.lead_time_p50),
    leadTimeP75: number(row.lead_time_p75),
    leadTimeP90: number(row.lead_time_p90),
    leadTimeP95: number(row.lead_time_p95),
    wape: row.wape === null ? null : number(row.wape),
    bias: row.bias === null ? null : number(row.bias),
    eligibleForPromotion: Boolean(row.eligible_for_promotion),
    drivers: row.drivers || []
  };
}

export async function runSmartScmForecast({ triggerSource = "manual", operatorId = null } = {}) {
  const created = await query(
    `INSERT INTO scm_smart_forecast_runs (trigger_source, created_by)
     VALUES ($1, $2)
     RETURNING *`,
    [triggerSource, operatorId]
  );
  const run = created.rows[0];
  try {
    const [settings, policies] = await Promise.all([smartScmSettings(), forecastPolicies()]);
    const facts = await salesFactsForPolicies(policies);
    const policyByKey = new Map(policies.map((policy) => [`${policy.item_id}:${policy.location_id}`, policy]));
    const factsByKey = new Map();
    let dataCutoff = null;
    for (const fact of facts) {
      if (!dataCutoff || fact.transaction_date > dataCutoff) dataCutoff = fact.transaction_date;
      const key = `${fact.item_id}:${fact.location_id}`;
      if (!policyByKey.has(key)) continue;
      const policy = policyByKey.get(key);
      if (normalizedDeliveryMethod(fact.delivery_method) !== expectedDeliveryMethod(policy)) continue;
      const toPlt = number(policy.to_plt);
      if (toPlt <= EPSILON) continue;
      if (!factsByKey.has(key)) factsByKey.set(key, []);
      factsByKey.get(key).push({ ...fact, pallet_quantity: number(fact.quantity) / toPlt });
    }
    const completedThrough = latestCompletedWeek(dataCutoff);
    const coverageByKey = coverageOrderEvidence(policies, facts, completedThrough, settings);
    const formulaWeeks = wholeWeeks(settings.formula_average_weeks, 6);
    const records = policies.map((policy) => {
      const key = `${policy.item_id}:${policy.location_id}`;
      const timeline = weeklyTimeline(factsByKey.get(key) || [], completedThrough);
      const recentTimeline = weeklyTimeline(factsByKey.get(key) || [], completedThrough, true);
      return {
        policy,
        key,
        dates: timeline.dates,
        series: timeline.values,
        recentSeries: recentTimeline.values,
        baseline: formulaAverageForecast(timeline.values, formulaWeeks)
      };
    });
    const groupedBaselines = new Map();
    for (const record of records) {
      const groupKey = `${record.policy.yard_code}:${String(record.policy.series || record.policy.vendor || "all").toLowerCase()}`;
      if (!groupedBaselines.has(groupKey)) groupedBaselines.set(groupKey, []);
      if (record.baseline > EPSILON) groupedBaselines.get(groupKey).push(record.baseline);
    }
    const rows = [];
    const summary = {
      forecasts: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      eligibleForPromotion: 0,
      authoritativeAi: 0,
      stockoutBenchmarks: 0,
      zeroDemandCoverageCandidates: 0,
      zeroDemandCoverageApplied: 0,
      borrowedCoverageApplied: 0
    };
    let baselineWapeSum = 0;
    let selectedWapeSum = 0;
    let scored = 0;
    for (const record of records) {
      const { policy, series, recentSeries, dates } = record;
      const groupKey = `${policy.yard_code}:${String(policy.series || policy.vendor || "all").toLowerCase()}`;
      const groupMedian = median(groupedBaselines.get(groupKey) || []);
      const targetDate = dateAfterLastWeek(dates);
      const profile = seasonalProfile(dates, series);
      const legacyFormulaEvidence = formulaDemandEvidence(policy, series, settings);
      const recentFormulaEvidence = formulaDemandEvidence(policy, recentSeries, settings);
      const formulaEvidence = recentFormulaEvidence.demand <= EPSILON ? recentFormulaEvidence : legacyFormulaEvidence;
      const coverage = coverageByKey.get(record.key) || {
        representativeOrderPallets: 0,
        coverageOrderCount: 0,
        coverageFloorPallets: 0,
        coverageSource: "none",
        coverageLocalSamples: 0,
        coverageDonorSamples: 0,
        coverageCapacityShortfall: false
      };
      const coverageCandidate = formulaEvidence.demand <= EPSILON && coverage.coverageFloorPallets > EPSILON;
      const coverageApplied = Boolean(settings.zero_demand_coverage_enabled) && coverageCandidate;
      const forecasts = candidateForecasts(series, groupMedian, dates, targetDate, formulaWeeks);
      const scoredModels = Object.keys(forecasts).map((model) => ({ model, ...scoreModel(model, series, groupMedian, dates, formulaWeeks) }));
      const scoreable = scoredModels.filter((score) => score.wape !== null);
      const selectedScore = scoreable.sort((a, b) => a.wape - b.wape)[0] || { model: series.length < 8 ? "hierarchical" : "formula", wape: null, bias: null, cutoffs: 0 };
      const formulaScore = scoredModels.find((score) => score.model === "formula") || { wape: null };
      const positiveWeeks = series.filter((value) => value > EPSILON).length;
      const historyWeeks = series.length;
      const confidence = historyWeeks >= 52 && positiveWeeks >= 16 ? "high" : historyWeeks >= 26 && positiveWeeks >= 8 ? "medium" : "low";
      const improvement = formulaScore.wape !== null && selectedScore.wape !== null && formulaScore.wape > EPSILON
        ? (formulaScore.wape - selectedScore.wape) / formulaScore.wape
        : 0;
      const eligible = historyWeeks >= 26
        && positiveWeeks >= 8
        && selectedScore.cutoffs >= 8
        && improvement >= 0.05
        && selectedScore.bias !== null
        && Math.abs(selectedScore.bias) <= 0.10;
      const selectedModel = selectedScore.model;
      const multiplier = expectedDemandMultiplier(policy.expected_demand_change);
      const p50 = Math.max(0, number(forecasts[selectedModel])) * multiplier;
      const residualStd = standardDeviation(series.slice(-Math.min(26, series.length))) * multiplier;
      const p75 = Math.max(p50, p50 + (0.674 * residualStd));
      const p90 = Math.max(p75, p50 + (1.282 * residualStd));
      const p95 = Math.max(p90, p50 + (1.645 * residualStd));
      const leadWeeks = Math.max(1 / 7, number(policy.effective_lead_time_days || policy.lead_time_days || policy.purchase_lead_time_days, 7) / 7);
      const authoritativeAi = settings.forecast_mode === "hybrid" && eligible && modelSegmentActive(settings, policy);
      rows.push({
        run_id: run.id,
        item_id: Number(policy.item_id),
        location_id: Number(policy.location_id),
        yard_code: policy.yard_code,
        selected_model: selectedModel,
        authoritative_model: authoritativeAi ? selectedModel : "formula",
        confidence,
        history_weeks: historyWeeks,
        positive_weeks: positiveWeeks,
        baseline_weekly: round(formulaEvidence.demand),
        p50_weekly: round(p50),
        p75_weekly: round(p75),
        p90_weekly: round(p90),
        p95_weekly: round(p95),
        lead_time_p50: round(seasonalLeadDemand(p50, targetDate, leadWeeks, profile.factors)),
        lead_time_p75: round(seasonalLeadDemand(p75, targetDate, leadWeeks, profile.factors)),
        lead_time_p90: round(seasonalLeadDemand(p90, targetDate, leadWeeks, profile.factors)),
        lead_time_p95: round(seasonalLeadDemand(p95, targetDate, leadWeeks, profile.factors)),
        wape: selectedScore.wape === null ? null : round(selectedScore.wape),
        bias: selectedScore.bias === null ? null : round(selectedScore.bias),
        formula_weekly_demand: round(formulaEvidence.demand),
        formula_weekly_sd: round(formulaEvidence.standardDeviation),
        formula_stockout: formulaEvidence.stockout,
        formula_window_weeks: formulaEvidence.windowWeeks,
        current_available_pallets: round(formulaEvidence.availablePallets),
        representative_order_pallets: coverage.representativeOrderPallets,
        coverage_order_count: coverage.coverageOrderCount,
        coverage_floor_pallets: coverage.coverageFloorPallets,
        coverage_source: coverage.coverageSource,
        coverage_local_samples: coverage.coverageLocalSamples,
        coverage_donor_samples: coverage.coverageDonorSamples,
        zero_demand_coverage_applied: coverageApplied,
        coverage_capacity_shortfall: coverage.coverageCapacityShortfall,
        eligible_for_promotion: eligible,
        drivers: [
          { label: formulaEvidence.stockout ? `Stockout peak (${formulaEvidence.windowWeeks} completed weeks)` : `Recent average (${formulaEvidence.windowWeeks} completed weeks)`, value: round(formulaEvidence.demand) },
          { label: "Formula weekly standard deviation", value: round(formulaEvidence.standardDeviation) },
          { label: "Current available pallets", value: round(formulaEvidence.availablePallets) },
          { label: "Corrected recent-demand gate", value: round(recentFormulaEvidence.demand) },
          { label: `Representative order P${Math.round(number(settings.coverage_order_percentile, 0.5) * 100)}`, value: coverage.representativeOrderPallets },
          { label: "Zero-demand order coverage", value: coverage.coverageOrderCount },
          { label: "Zero-demand ROP floor", value: coverage.coverageFloorPallets },
          { label: "Coverage evidence", value: coverage.coverageSource },
          { label: "Coverage local / donor samples", value: `${coverage.coverageLocalSamples} / ${coverage.coverageDonorSamples}` },
          { label: "Coverage floor active", value: coverageApplied },
          { label: "Seasonal shadow forecast", value: round(forecasts.seasonal * multiplier) },
          { label: "Next-month seasonal factor", value: round(profile.factors[targetDate.getUTCMonth()], 4) },
          { label: "Seasonal evidence", value: profile.source },
          { label: "Intermittent-demand estimate", value: round(forecasts.croston_sba) },
          { label: "Product-family/yard median", value: round(groupMedian) },
          { label: "Expected demand multiplier", value: round(multiplier, 4) }
        ]
      });
      summary.forecasts += 1;
      summary[`${confidence}Confidence`] += 1;
      if (formulaEvidence.stockout) summary.stockoutBenchmarks += 1;
      if (coverageCandidate) summary.zeroDemandCoverageCandidates += 1;
      if (coverageApplied) summary.zeroDemandCoverageApplied += 1;
      if (coverageApplied && coverage.coverageLocalSamples < boundedInteger(settings.coverage_prior_strength_orders, 8, 1, 100)) summary.borrowedCoverageApplied += 1;
      if (eligible) summary.eligibleForPromotion += 1;
      if (authoritativeAi) summary.authoritativeAi += 1;
      if (formulaScore.wape !== null && selectedScore.wape !== null) {
        baselineWapeSum += formulaScore.wape;
        selectedWapeSum += selectedScore.wape;
        scored += 1;
      }
    }
    await insertForecastRows(rows);
    const metrics = {
      ...summary,
      scoredSeries: scored,
      averageBaselineWape: scored ? round(baselineWapeSum / scored) : null,
      completedThrough: completedThrough ? weekKey(completedThrough) : null,
      formulaAverageWeeks: formulaWeeks,
      stockoutBenchmarkWeeks: wholeWeeks(settings.stockout_benchmark_weeks, 6),
      zeroDemandCoverageEnabled: Boolean(settings.zero_demand_coverage_enabled),
      zeroDemandPickupOrderCount: boundedInteger(settings.zero_demand_pickup_order_count, 5, 1, 50),
      zeroDemandDeliveryOrderCount: boundedInteger(settings.zero_demand_delivery_order_count, 1, 1, 50),
      coverageOrderPercentile: number(settings.coverage_order_percentile, 0.5),
      coverageHistoryWeeks: boundedInteger(settings.coverage_history_weeks, 104, 26, 260),
      coveragePriorStrengthOrders: boundedInteger(settings.coverage_prior_strength_orders, 8, 1, 100),
      averageSelectedWape: scored ? round(selectedWapeSum / scored) : null
    };
    const completed = await query(
      `UPDATE scm_smart_forecast_runs
          SET status = 'completed', data_cutoff = $2, metrics = $3::jsonb, completed_at = now()
        WHERE id = $1
        RETURNING *`,
      [run.id, dataCutoff, JSON.stringify(metrics)]
    );
    await writeAudit({
      actorType: operatorId ? "operator" : "system",
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.forecast.completed",
      details: { runId: Number(run.id), triggerSource, dataCutoff, metrics }
    });
    return completed.rows[0];
  } catch (error) {
    await query(
      `UPDATE scm_smart_forecast_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
      [run.id, error.message]
    );
    await writeAudit({
      actorType: operatorId ? "operator" : "system",
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.forecast.failed",
      details: { runId: Number(run.id), triggerSource, error: error.message }
    });
    throw error;
  }
}

export async function listSmartScmForecastRuns({ limit = 20 } = {}) {
  const result = await query(
    `SELECT * FROM scm_smart_forecast_runs ORDER BY id DESC LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit) || 20))]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    status: row.status,
    triggerSource: row.trigger_source,
    modelVersion: row.model_version,
    dataCutoff: row.data_cutoff,
    metrics: row.metrics || {},
    error: row.error,
    createdBy: row.created_by,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }));
}

export async function listSmartScmForecasts({ runId = null, search = "", yard = "", limit = 500 } = {}) {
  const params = [];
  const clauses = [];
  if (runId) {
    params.push(Number(runId));
    clauses.push(`f.run_id = $${params.length}`);
  } else {
    clauses.push("f.run_id = (SELECT id FROM scm_smart_forecast_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1)");
  }
  if (yard) {
    params.push(String(yard));
    clauses.push(`f.yard_code = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`(p.item_name ILIKE $${params.length} OR p.series ILIKE $${params.length} OR p.vendor ILIKE $${params.length} OR p.item_id::text ILIKE $${params.length})`);
  }
  params.push(Math.min(5000, Math.max(1, Number(limit) || 500)));
  const result = await query(
    `SELECT f.*, p.item_name, p.series
       FROM scm_smart_forecasts f
       JOIN scm_smart_item_policies p ON p.item_id = f.item_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY f.eligible_for_promotion DESC, f.confidence DESC, p.item_name, f.yard_code
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map(publicForecast);
}

export async function latestSmartScmForecastRunId() {
  const result = await query("SELECT id FROM scm_smart_forecast_runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1");
  return result.rowCount ? Number(result.rows[0].id) : null;
}

export async function smartScmForecastMap(runId = null) {
  const id = runId || await latestSmartScmForecastRunId();
  if (!id) return new Map();
  const result = await query("SELECT * FROM scm_smart_forecasts WHERE run_id = $1", [id]);
  return new Map(result.rows.map((row) => [`${row.item_id}:${row.location_id}`, row]));
}
