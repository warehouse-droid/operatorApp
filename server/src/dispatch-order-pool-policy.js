// @ts-check

import { query } from "./db.js";
import { getDispatchOrderCatalogState } from "./dispatch-order-catalog-repository.js";
import { normalizeDispatchPlannerMode } from "./dispatch-planner-optimization.js";

export const DISPATCH_OPTIMIZED_ORDER_POOL_FLAG_KEY = "dispatch_optimized_order_pool";
export const DISPATCH_ORDER_POOL_MIN_SHADOW_MATCHES = 3;

function unavailableCatalogState() {
  return {
    status: "unavailable",
    ready: false,
    generation: 0,
    source: "",
    catalogCount: 0,
    legacyCount: 0,
    assignmentsReady: false,
    shadowMatchCount: 0,
    shadowMismatchCount: 0,
    pendingRefreshCount: 0,
    lastShadowComparisonAt: null,
    lastFullRefreshAt: null,
    lastError: "",
    updatedAt: null
  };
}

/**
 * The deployment mode is a preparation ceiling; the database flag is the
 * Admin-owned cutover. Missing controls and readiness failures always retain
 * the legacy read path.
 *
 * @param {object} input
 * @param {unknown} [input.deploymentMode]
 * @param {{present?: boolean, enabled?: boolean, revision?: number | null, updatedAt?: unknown, available?: boolean}} [input.gate]
 * @param {Record<string, unknown>} [input.catalogState]
 */
export function evaluateDispatchOrderPoolPolicy({
  deploymentMode,
  gate = {},
  catalogState = unavailableCatalogState()
} = {}) {
  const normalizedDeploymentMode = normalizeDispatchPlannerMode(deploymentMode);
  const gateAvailable = gate.available !== false;
  const catalogAvailable = catalogState.status !== "unavailable";
  const present = gate.present === true;
  const configured = present && gate.enabled === true;
  const catalogReady = catalogState.ready === true;
  const assignmentsReady = catalogState.assignmentsReady === true;
  const generation = Number(catalogState.generation || 0);
  const catalogCount = Number(catalogState.catalogCount || 0);
  const legacyCount = Number(catalogState.legacyCount || 0);
  const catalogInitialized = generation > 0 && Boolean(catalogState.lastFullRefreshAt);
  const catalogPopulationSafe = catalogCount > 0 || legacyCount === 0;
  const pendingRefreshCount = Number(catalogState.pendingRefreshCount || 0);
  const shadowMatchCount = Number(catalogState.shadowMatchCount || 0);
  const shadowMismatchCount = Number(catalogState.shadowMismatchCount || 0);
  const catalogSettled = pendingRefreshCount === 0 && !catalogState.lastError;
  const shadowVerified = shadowMatchCount >= DISPATCH_ORDER_POOL_MIN_SHADOW_MATCHES
    && shadowMismatchCount === 0;
  const readModelReady = catalogAvailable
    && catalogReady
    && assignmentsReady
    && catalogInitialized
    && catalogPopulationSafe;
  const effective = normalizedDeploymentMode === "on"
    && gateAvailable
    && configured
    && readModelReady;
  const activationReady = normalizedDeploymentMode === "on"
    && readModelReady
    && catalogSettled
    && shadowVerified;

  let fallbackReason = "active";
  if (normalizedDeploymentMode === "off") fallbackReason = "deployment_off";
  else if (!catalogAvailable) fallbackReason = "catalog_unavailable";
  else if (!catalogReady) fallbackReason = "catalog_not_ready";
  else if (!assignmentsReady) fallbackReason = "assignments_not_ready";
  else if (!catalogInitialized) fallbackReason = "catalog_uninitialized";
  else if (!catalogPopulationSafe) fallbackReason = "catalog_population_mismatch";
  else if (normalizedDeploymentMode === "shadow") fallbackReason = "shadow_verification";
  else if (!gateAvailable) fallbackReason = "gate_unavailable";
  else if (!present) fallbackReason = "gate_missing";
  else if (!configured) fallbackReason = "gate_disabled";

  let activationBlockReason = "ready";
  if (normalizedDeploymentMode !== "on") activationBlockReason = "deployment_not_on";
  else if (!readModelReady) activationBlockReason = fallbackReason;
  else if (!catalogSettled) activationBlockReason = pendingRefreshCount > 0
    ? "refreshes_pending"
    : "catalog_error";
  else if (shadowMismatchCount > 0) activationBlockReason = "shadow_mismatch";
  else if (!shadowVerified) activationBlockReason = "shadow_samples_required";

  return {
    deploymentMode: normalizedDeploymentMode,
    runtimeMode: effective
      ? "on"
      : normalizedDeploymentMode === "off" ? "off" : "shadow",
    present,
    configured,
    gateAvailable,
    gateRevision: present ? Number(gate.revision) : null,
    gateUpdatedAt: present ? (gate.updatedAt ?? null) : null,
    catalogAvailable,
    catalogReady,
    assignmentsReady,
    catalogInitialized,
    catalogPopulationSafe,
    catalogSettled,
    shadowMatchCount,
    shadowMismatchCount,
    requiredShadowMatchCount: DISPATCH_ORDER_POOL_MIN_SHADOW_MATCHES,
    shadowVerified,
    activationReady,
    activationBlockReason,
    readModelReady,
    effective,
    fallbackReason,
    catalogState: {
      ...unavailableCatalogState(),
      ...catalogState
    }
  };
}

/**
 * Resolve the runtime policy without making Dispatch availability depend on
 * the feature-control tables. Any control/readiness error fails closed to the
 * legacy path.
 *
 * @param {object} [options]
 * @param {unknown} [options.deploymentMode]
 * @param {typeof query} [options.queryFn]
 * @param {typeof getDispatchOrderCatalogState} [options.getCatalogStateFn]
 */
export async function getDispatchOrderPoolPolicy({
  deploymentMode = "off",
  queryFn = query,
  getCatalogStateFn = getDispatchOrderCatalogState
} = {}) {
  const normalizedDeploymentMode = normalizeDispatchPlannerMode(deploymentMode);
  if (normalizedDeploymentMode === "off") {
    return evaluateDispatchOrderPoolPolicy({ deploymentMode: normalizedDeploymentMode });
  }

  const catalogPromise = Promise.resolve()
    .then(() => getCatalogStateFn())
    .catch(() => unavailableCatalogState());
  const gatePromise = normalizedDeploymentMode === "on"
    ? Promise.resolve().then(() => queryFn(
        `SELECT enabled, revision, updated_at
           FROM mbt_feature_flags
          WHERE flag_key = $1
          LIMIT 1`,
        [DISPATCH_OPTIMIZED_ORDER_POOL_FLAG_KEY]
      )).then((result) => {
        const row = result.rows?.[0];
        return row
          ? {
              present: true,
              enabled: row.enabled === true,
              revision: Number(row.revision),
              updatedAt: row.updated_at ?? null,
              available: true
            }
          : { present: false, enabled: false, revision: null, updatedAt: null, available: true };
      }).catch(() => ({
        present: false,
        enabled: false,
        revision: null,
        updatedAt: null,
        available: false
      }))
    : Promise.resolve({
        present: false,
        enabled: false,
        revision: null,
        updatedAt: null,
        available: true
      });
  const [catalogState, gate] = await Promise.all([catalogPromise, gatePromise]);
  return evaluateDispatchOrderPoolPolicy({
    deploymentMode: normalizedDeploymentMode,
    gate,
    catalogState
  });
}
