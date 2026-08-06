// @ts-check

import { query } from "../db.js";
import { MbtError } from "./errors.js";
import { authorizeMbtPhase3Capability } from "./phase3-authorization.js";

/** @param {unknown} value */
function normalizedText(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value */
function normalizedLogin(value) {
  return normalizedText(value).toLowerCase();
}

/** @param {unknown} value */
function normalizedDate(value) {
  const text = normalizedText(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    throw new MbtError({
      status: 400,
      code: "MBT_DRIVER_PILOT_SCOPE_INVALID",
      message: "A valid Driver plan date is required."
    });
  }
  return text;
}

/**
 * Load the independently persisted pilot allowlist before any complete BIN job
 * is released to a Driver device. The capability callback is injectable only
 * for the isolated database contract; production always uses the real Phase 3
 * environment/database gate evaluator.
 *
 * @param {object} input
 * @param {unknown} input.driverLogin
 * @param {unknown} input.planDate
 * @param {typeof authorizeMbtPhase3Capability} [input.capabilityAuthorizer]
 */
export async function authorizeMbtDriverBinProjection({
  driverLogin,
  planDate,
  capabilityAuthorizer = authorizeMbtPhase3Capability
}) {
  const login = normalizedLogin(driverLogin);
  const date = normalizedDate(planDate);
  if (!login) {
    throw new MbtError({
      status: 400,
      code: "MBT_DRIVER_PILOT_SCOPE_INVALID",
      message: "A Driver login is required."
    });
  }
  const result = await query(
    `SELECT pilot_scope_id::text, plan_date::text, lower(driver_login) AS driver_login,
            truck_id::text, contract_id::text, service_visit_id::text,
            authorized_at, expires_at
       FROM mbt_driver_pilot_scope
      WHERE plan_date = $1::date
        AND lower(driver_login) = $2
        AND active = true
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY service_visit_id, pilot_scope_id`,
    [date, login]
  );
  const scopes = result.rows.map((/** @type {Record<string, any>} */ row) => ({
    pilotScopeId: String(row.pilot_scope_id),
    planDate: String(row.plan_date),
    driverLogin: String(row.driver_login),
    truckId: String(row.truck_id),
    contractId: String(row.contract_id),
    visitId: String(row.service_visit_id),
    authorizedAt: row.authorized_at,
    expiresAt: row.expires_at
  }));
  await capabilityAuthorizer({
    capability: "driverExecution",
    pilotAuthorized: scopes.length > 0
  });
  return Object.freeze({
    environmentEnabled: true,
    databaseEnabled: true,
    pilotAuthorized: true,
    driverLogin: login,
    planDate: date,
    scopes: Object.freeze(scopes.map(Object.freeze))
  });
}

/**
 * Pure exact-scope predicate shared by the HTTP boundary and contract tests.
 * A raw fast-first-paint job may not yet contain its contract snapshot, so its
 * globally unique visit plus exact driver/date/truck tuple is sufficient until
 * the complete job is materialized and checked again.
 *
 * @param {Array<Record<string, any>>} jobs
 * @param {Array<Record<string, any>>} scopes
 * @param {{driverLogin: unknown, planDate: unknown}} context
 */
export function mbtDriverPilotScopeCoversJobs(jobs, scopes, context) {
  const binJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.mbt?.visitId);
  if (!binJobs.length) {return true;}
  const login = normalizedLogin(context?.driverLogin);
  const planDate = normalizedText(context?.planDate).slice(0, 10);
  return binJobs.every((job) => {
    const contractId = normalizedText(job.mbt.contractId);
    const jobTruckId = normalizedText(job.truckId);
    const assignedTruckId = normalizedText(job.mbt.assignment?.truckId);
    return normalizedLogin(job.driverLogin) === login
      && normalizedText(job.planDate).slice(0, 10) === planDate
      && scopes.some((scope) =>
        normalizedLogin(scope.driverLogin) === login
        && normalizedText(scope.planDate).slice(0, 10) === planDate
        && (!jobTruckId || normalizedText(scope.truckId) === jobTruckId)
        && (!assignedTruckId || normalizedText(scope.truckId) === assignedTruckId)
        && normalizedText(scope.visitId || scope.serviceVisitId) === normalizedText(job.mbt.visitId)
        && (!contractId || normalizedText(scope.contractId) === contractId)
      );
  });
}

/**
 * Fail the whole response if even one assigned BIN stop falls outside the
 * exact authorized visit/contract/truck tuple. Partial route disclosure would
 * make later local-first predecessor identities unsafe.
 *
 * @param {Array<Record<string, any>>} jobs
 * @param {Record<string, any>} boundary
 */
export function assertMbtDriverBinProjectionScope(jobs, boundary) {
  const scopes = Array.isArray(boundary?.scopes) ? boundary.scopes : [];
  const covered = mbtDriverPilotScopeCoversJobs(jobs, scopes, {
    driverLogin: boundary?.driverLogin,
    planDate: boundary?.planDate
  });
  if (!covered) {
    throw new MbtError({
      status: 403,
      code: "MBT_DRIVER_PILOT_SCOPE_MISMATCH",
      message: "This BIN route is outside the authorized Driver pilot scope."
    });
  }
  return true;
}

export const loadMbtDriverBinProjectionBoundary = authorizeMbtDriverBinProjection;
export const assertMbtDriverBinProjectionAuthorized = assertMbtDriverBinProjectionScope;
