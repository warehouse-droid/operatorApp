import { query } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { listSmartScmForecastRuns, listSmartScmForecasts, runSmartScmForecast } from "./smart-scm-forecast-repository.js";
import { getSmartScmPlanningRun, listSmartScmBlanketPlanningPauses, listSmartScmPlanningRuns, listSmartScmProposals, runSmartScmPlan } from "./smart-scm-planning-repository.js";
import { listSmartScmPrintJobs, listYardPrinters } from "./smart-scm-print-repository.js";
import { getSmartScmSyncStatus } from "./smart-scm-item-repository.js";
import { listSmartScmActivePlanningExclusionItemIds, listSmartScmPlanningExclusions } from "./smart-scm-planning-exclusion-repository.js";
import { refreshSmartScmLiveData } from "./smart-scm-sync-service.js";
import { listSmartScmVendorWorkflowLoads } from "./smart-scm-vendor-workflow-repository.js";

let smartScmTickRunning = false;

function text(value) {
  return String(value ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function publicSettings(row) {
  return {
    executionMode: row.execution_mode,
    forecastMode: row.forecast_mode,
    dailyEnabled: Boolean(row.daily_enabled),
    dailyTime: row.daily_time,
    timeZone: row.time_zone,
    vendorResponseSlaHours: Number(row.vendor_response_sla_hours),
    truckCapacityLbs: number(row.truck_capacity_lbs),
    fullLoadRatio: number(row.full_load_ratio),
    holdLoadRatio: number(row.hold_load_ratio),
    formulaAverageWeeks: Number(row.formula_average_weeks || 6),
    stockoutBenchmarkWeeks: Number(row.stockout_benchmark_weeks || 6),
    deliverySafetyFactor: number(row.delivery_safety_factor, 1.645),
    pickupSafetyFactor: number(row.pickup_safety_factor, 1.3),
    zeroDemandCoverageEnabled: Boolean(row.zero_demand_coverage_enabled),
    zeroDemandPickupOrderCount: Number(row.zero_demand_pickup_order_count || 5),
    zeroDemandDeliveryOrderCount: Number(row.zero_demand_delivery_order_count || 1),
    coverageOrderPercentile: number(row.coverage_order_percentile, 0.5),
    coverageHistoryWeeks: Number(row.coverage_history_weeks || 104),
    coveragePriorStrengthOrders: Number(row.coverage_prior_strength_orders || 8),
    modelActiveSegments: row.model_active_segments || {},
    routeMatrix: row.route_matrix || {},
    lastDailyPlanDate: row.last_daily_plan_date,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
  };
}

export async function getSmartScmSettings() {
  const result = await query("SELECT * FROM scm_smart_settings WHERE id = 1");
  if (!result.rowCount) throw new Error("Smart SCM settings are missing. Run migrations first.");
  return publicSettings(result.rows[0]);
}

export async function updateSmartScmSettings(values = {}, operatorId = null) {
  const currentResult = await query("SELECT * FROM scm_smart_settings WHERE id = 1");
  if (!currentResult.rowCount) throw new Error("Smart SCM settings are missing. Run migrations first.");
  const current = currentResult.rows[0];
  const executionMode = values.executionMode ?? current.execution_mode;
  const forecastMode = values.forecastMode ?? current.forecast_mode;
  const dailyEnabled = values.dailyEnabled === undefined ? current.daily_enabled : Boolean(values.dailyEnabled);
  const dailyTime = text(values.dailyTime ?? current.daily_time);
  const timeZone = text(values.timeZone ?? current.time_zone);
  const vendorResponseSlaHours = Math.round(number(values.vendorResponseSlaHours, current.vendor_response_sla_hours));
  const truckCapacityLbs = number(values.truckCapacityLbs, current.truck_capacity_lbs);
  const fullLoadRatio = number(values.fullLoadRatio, current.full_load_ratio);
  const holdLoadRatio = number(values.holdLoadRatio, current.hold_load_ratio);
  const formulaAverageWeeks = Math.round(number(values.formulaAverageWeeks, current.formula_average_weeks || 6));
  const stockoutBenchmarkWeeks = Math.round(number(values.stockoutBenchmarkWeeks, current.stockout_benchmark_weeks || 6));
  const deliverySafetyFactor = number(values.deliverySafetyFactor, current.delivery_safety_factor || 1.645);
  const pickupSafetyFactor = number(values.pickupSafetyFactor, current.pickup_safety_factor || 1.3);
  const zeroDemandCoverageEnabled = values.zeroDemandCoverageEnabled === undefined
    ? current.zero_demand_coverage_enabled
    : Boolean(values.zeroDemandCoverageEnabled);
  const zeroDemandPickupOrderCount = Math.round(number(values.zeroDemandPickupOrderCount, current.zero_demand_pickup_order_count || 5));
  const zeroDemandDeliveryOrderCount = Math.round(number(values.zeroDemandDeliveryOrderCount, current.zero_demand_delivery_order_count || 1));
  const coverageOrderPercentile = number(values.coverageOrderPercentile, current.coverage_order_percentile || 0.5);
  const coverageHistoryWeeks = Math.round(number(values.coverageHistoryWeeks, current.coverage_history_weeks || 104));
  const coveragePriorStrengthOrders = Math.round(number(values.coveragePriorStrengthOrders, current.coverage_prior_strength_orders || 8));
  const modelActiveSegments = values.modelActiveSegments && typeof values.modelActiveSegments === "object"
    ? values.modelActiveSegments
    : current.model_active_segments;
  const routeMatrix = values.routeMatrix && typeof values.routeMatrix === "object" ? values.routeMatrix : current.route_matrix;
  if (!new Set(["mock", "live"]).has(executionMode)) throw Object.assign(new Error("Execution mode must be mock or live."), { status: 400 });
  if (!new Set(["formula", "shadow", "hybrid"]).has(forecastMode)) throw Object.assign(new Error("Forecast mode must be formula, shadow, or hybrid."), { status: 400 });
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(dailyTime)) throw Object.assign(new Error("Daily time must use HH:MM."), { status: 400 });
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    throw Object.assign(new Error("Select a valid IANA time zone."), { status: 400 });
  }
  if (vendorResponseSlaHours < 1 || vendorResponseSlaHours > 720) throw Object.assign(new Error("Vendor response SLA must be between 1 and 720 hours."), { status: 400 });
  if (truckCapacityLbs <= 0) throw Object.assign(new Error("Truck capacity must be greater than zero."), { status: 400 });
  if (!(holdLoadRatio > 0 && holdLoadRatio < fullLoadRatio && fullLoadRatio <= 1)) {
    throw Object.assign(new Error("Load ratios must satisfy 0 < hold < full <= 1."), { status: 400 });
  }
  if (formulaAverageWeeks < 2 || formulaAverageWeeks > 52) {
    throw Object.assign(new Error("Formula average period must be between 2 and 52 completed weeks."), { status: 400 });
  }
  if (stockoutBenchmarkWeeks < 2 || stockoutBenchmarkWeeks > 52) {
    throw Object.assign(new Error("Stockout benchmark period must be between 2 and 52 completed weeks."), { status: 400 });
  }
  if (!(deliverySafetyFactor > 0 && deliverySafetyFactor <= 5) || !(pickupSafetyFactor > 0 && pickupSafetyFactor <= 5)) {
    throw Object.assign(new Error("Safety factors must be greater than zero and no more than 5."), { status: 400 });
  }
  if (zeroDemandPickupOrderCount < 1 || zeroDemandPickupOrderCount > 50 || zeroDemandDeliveryOrderCount < 1 || zeroDemandDeliveryOrderCount > 50) {
    throw Object.assign(new Error("Zero-demand pickup and delivery order counts must be between 1 and 50."), { status: 400 });
  }
  if (coverageOrderPercentile < 0.25 || coverageOrderPercentile > 0.75) {
    throw Object.assign(new Error("Representative order percentile must be between 0.25 and 0.75."), { status: 400 });
  }
  if (coverageHistoryWeeks < 26 || coverageHistoryWeeks > 260) {
    throw Object.assign(new Error("Coverage history must be between 26 and 260 completed weeks."), { status: 400 });
  }
  if (coveragePriorStrengthOrders < 1 || coveragePriorStrengthOrders > 100) {
    throw Object.assign(new Error("Coverage prior strength must be between 1 and 100 orders."), { status: 400 });
  }
  const result = await query(
    `UPDATE scm_smart_settings
        SET execution_mode = $2,
            forecast_mode = $3,
            daily_enabled = $4,
            daily_time = $5,
            time_zone = $6,
            vendor_response_sla_hours = $7,
            truck_capacity_lbs = $8,
            full_load_ratio = $9,
            hold_load_ratio = $10,
            formula_average_weeks = $11,
            stockout_benchmark_weeks = $12,
            delivery_safety_factor = $13,
            pickup_safety_factor = $14,
            zero_demand_coverage_enabled = $15,
            zero_demand_pickup_order_count = $16,
            zero_demand_delivery_order_count = $17,
            coverage_order_percentile = $18,
            coverage_history_weeks = $19,
            coverage_prior_strength_orders = $20,
            model_active_segments = $21::jsonb,
            route_matrix = $22::jsonb,
            updated_by = $23,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [1, executionMode, forecastMode, dailyEnabled, dailyTime, timeZone, vendorResponseSlaHours, truckCapacityLbs, fullLoadRatio, holdLoadRatio, formulaAverageWeeks, stockoutBenchmarkWeeks, deliverySafetyFactor, pickupSafetyFactor, zeroDemandCoverageEnabled, zeroDemandPickupOrderCount, zeroDemandDeliveryOrderCount, coverageOrderPercentile, coverageHistoryWeeks, coveragePriorStrengthOrders, JSON.stringify(modelActiveSegments), JSON.stringify(routeMatrix), operatorId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.settings.update",
    details: { executionMode, forecastMode, dailyEnabled, dailyTime, timeZone, vendorResponseSlaHours, truckCapacityLbs, fullLoadRatio, holdLoadRatio, formulaAverageWeeks, stockoutBenchmarkWeeks, deliverySafetyFactor, pickupSafetyFactor, zeroDemandCoverageEnabled, zeroDemandPickupOrderCount, zeroDemandDeliveryOrderCount, coverageOrderPercentile, coverageHistoryWeeks, coveragePriorStrengthOrders, modelActiveSegments, routeMatrix }
  });
  return publicSettings(result.rows[0]);
}

export async function promoteSmartScmForecastSegment({ yardCode, series = "*", active = true }, operatorId = null) {
  const yard = text(yardCode);
  if (!new Set(["3445", "2967", "12441", "150", "*"]).has(yard)) throw Object.assign(new Error("Invalid forecast yard segment."), { status: 400 });
  const key = `${yard}:${text(series).toLowerCase() || "*"}`;
  const result = await query("SELECT model_active_segments FROM scm_smart_settings WHERE id = 1");
  const segments = { ...(result.rows[0]?.model_active_segments || {}) };
  if (active) segments[key] = true;
  else delete segments[key];
  const updated = await query(
    `UPDATE scm_smart_settings SET model_active_segments = $1::jsonb, updated_by = $2, updated_at = now() WHERE id = 1 RETURNING *`,
    [JSON.stringify(segments), operatorId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: active ? "smart_scm.forecast.segment_promote" : "smart_scm.forecast.segment_fallback",
    details: { key, active }
  });
  return publicSettings(updated.rows[0]);
}

export async function getSmartScmBootstrap({ proposalLimit = 200 } = {}) {
  const [settings, syncStatus, forecastRuns, planningRuns, printers, printJobs, vendorReplyLoads, planningExclusions] = await Promise.all([
    getSmartScmSettings(),
    getSmartScmSyncStatus(),
    listSmartScmForecastRuns({ limit: 10 }),
    listSmartScmPlanningRuns({ limit: 10 }),
    listYardPrinters(),
    listSmartScmPrintJobs({ limit: 50 }),
    listSmartScmVendorWorkflowLoads({ limit: 500 }),
    listSmartScmPlanningPauses({ limit: 500 })
  ]);
  const latestRun = planningRuns[0]?.id ? await getSmartScmPlanningRun(planningRuns[0].id) : null;
  const latestForecasts = forecastRuns[0]?.id
    ? await listSmartScmForecasts({ runId: forecastRuns[0].id, limit: 100 })
    : [];
  return {
    settings,
    syncStatus,
    forecastRuns,
    planningRuns,
    latestRun: latestRun ? { ...latestRun, proposals: latestRun.proposals.slice(0, proposalLimit) } : null,
    latestForecasts,
    printers,
    printJobs,
    vendorReplyLoads,
    planningExclusions
  };
}

export async function listSmartScmPlanningPauses(options = {}) {
  const [manual, blanketItems, manualActiveItemIds] = await Promise.all([
    listSmartScmPlanningExclusions(options),
    listSmartScmBlanketPlanningPauses({ search: options.search }),
    listSmartScmActivePlanningExclusionItemIds({ search: options.search })
  ]);
  const activeItemIds = new Set([
    ...manualActiveItemIds,
    ...blanketItems.map((item) => Number(item.itemId))
  ].filter(Number.isInteger));
  return {
    ...manual,
    blanketItems,
    blanketCount: blanketItems.length,
    combinedActiveCount: activeItemIds.size
  };
}

function localClock(timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export async function smartScmAutoTick() {
  if (smartScmTickRunning) return { skipped: "running" };
  smartScmTickRunning = true;
  let claimedDate = null;
  try {
    const settingsResult = await query("SELECT * FROM scm_smart_settings WHERE id = 1");
    const settings = settingsResult.rows[0];
    if (!settings?.daily_enabled) return { skipped: "disabled" };
    const clock = localClock(settings.time_zone || "America/Toronto");
    if (clock.time < settings.daily_time) return { skipped: "before_schedule", clock };
    const claimed = await query(
      `UPDATE scm_smart_settings
          SET last_daily_plan_date = $1::date
        WHERE id = 1
          AND daily_enabled = true
          AND last_daily_plan_date IS DISTINCT FROM $1::date
        RETURNING id`,
      [clock.date]
    );
    if (!claimed.rowCount) return { skipped: "already_ran", clock };
    claimedDate = clock.date;
    await refreshSmartScmLiveData({
      fullCatalog: true,
      includeSales: false,
      operatorId: null,
      triggerSource: "daily"
    });
    const forecast = await runSmartScmForecast({ triggerSource: "daily", operatorId: null });
    const plan = await runSmartScmPlan({ triggerSource: "daily", operatorId: null, forecastRunId: Number(forecast.id) });
    return { forecastRunId: Number(forecast.id), planningRunId: plan.id, clock };
  } catch (error) {
    if (claimedDate) {
      await query("UPDATE scm_smart_settings SET last_daily_plan_date = NULL WHERE id = 1 AND last_daily_plan_date = $1::date", [claimedDate]).catch(() => null);
    }
    await writeAudit({
      actorType: "system",
      source: "smart_scm",
      action: "smart_scm.daily.failed",
      details: { claimedDate, error: error.message }
    }).catch(() => null);
    throw error;
  } finally {
    smartScmTickRunning = false;
  }
}

export { listSmartScmForecasts, listSmartScmForecastRuns, runSmartScmForecast } from "./smart-scm-forecast-repository.js";
export { getSmartScmPlanningRun, listSmartScmPlanningRuns, listSmartScmProposals, runSmartScmPlan } from "./smart-scm-planning-repository.js";
