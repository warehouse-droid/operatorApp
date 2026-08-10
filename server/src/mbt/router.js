// @ts-check

import crypto from "node:crypto";
import express from "express";

import { config } from "../config.js";
import { netSuiteReadOnlyGetTransport } from "../netsuite.js";
import { MbtError, toErrorEnvelope } from "./errors.js";
import { authorizeMbtPhase3Capability } from "./phase3-authorization.js";
import {
  listMbtAdminFeatureFlags,
  updateMbtFeatureFlagDescription,
  updateMbtFeatureFlagState
} from "./feature-flag-repository.js";
import { materializeMbtAdminGates } from "./feature-gate-catalog.js";
import {
  listMbtLocalItemSettings,
  updateMbtLocalItemSetting
} from "./local-item-settings-repository.js";
import {
  getCurrentNetSuiteReadiness,
  getNetSuitePreflightRun,
  listNetSuiteMappings,
  putNetSuiteMapping,
  signoffNetSuitePreflightRun,
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun
} from "./netsuite-readiness-repository.js";
import {
  buildPreflightReport,
  serializePreflightCsv,
  serializePreflightJson
} from "./netsuite-readiness-report.js";
import { runNetSuiteSandboxPreflight } from "./netsuite-readiness-service.js";
import { createReadOnlyNetSuiteAdapter } from "./netsuite-readonly-adapter.js";
import { getMbtStatus, listMbtFeatureFlags } from "./status-repository.js";

/** @typedef {{id?: unknown, role?: unknown, roles?: unknown, homeRoute?: unknown}} MbtOperator */
/** @typedef {typeof import("./master-data-import-service.js").masterDataImportService} MasterDataImportService */
/** @typedef {typeof import("./local-master-data-service.js")} LocalMasterDataService */
/** @typedef {typeof import("./asset-registry-service.js")} AssetRegistryService */
/** @typedef {typeof import("./asset-csv-import-service.js").assetCsvImportService} AssetCsvImportService */
/** @typedef {typeof import("./customer-operations-service.js")} CustomerOperationsService */
/** @typedef {typeof import("./rate-card-configuration-service.js")} RateCardService */
/** @typedef {typeof import("./rate-card-csv-import-service.js").rateCardCsvImportService} RateCardImportService */
/** @typedef {typeof import("./frontdesk-service.js")} FrontdeskService */
/** @typedef {typeof import("./customer-charge-request-service.js")} CustomerChargeService */
/** @typedef {typeof import("./bin-dispatch-service.js")} BinDispatchService */
/** @typedef {typeof import("./shadow-billing-service.js")} ShadowBillingService */
/** @typedef {typeof import("./mbbs-billing-candidate-service.js")} MbbsBillingCandidateService */
/** @typedef {typeof import("./pilot-reconciliation-service.js")} PilotReconciliationService */
/** @typedef {{resolveDistance: Function, resolveTaxPolicy: Function}} FrontdeskPricing */

/**
 * @typedef {object} NetSuiteRuntime
 * @property {string} accountId
 * @property {string} [runtimeAccountId]
 * @property {string} [environmentName]
 * @property {string} restBaseUrl
 * @property {readonly string[]} sandboxAccountAllowlist
 * @property {boolean} directAccessEnabled
 * @property {number} [readTimeoutMs]
 * @property {number} [preflightLeaseSeconds]
 */

/**
 * @typedef {object} AdapterTransportResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {boolean} [redirected]
 * @property {string} [url]
 * @property {() => Promise<unknown>} json
 */

const readinessRepository = Object.freeze({
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun
});

/** @param {import("express").Request} req @returns {MbtOperator | undefined} */
function requestOperator(req) {
  return /** @type {import("express").Request & {operator?: MbtOperator}} */ (req).operator;
}

/** @param {MbtOperator | undefined} operator */
function normalizedRoles(operator) {
  return new Set([
    ...(Array.isArray(operator?.roles) ? operator.roles : []),
    operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

/** @param {import("express").Request} req */
function correlationId(req) {
  const request = /** @type {import("express").Request & {mbtCorrelationId?: string}} */ (req);
  if (request.mbtCorrelationId) {
    return request.mbtCorrelationId;
  }
  const supplied = String(req.get("x-correlation-id") || "").trim();
  request.mbtCorrelationId = supplied && supplied.length <= 160 ? supplied : crypto.randomUUID();
  return request.mbtCorrelationId;
}

/** @param {import("express").Request} req */
function requestId(req) {
  const supplied = String(req.get("x-request-id") || "").trim();
  return supplied && supplied.length <= 160 ? supplied : crypto.randomUUID();
}

/** @param {unknown} value @param {string} code @param {string} message */
function requiredRequestText(value, code, message) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new MbtError({ status: 400, code, message });
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function requiredRequestUuid(value, label) {
  const normalized = requiredRequestText(
    value,
    "MBT_BILLING_INPUT_INVALID",
    `${label} is required.`
  ).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new MbtError({
      status: 400,
      code: "MBT_BILLING_INPUT_INVALID",
      message: `${label} must be a UUID.`
    });
  }
  return normalized;
}

/** @param {import("express").Request} req */
function commandActor(req) {
  const operator = requestOperator(req);
  const operatorId = requiredRequestText(
    operator?.id,
    "MBT_OPERATOR_REQUIRED",
    "A live operator is required."
  );
  return {
    operatorId,
    roles: [...normalizedRoles(operator)]
  };
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
function requireMbtAdmin(req, res, next) {
  const operator = requestOperator(req);
  if (!normalizedRoles(operator).has("admin")) {
    noStore(res);
    return res.status(403).json({ error: "Admin account required", redirect: String(operator?.homeRoute || "/") });
  }
  return next();
}

/** @param {string} role @param {string} label @returns {import("express").RequestHandler} */
function requireMbtSurface(role, label) {
  return (req, res, next) => {
    const operator = requestOperator(req);
    const roles = normalizedRoles(operator);
    if (!roles.has("admin") && !roles.has(role)) {
      noStore(res);
      return res.status(403).json({
        error: `${label} account required`,
        redirect: String(operator?.homeRoute || "/")
      });
    }
    return next();
  };
}

/** @param {string} capability @returns {never} */
function rejectDisabledCapability(capability) {
  throw new MbtError({
    status: 409,
    code: "MBT_CAPABILITY_DISABLED",
    message: "This MBT capability is disabled.",
    details: { capability }
  });
}

/** @returns {NetSuiteRuntime} */
function configuredNetSuiteRuntime() {
  return {
    accountId: String(config.netsuite.accountId || ""),
    runtimeAccountId: String(config.netsuite.accountId || ""),
    environmentName: "sandbox",
    restBaseUrl: String(config.netsuite.restBaseUrl || ""),
    sandboxAccountAllowlist: Array.isArray(config.netsuite.mbtSandboxAccountAllowlist)
      ? [...config.netsuite.mbtSandboxAccountAllowlist]
      : [],
    directAccessEnabled: config.netsuite.directAccessEnabled === true,
    readTimeoutMs: Number(config.netsuite.mbtReadTimeoutMs || 10000),
    preflightLeaseSeconds: Number(config.netsuite.mbtPreflightLeaseSeconds || 120)
  };
}

/** @param {NetSuiteRuntime} runtime */
function adapterEnvironment(runtime) {
  const accountId = String(runtime.accountId || "");
  const configuredRoot = String(runtime.restBaseUrl || "").replace(/\/+$/, "");
  return {
    directAccessEnabled: runtime.directAccessEnabled === true,
    configuredAccountId: accountId,
    runtimeAccountId: String(runtime.runtimeAccountId || accountId),
    environmentName: String(runtime.environmentName || "sandbox").trim().toLowerCase(),
    sandboxAccountAllowlist: Array.isArray(runtime.sandboxAccountAllowlist)
      ? [...runtime.sandboxAccountAllowlist]
      : [],
    restBaseUrl: configuredRoot.endsWith("/record/v1")
      ? configuredRoot
      : `${configuredRoot}/record/v1`
  };
}

/** @param {NetSuiteRuntime} runtime */
function readinessRuntime(runtime) {
  const environment = adapterEnvironment(runtime);
  return {
    adapterKind: "read_only_sandbox",
    accountId: environment.configuredAccountId,
    runtimeAccountId: environment.runtimeAccountId,
    environmentName: environment.environmentName,
    restBaseUrl: environment.restBaseUrl,
    directAccessEnabled: environment.directAccessEnabled,
    sandboxAccountAllowlist: [...new Set(environment.sandboxAccountAllowlist
      .map((accountId) => String(accountId).trim())
      .filter(Boolean))].sort(),
    readTimeoutMs: Number(runtime.readTimeoutMs || 10000),
    preflightLeaseSeconds: safePreflightLeaseSeconds(runtime)
  };
}

/** @param {NetSuiteRuntime} runtime */
function safePreflightLeaseSeconds(runtime) {
  const readTimeoutSeconds = Math.ceil(Number(runtime.readTimeoutMs || 10000) / 1000);
  const minimumForFiveReadWaves = (readTimeoutSeconds * 6) + 15;
  return Math.min(900, Math.max(
    Number(runtime.preflightLeaseSeconds || 120),
    minimumForFiveReadWaves
  ));
}

/** @param {NetSuiteRuntime} runtime */
function publicRuntimeBinding(runtime) {
  const identity = readinessRuntime(runtime);
  return {
    accountId: identity.accountId,
    runtimeAccountId: identity.runtimeAccountId,
    environmentName: identity.environmentName,
    restBaseUrl: identity.restBaseUrl,
    directAccessEnabled: identity.directAccessEnabled,
    sandboxAccountAllowlist: identity.sandboxAccountAllowlist,
    readTimeoutMs: identity.readTimeoutMs,
    effectivePreflightLeaseSeconds: identity.preflightLeaseSeconds
  };
}

/** @param {unknown} value @returns {NetSuiteRuntime} */
function runtimeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A NetSuite runtime configuration is required.");
  }
  const runtime = /** @type {NetSuiteRuntime} */ (value);
  return {
    accountId: String(runtime.accountId || ""),
    runtimeAccountId: String(runtime.runtimeAccountId || runtime.accountId || ""),
    environmentName: String(runtime.environmentName || "sandbox"),
    restBaseUrl: String(runtime.restBaseUrl || ""),
    sandboxAccountAllowlist: Array.isArray(runtime.sandboxAccountAllowlist)
      ? [...runtime.sandboxAccountAllowlist]
      : [],
    directAccessEnabled: runtime.directAccessEnabled === true,
    readTimeoutMs: Number(runtime.readTimeoutMs || 10000),
    preflightLeaseSeconds: Number(runtime.preflightLeaseSeconds || 120)
  };
}

/** @param {unknown} value */
function transportStatus(value) {
  return value && typeof value === "object"
    ? Number(/** @type {{status?: unknown}} */ (value).status)
    : 0;
}

/**
 * @param {(request: {method: "GET", path: string, signal: AbortSignal, accept: string}) => Promise<unknown>} transport
 * @returns {(url: string, init: {method: "GET", redirect: "error", signal: AbortSignal, headers?: Readonly<Record<string, string>>}) => Promise<AdapterTransportResponse>}
 */
function adapterTransport(transport) {
  return async (url, init) => {
    const response = await transport({
      method: "GET",
      path: url,
      signal: init.signal,
      accept: String(init.headers?.Accept || "application/json")
    });
    if (response && typeof response === "object"
        && typeof /** @type {{json?: unknown}} */ (response).json === "function") {
      return /** @type {AdapterTransportResponse} */ (response);
    }
    const status = transportStatus(response);
    const candidate = response && typeof response === "object"
      ? /** @type {{body?: unknown, redirected?: unknown, url?: unknown}} */ (response)
      : {};
    return {
      ok: status >= 200 && status < 300,
      status,
      redirected: candidate.redirected === true,
      url: String(candidate.url || url),
      async json() {
        return candidate.body;
      }
    };
  };
}

/**
 * @param {(request: {method: "GET", path: string, signal: AbortSignal, accept: string}) => Promise<unknown>} transport
 * @param {NetSuiteRuntime} runtime
 */
function createSandboxAdapter(transport, runtime) {
  return createReadOnlyNetSuiteAdapter({
    environment: adapterEnvironment(runtime),
    transport: adapterTransport(transport),
    timeoutMs: Number(runtime.readTimeoutMs || 10000)
  });
}

/** @param {Record<string, unknown>} source @param {string[]} keys */
function firstText(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value) !== "") {
      return String(value);
    }
  }
  return "";
}

/** @param {unknown} value */
function publicSignoff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const signoff = /** @type {Record<string, unknown>} */ (value);
  const runId = firstText(signoff, ["preflightRunId", "runId"]);
  const actor = firstText(signoff, ["signedBy", "actor"]);
  const note = firstText(signoff, ["auditNote", "note"]);
  return {
    signoffId: firstText(signoff, ["signoffId"]),
    runId,
    preflightRunId: runId,
    configurationHash: firstText(signoff, ["configurationHash"]),
    signedBy: actor,
    actor,
    auditNote: note,
    note,
    signedAt: firstText(signoff, ["signedAt"]),
    current: signoff.current === true,
    status: "signed"
  };
}

/** @param {Record<string, unknown>} check */
function publicCheck(check) {
  return {
    sequenceNumber: Number(check.sequenceNumber),
    checkCode: String(check.checkCode || ""),
    mappingType: String(check.mappingType || ""),
    localKey: String(check.localKey || ""),
    required: check.required === true,
    severity: String(check.severity || ""),
    status: String(check.status || ""),
    expected: check.expected ?? {},
    observed: check.observed ?? null,
    message: String(check.message || "")
  };
}

/** @param {{run: Record<string, unknown>, checks: Record<string, unknown>[], signoff: unknown, current: boolean}} detail */
function publicRun(detail) {
  const run = detail.run;
  const current = detail.current === true;
  const status = String(run.status || "");
  return {
    runId: String(run.preflightRunId || ""),
    accountId: String(run.accountId || ""),
    environmentName: String(run.environmentName || ""),
    configurationHash: String(run.configurationHash || ""),
    status,
    generatedAt: String(run.completedAt || run.startedAt || ""),
    ready: status === "passed" && current,
    current,
    counts: run.counts || {},
    checks: Array.isArray(detail.checks) ? detail.checks.map(publicCheck) : [],
    signoff: publicSignoff(detail.signoff)
  };
}

/** @param {string} runId @param {NetSuiteRuntime} runtime */
async function getPublicRun(runId, runtime) {
  return publicRun(await getNetSuitePreflightRun(runId, readinessRuntime(runtime)));
}

/** @param {NetSuiteRuntime} runtime */
async function getLatestPublicRun(runtime) {
  const latest = await getCurrentNetSuiteReadiness(readinessRuntime(runtime));
  if (!latest.run) {
    return null;
  }
  return getPublicRun(String(latest.run.preflightRunId), runtime);
}

/** @param {import("express").Response} res */
function noStore(res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
}

/** @param {unknown} value */
function localItemUpdateBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MbtError({
      status: 400,
      code: "MBT_LOCAL_ITEM_INPUT_INVALID",
      message: "A local item settings object is required."
    });
  }
  const body = /** @type {Record<string, unknown>} */ (value);
  const accepted = new Set([
    "displayName",
    "description",
    "active",
    "chargeBasis",
    "expectedRevision",
    "reason"
  ]);
  if (Object.keys(body).some((key) => !accepted.has(key))) {
    throw new MbtError({
      status: 400,
      code: "MBT_LOCAL_ITEM_INPUT_INVALID",
      message: "Local item settings may update only approved local fields."
    });
  }
  return body;
}

/** @param {unknown} value */
function importResource(value) {
  const resource = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!["customers", "local_items", "materials", "dump_sites"].includes(resource)) {
    throw new MbtError({
      status: 400,
      code: "MBT_IMPORT_RESOURCE_INVALID",
      message: "This import resource is not supported."
    });
  }
  return resource;
}

const LOCAL_IMPORT_CAPABILITY = "masterData";

/** @param {import("express").Request} req */
function customerImportDefaults(req) {
  return {
    sourceAccountId: requiredRequestText(
      req.get("x-mbt-source-account-id"),
      "MBT_IMPORT_SOURCE_ACCOUNT_REQUIRED",
      "A customer source account is required."
    ),
    approvedSubsidiary: requiredRequestText(
      req.get("x-mbt-approved-subsidiary"),
      "MBT_IMPORT_SUBSIDIARY_REQUIRED",
      "An approved customer subsidiary is required."
    ),
    defaultCurrency: requiredRequestText(
      req.get("x-mbt-default-currency"),
      "MBT_IMPORT_CURRENCY_REQUIRED",
      "A default customer currency is required."
    ),
    exportedAt: requiredRequestText(
      req.get("x-mbt-exported-at"),
      "MBT_IMPORT_EXPORTED_AT_REQUIRED",
      "A customer export timestamp is required."
    )
  };
}

/** @param {import("express").Request} req */
function customerImportSourceKind(req) {
  return String(req.get("content-type") || "").toLowerCase().includes("application/vnd.ms-excel")
    ? "netsuite_spreadsheetml"
    : "customer_csv";
}

/** @param {import("express").Request} req @param {string} resource */
function importDefaults(req, resource) {
  return resource === "customers"
    ? customerImportDefaults(req)
    : { sourceAccountId: "local" };
}

/** @param {import("express").Request} req @param {string} resource */
function importSourceKind(req, resource) {
  return resource === "customers" ? customerImportSourceKind(req) : "csv";
}

/** @param {unknown} value */
function requestObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MbtError({
      status: 400,
      code: "MBT_REQUEST_BODY_INVALID",
      message: "A request object is required."
    });
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} error
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} _next
 */
function mbtErrorHandler(error, req, res, _next) {
  const envelope = toErrorEnvelope(error, { correlationId: correlationId(req) });
  noStore(res);
  res.status(envelope.status).json(envelope.body);
}

/**
 * @param {object} [dependencies]
 * @param {(request: {method: "GET", path: string, signal: AbortSignal, accept: string}) => Promise<unknown>} [dependencies.netSuiteTransport]
 * @param {NetSuiteRuntime} [dependencies.netSuiteRuntime]
 * @param {() => NetSuiteRuntime} [dependencies.netSuiteRuntimeProvider]
 * @param {MasterDataImportService} [dependencies.importService]
 * @param {LocalMasterDataService} [dependencies.localMasterDataService]
 * @param {AssetRegistryService} [dependencies.assetRegistryService]
 * @param {AssetCsvImportService} [dependencies.assetCsvImportService]
 * @param {CustomerOperationsService} [dependencies.customerOperationsService]
 * @param {RateCardService} [dependencies.rateCardService]
 * @param {RateCardImportService} [dependencies.rateCardImportService]
 * @param {FrontdeskService} [dependencies.frontdeskService]
 * @param {CustomerChargeService} [dependencies.customerChargeService]
 * @param {BinDispatchService} [dependencies.binDispatchService]
 * @param {ShadowBillingService} [dependencies.billingService]
 * @param {MbbsBillingCandidateService} [dependencies.billingCandidateService]
 * @param {PilotReconciliationService} [dependencies.reconciliationService]
 * @param {FrontdeskPricing} [dependencies.frontdeskPricing]
 * @param {typeof authorizeMbtPhase3Capability} [dependencies.authorizePhase3Capability]
 */
export function createMbtRouter(dependencies = {}) {
  const netSuiteTransport = dependencies.netSuiteTransport || netSuiteReadOnlyGetTransport;
  const netSuiteRuntimeProvider = typeof dependencies.netSuiteRuntimeProvider === "function"
    ? dependencies.netSuiteRuntimeProvider
    : dependencies.netSuiteRuntime === undefined
      ? configuredNetSuiteRuntime
      : () => /** @type {NetSuiteRuntime} */ (dependencies.netSuiteRuntime);
  const requestRuntime = () => runtimeSnapshot(netSuiteRuntimeProvider());
  const injectedImportService = dependencies.importService;
  const resolveImportService = async () => injectedImportService
    || (await import("./master-data-import-service.js")).masterDataImportService;
  const injectedLocalMasterDataService = dependencies.localMasterDataService;
  const resolveLocalMasterDataService = async () => injectedLocalMasterDataService
    || import("./local-master-data-service.js");
  const injectedAssetRegistryService = dependencies.assetRegistryService;
  const resolveAssetRegistryService = async () => injectedAssetRegistryService
    || import("./asset-registry-service.js");
  const injectedAssetCsvImportService = dependencies.assetCsvImportService;
  const resolveAssetCsvImportService = async () => injectedAssetCsvImportService
    || (await import("./asset-csv-import-service.js")).assetCsvImportService;
  const injectedCustomerOperationsService = dependencies.customerOperationsService;
  const resolveCustomerOperationsService = async () => injectedCustomerOperationsService
    || import("./customer-operations-service.js");
  const injectedRateCardService = dependencies.rateCardService;
  const resolveRateCardService = async () => injectedRateCardService
    || import("./rate-card-configuration-service.js");
  const injectedRateCardImportService = dependencies.rateCardImportService;
  const resolveRateCardImportService = async () => injectedRateCardImportService
    || (await import("./rate-card-csv-import-service.js")).rateCardCsvImportService;
  const injectedFrontdeskService = dependencies.frontdeskService;
  const resolveFrontdeskService = async () => injectedFrontdeskService
    || import("./frontdesk-service.js");
  const injectedCustomerChargeService = dependencies.customerChargeService;
  const resolveCustomerChargeService = async () => injectedCustomerChargeService
    || import("./customer-charge-request-service.js");
  const injectedBinDispatchService = dependencies.binDispatchService;
  const resolveBinDispatchService = async () => injectedBinDispatchService
    || import("./bin-dispatch-service.js");
  const injectedBillingService = dependencies.billingService;
  const resolveBillingService = async () => injectedBillingService
    || import("./shadow-billing-service.js");
  const injectedBillingCandidateService = dependencies.billingCandidateService;
  const resolveBillingCandidateService = async () => injectedBillingCandidateService
    || import("./mbbs-billing-candidate-service.js");
  const injectedReconciliationService = dependencies.reconciliationService;
  const resolveReconciliationService = async () => injectedReconciliationService
    || import("./pilot-reconciliation-service.js");
  const unavailableFrontdeskPricing = async () => {
    throw new MbtError({
      status: 503,
      code: "MBT_FRONTDESK_PRICING_UNAVAILABLE",
      message: "The server-owned Front Desk distance and tax adapters are not configured."
    });
  };
  const frontdeskPricing = dependencies.frontdeskPricing || {
    resolveDistance: unavailableFrontdeskPricing,
    resolveTaxPolicy: unavailableFrontdeskPricing
  };
  const authorizePhase3Capability = dependencies.authorizePhase3Capability
    || authorizeMbtPhase3Capability;
  const router = express.Router();

  async function adminGateInventory() {
    return {
      schemaVersion: "mbt-admin-gates-v1",
      safetyProfile: "local_non_posting",
      environmentRootAllowed: config.mbt.enabled === true,
      gates: materializeMbtAdminGates({
        flags: await listMbtAdminFeatureFlags(),
        environment: {
          enabled: config.mbt.enabled,
          ...config.mbtPhase3,
          netSuiteWritesEnabled: config.mbt.netSuiteWritesEnabled
        }
      })
    };
  }

  /** @type {import("express").RequestHandler} */
  const boundedImportBody = express.raw({
    type: ["application/vnd.ms-excel", "text/csv", "application/csv"],
    limit: 20 * 1024 * 1024
  });

  /** @type {import("express").RequestHandler} */
  const authorizeAssetImport = async (_req, _res, next) => {
    try {
      await authorizePhase3Capability({ capability: "assetManagement" });
      next();
    } catch (error) {
      next(error);
    }
  };

  router.get("/status", async (req, res, next) => {
    try {
      const status = await getMbtStatus({
        environmentEnabled: config.mbt.enabled,
        netSuiteWritesEnabled: config.mbt.netSuiteWritesEnabled
      });
      const capabilities = { ...status.capabilities };
      const roles = normalizedRoles(requestOperator(req));
      const pilotAuthorized = roles.has("admin") || roles.has("dispatcher");
      if (!capabilities.binDispatch) {
        capabilities.binDispatch = {
          enabled: false,
          code: "MBT_CAPABILITY_DISABLED",
          reason: "capability_unavailable"
        };
      } else if (capabilities.binDispatch.enabled === true) {
        try {
          capabilities.binDispatch = await authorizePhase3Capability({
            capability: "binDispatch",
            pilotAuthorized
          });
        } catch (error) {
          if (!(error instanceof MbtError) || error?.code !== "MBT_CAPABILITY_DISABLED") {
            throw error;
          }
          capabilities.binDispatch = {
            enabled: false,
            code: error.code,
            reason: String(error.details.reason || "capability_disabled")
          };
        }
      }
      res.setHeader("cache-control", "no-store");
      res.json({
        ...status,
        operational: Object.values(capabilities).some((capability) => capability.enabled),
        capabilities
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/config", requireMbtAdmin, async (_req, res, next) => {
    try {
      res.setHeader("cache-control", "no-store");
      res.json({
        schemaVersion: "mbt-v1",
        phase: 1,
        flags: await listMbtFeatureFlags()
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/gates", requireMbtAdmin, async (_req, res, next) => {
    try {
      noStore(res);
      res.json(await adminGateInventory());
    } catch (error) {
      next(error);
    }
  });

  router.put("/config/gates/:flagKey", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const result = await updateMbtFeatureFlagState({
        actor: commandActor(req),
        flagKey: requiredRequestText(
          req.params.flagKey,
          "MBT_FEATURE_FLAG_REQUIRED",
          "A feature flag key is required."
        ),
        enabled: /** @type {boolean} */ (body.enabled),
        expectedRevision: /** @type {number} */ (body.expectedRevision),
        reason: requiredRequestText(
          body.reason,
          "MBT_AUDIT_REASON_REQUIRED",
          "An audit reason is required."
        ),
        idempotencyKey: requiredRequestText(
          req.get("idempotency-key"),
          "MBT_IDEMPOTENCY_KEY_REQUIRED",
          "An Idempotency-Key header is required."
        ),
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/local/items", requireMbtAdmin, async (_req, res, next) => {
    try {
      noStore(res);
      res.json({
        schemaVersion: "mbt-local-items-v1",
        items: await listMbtLocalItemSettings()
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/config/local/items/:itemCode", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = localItemUpdateBody(req.body);
      const result = await updateMbtLocalItemSetting({
        actor: commandActor(req),
        itemCode: requiredRequestText(
          req.params.itemCode,
          "MBT_LOCAL_ITEM_REQUIRED",
          "A local item code is required."
        ),
        setting: {
          displayName: body.displayName,
          description: body.description,
          active: body.active,
          ...(body.chargeBasis === undefined ? {} : { chargeBasis: body.chargeBasis })
        },
        expectedRevision: /** @type {number} */ (body.expectedRevision),
        reason: requiredRequestText(
          body.reason,
          "MBT_AUDIT_REASON_REQUIRED",
          "A local item audit reason is required."
        ),
        idempotencyKey: requiredRequestText(
          req.get("idempotency-key"),
          "MBT_IDEMPOTENCY_KEY_REQUIRED",
          "An Idempotency-Key header is required."
        ),
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  /** @param {"local_items" | "materials" | "dump_sites" | "service_templates"} resource */
  function localMasterCreateHandler(resource) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "masterData" });
        const body = requestObject(req.body);
        const reason = String(body.reason || "").trim();
        const row = Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== "reason")
        );
        const service = await resolveLocalMasterDataService();
        const result = await service.applyLocalMasterDataRows({
          actor: commandActor(req),
          resource,
          sourceKind: "manual",
          rows: [row],
          reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.post(
    "/config/local/items",
    requireMbtAdmin,
    localMasterCreateHandler("local_items")
  );

  router.post(
    "/config/materials",
    requireMbtAdmin,
    localMasterCreateHandler("materials")
  );

  router.post(
    "/config/dump-sites",
    requireMbtAdmin,
    localMasterCreateHandler("dump_sites")
  );

  router.post(
    "/config/service-templates",
    requireMbtAdmin,
    localMasterCreateHandler("service_templates")
  );

  /** @param {"materials" | "dump_sites" | "service_templates"} resource */
  function localMasterListHandler(resource) {
    /** @type {import("express").RequestHandler} */
    return async (_req, res, next) => {
      try {
        const service = await resolveLocalMasterDataService();
        const result = await service.listLocalMasterData(resource);
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    };
  }

  router.get("/config/materials", requireMbtAdmin, localMasterListHandler("materials"));
  router.get("/config/dump-sites", requireMbtAdmin, localMasterListHandler("dump_sites"));
  router.get(
    "/config/service-templates",
    requireMbtAdmin,
    localMasterListHandler("service_templates")
  );

  /** @param {"local_items" | "dump_sites"} resource @param {"state" | "delete"} action */
  function localMasterDirectHandler(resource, action) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        const body = requestObject(req.body);
        const service = await resolveLocalMasterDataService();
        const common = {
          actor: commandActor(req),
          resource,
          entityId: resource === "local_items" ? req.params.itemCode : req.params.dumpSiteCode,
          expectedRevision: Number(body.expectedRevision),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        };
        const result = action === "state"
          ? await service.setLocalMasterDataActive({ ...common, active: body.active })
          : await service.deleteLocalMasterDataEntity(common);
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.patch(
    "/config/local/items/:itemCode/state",
    requireMbtAdmin,
    localMasterDirectHandler("local_items", "state")
  );
  router.delete(
    "/config/local/items/:itemCode",
    requireMbtAdmin,
    localMasterDirectHandler("local_items", "delete")
  );
  router.patch(
    "/config/dump-sites/:dumpSiteCode/state",
    requireMbtAdmin,
    localMasterDirectHandler("dump_sites", "state")
  );
  router.delete(
    "/config/dump-sites/:dumpSiteCode",
    requireMbtAdmin,
    localMasterDirectHandler("dump_sites", "delete")
  );

  router.get("/config/customer-charges/:versionId", requireMbtAdmin, async (req, res, next) => {
    try {
      const service = await resolveCustomerChargeService();
      const result = await service.getFrontdeskCustomerChargeAdminConfiguration({
        actor: commandActor(req),
        rateCardVersionId: requiredRequestText(
          req.params.versionId,
          "MBT_RATE_CARD_VERSION_REQUIRED",
          "A rate-card version ID is required."
        )
      });
      noStore(res);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.put("/config/customer-charges/:versionId", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const idempotencyKey = requiredRequestText(
        req.get("idempotency-key"),
        "MBT_IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header is required."
      );
      await authorizePhase3Capability({ capability: "masterData" });
      const service = await resolveCustomerChargeService();
      const result = await service.replaceFrontdeskCustomerChargeConfiguration({
        actor: commandActor(req),
        rateCardVersionId: requiredRequestText(
          req.params.versionId,
          "MBT_RATE_CARD_VERSION_REQUIRED",
          "A rate-card version ID is required."
        ),
        expectedRevision: Number(body.expectedRevision),
        aggregateItems: body.aggregateItems,
        fixedDumpItems: body.fixedDumpItems,
        aggregateDistanceBands: body.aggregateDistanceBands,
        reason: body.reason,
        idempotencyKey,
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/rate-cards", requireMbtAdmin, async (req, res, next) => {
    try {
      const service = await resolveRateCardService();
      const result = await service.listLocalRateCards({
        query: String(req.query.query || ""),
        status: String(req.query.status || ""),
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        cursor: req.query.cursor === undefined ? null : String(req.query.cursor)
      });
      noStore(res);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/rate-cards/:versionId", requireMbtAdmin, async (req, res, next) => {
    try {
      const service = await resolveRateCardService();
      const result = await service.getLocalRateCardGraph(requiredRequestText(
        req.params.versionId,
        "MBT_RATE_CARD_VERSION_REQUIRED",
        "A rate-card version ID is required."
      ));
      noStore(res);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /** @param {"state" | "delete"} action */
  function rateCardDirectHandler(action) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        const body = requestObject(req.body);
        const service = await resolveRateCardService();
        const common = {
          actor: commandActor(req),
          rateCardVersionId: requiredRequestText(
            req.params.versionId,
            "MBT_RATE_CARD_VERSION_REQUIRED",
            "A rate-card version ID is required."
          ),
          expectedRevision: Number(body.expectedRevision),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        };
        const result = action === "state"
          ? await service.setLocalRateCardActive({ ...common, active: body.active })
          : await service.deleteLocalRateCard(common);
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.patch(
    "/config/rate-cards/:versionId/state",
    requireMbtAdmin,
    rateCardDirectHandler("state")
  );
  router.delete(
    "/config/rate-cards/:versionId",
    requireMbtAdmin,
    rateCardDirectHandler("delete")
  );

  router.put("/config/rate-cards/:versionId", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const idempotencyKey = requiredRequestText(
        req.get("idempotency-key"),
        "MBT_IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header is required."
      );
      await authorizePhase3Capability({ capability: "masterData" });
      const service = await resolveRateCardService();
      const result = await service.replaceLocalRateCardDraft({
        actor: commandActor(req),
        rateCardVersionId: requiredRequestText(
          req.params.versionId,
          "MBT_RATE_CARD_VERSION_REQUIRED",
          "A rate-card version ID is required."
        ),
        expectedRevision: Number(body.expectedRevision),
        sourceKind: "manual",
        graph: body.graph,
        reason: String(body.reason || ""),
        idempotencyKey,
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/config/rate-cards", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const idempotencyKey = requiredRequestText(
        req.get("idempotency-key"),
        "MBT_IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header is required."
      );
      await authorizePhase3Capability({ capability: "masterData" });
      const service = await resolveRateCardService();
      const result = await service.applyLocalRateCardDraft({
        actor: commandActor(req),
        sourceKind: String(body.sourceKind || ""),
        graph: body.graph,
        reason: String(body.reason || ""),
        idempotencyKey,
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  /** @param {"validate" | "activate"} action */
  function rateCardLifecycleHandler(action) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        const body = requestObject(req.body);
        const idempotencyKey = requiredRequestText(
          req.get("idempotency-key"),
          "MBT_IDEMPOTENCY_KEY_REQUIRED",
          "An Idempotency-Key header is required."
        );
        await authorizePhase3Capability({ capability: "masterData" });
        const service = await resolveRateCardService();
        const operation = action === "validate"
          ? service.validateLocalRateCardVersion
          : service.activateLocalRateCardVersion;
        const result = await operation({
          actor: commandActor(req),
          rateCardVersionId: requiredRequestText(
            req.params.versionId,
            "MBT_RATE_CARD_VERSION_REQUIRED",
            "A rate-card version ID is required."
          ),
          expectedRevision: Number(body.expectedRevision),
          reason: String(body.reason || ""),
          idempotencyKey,
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.post(
    "/config/rate-cards/:versionId/validate",
    requireMbtAdmin,
    rateCardLifecycleHandler("validate")
  );
  router.post(
    "/config/rate-cards/:versionId/activate",
    requireMbtAdmin,
    rateCardLifecycleHandler("activate")
  );

  router.post("/config/rate-cards/:versionId/clone", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const idempotencyKey = requiredRequestText(
        req.get("idempotency-key"),
        "MBT_IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header is required."
      );
      await authorizePhase3Capability({ capability: "masterData" });
      const service = await resolveRateCardService();
      const result = await service.cloneLocalRateCardVersion({
        actor: commandActor(req),
        sourceRateCardVersionId: requiredRequestText(
          req.params.versionId,
          "MBT_RATE_CARD_VERSION_REQUIRED",
          "A rate-card version ID is required."
        ),
        expectedRevision: Number(body.expectedRevision),
        reason: String(body.reason || ""),
        idempotencyKey,
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.post("/config/rate-card-imports/preview", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      await authorizePhase3Capability({ capability: "masterData" });
      const service = await resolveRateCardImportService();
      const result = await service.previewRateCardCsvImport({
        actor: commandActor(req),
        files: body.files,
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/config/rate-card-imports/apply", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const idempotencyKey = requiredRequestText(
        req.get("idempotency-key"),
        "MBT_IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header is required."
      );
      await authorizePhase3Capability({ capability: "masterData" });
      const service = await resolveRateCardImportService();
      const result = await service.applyRateCardCsvImport({
        actor: commandActor(req),
        batchId: String(body.batchId || ""),
        normalizedHash: String(body.normalizedHash || ""),
        targetRevisionToken: String(body.targetRevisionToken || ""),
        reason: String(body.reason || ""),
        idempotencyKey,
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/config/imports/:resource/template",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const resource = importResource(req.params.resource);
        await authorizePhase3Capability({ capability: LOCAL_IMPORT_CAPABILITY });
        const importService = await resolveImportService();
        const result = await importService.getTemplate({ resource });
        noStore(res);
        res.setHeader("content-type", result.contentType);
        res.setHeader("content-disposition", `attachment; filename="${result.filename}"`);
        res.setHeader("x-content-type-options", "nosniff");
        res.status(result.status).send(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/config/imports/:resource/preview",
    requireMbtAdmin,
    async (req, _res, next) => {
      try {
        importResource(req.params.resource);
        await authorizePhase3Capability({ capability: LOCAL_IMPORT_CAPABILITY });
        next();
      } catch (error) {
        next(error);
      }
    },
    boundedImportBody,
    async (req, res, next) => {
      try {
        const resource = importResource(req.params.resource);
        const importService = await resolveImportService();
        const result = await importService.previewMasterDataImport({
          actor: commandActor(req),
          resource,
          sourceKind: importSourceKind(req, resource),
          fileName: requiredRequestText(
            req.get("x-mbt-source-filename"),
            "MBT_IMPORT_FILENAME_REQUIRED",
            "An import filename is required."
          ),
          content: req.body,
          defaults: importDefaults(req, resource),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/config/imports/:resource/:batchId/apply",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const resource = importResource(req.params.resource);
        await authorizePhase3Capability({ capability: LOCAL_IMPORT_CAPABILITY });
        const body = requestObject(req.body);
        const importService = await resolveImportService();
        const result = await importService.applyMasterDataImport({
          actor: commandActor(req),
          resource,
          batchId: requiredRequestText(
            req.params.batchId,
            "MBT_IMPORT_BATCH_REQUIRED",
            "An import batch ID is required."
          ),
          normalizedHash: /** @type {string} */ (body.normalizedHash),
          targetRevisionToken: /** @type {string} */ (body.targetRevisionToken),
          reason: /** @type {string} */ (body.reason),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/config/imports/:resource/:batchId",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const resource = importResource(req.params.resource);
        await authorizePhase3Capability({ capability: LOCAL_IMPORT_CAPABILITY });
        const importService = await resolveImportService();
        const result = await importService.getMasterDataImportBatch({
          actor: commandActor(req),
          resource,
          batchId: requiredRequestText(
            req.params.batchId,
            "MBT_IMPORT_BATCH_REQUIRED",
            "An import batch ID is required."
          )
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/assets/import/template",
    requireMbtAdmin,
    authorizeAssetImport,
    async (_req, res, next) => {
      try {
        const service = await resolveAssetCsvImportService();
        const template = service.getMbtBinAssetCsvTemplate();
        noStore(res);
        res.setHeader("content-type", "text/csv; charset=utf-8");
        res.setHeader(
          "content-disposition",
          `attachment; filename="${String(template.fileName)}"`
        );
        res.status(200).send(template.content);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/assets/import/preview",
    requireMbtAdmin,
    authorizeAssetImport,
    boundedImportBody,
    async (req, res, next) => {
      try {
        const service = await resolveAssetCsvImportService();
        const result = await service.previewMbtBinAssetCsvImport({
          actor: commandActor(req),
          content: req.body,
          fileName: String(req.get("x-mbt-source-filename") || ""),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/assets/import/:batchId/apply",
    requireMbtAdmin,
    authorizeAssetImport,
    async (req, res, next) => {
      try {
        const body = requestObject(req.body);
        const service = await resolveAssetCsvImportService();
        const result = await service.applyMbtBinAssetCsvImport({
          actor: commandActor(req),
          batchId: requiredRequestText(
            req.params.batchId,
            "MBT_IMPORT_BATCH_REQUIRED",
            "An asset preview batch ID is required."
          ),
          normalizedHash: String(body.normalizedHash || ""),
          targetRevisionToken: String(body.targetRevisionToken || ""),
          reason: String(body.reason || "").trim(),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/assets",
    requireMbtSurface("dispatcher", "MBT asset registry"),
    async (req, res, next) => {
      try {
        const assetRegistryService = await resolveAssetRegistryService();
        const result = await assetRegistryService.listMbtBinAssets({
          query: String(req.query.query || ""),
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
          cursor: req.query.cursor === undefined ? null : String(req.query.cursor)
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/assets/opening-options",
    requireMbtSurface("dispatcher", "MBT asset registry"),
    async (_req, res, next) => {
      try {
        const assetRegistryService = await resolveAssetRegistryService();
        const result = await assetRegistryService.getMbtAssetOpeningOptions();
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/assets/:assetId/timeline",
    requireMbtSurface("dispatcher", "MBT asset registry"),
    async (req, res, next) => {
      try {
        const assetRegistryService = await resolveAssetRegistryService();
        const result = await assetRegistryService.getMbtBinAssetTimeline(
          requiredRequestText(
            req.params.assetId,
            "MBT_ASSET_ID_REQUIRED",
            "An asset ID is required."
          )
        );
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/assets",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const body = requestObject(req.body);
        const idempotencyKey = requiredRequestText(
          req.get("idempotency-key"),
          "MBT_IDEMPOTENCY_KEY_REQUIRED",
          "An Idempotency-Key header is required."
        );
        await authorizePhase3Capability({ capability: "assetManagement" });
        const assetRegistryService = await resolveAssetRegistryService();
        const result = await assetRegistryService.registerMbtBinAsset({
          actor: commandActor(req),
          asset: body.asset,
          initialState: body.initialState,
          reason: String(body.reason || "").trim(),
          idempotencyKey,
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.patch(
    "/assets/:assetId",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const body = requestObject(req.body);
        await authorizePhase3Capability({ capability: "assetManagement" });
        const service = await resolveAssetRegistryService();
        const result = await service.updateMbtBinAssetAttributes({
          actor: commandActor(req),
          assetId: requiredRequestText(
            req.params.assetId,
            "MBT_ASSET_ID_REQUIRED",
            "An asset ID is required."
          ),
          attributes: { active: body.active },
          expectedRevision: Number(body.expectedRevision),
          reason: `${body.active === true ? "Activated" : "Inactivated"} asset from MBT asset management`,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/assets/:assetId",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const body = requestObject(req.body);
        await authorizePhase3Capability({ capability: "assetManagement" });
        const service = await resolveAssetRegistryService();
        const result = await service.deleteMbtBinAsset({
          actor: commandActor(req),
          assetId: requiredRequestText(
            req.params.assetId,
            "MBT_ASSET_ID_REQUIRED",
            "An asset ID is required."
          ),
          expectedRevision: Number(body.expectedRevision),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post("/customers/sync", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const idempotencyKey = requiredRequestText(
        req.get("idempotency-key"),
        "MBT_IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header is required."
      );
      await authorizePhase3Capability({ capability: "customerSync" });
      const service = await resolveCustomerOperationsService();
      const result = await service.startCustomerSync({
        actor: commandActor(req),
        syncKind: requiredRequestText(
          body.syncKind,
          "MBT_CUSTOMER_SYNC_KIND_REQUIRED",
          "A customer sync kind is required."
        ),
        reason: requiredRequestText(
          body.reason,
          "MBT_AUDIT_REASON_REQUIRED",
          "A customer sync audit reason is required."
        ),
        idempotencyKey,
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/customers/sync/runs", requireMbtAdmin, async (req, res, next) => {
    try {
      const service = await resolveCustomerOperationsService();
      const result = await service.listCustomerSyncRuns({
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        cursor: req.query.cursor === undefined ? null : String(req.query.cursor)
      });
      noStore(res);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/customers/sync/runs/:runId", requireMbtAdmin, async (req, res, next) => {
    try {
      const service = await resolveCustomerOperationsService();
      const result = await service.getCustomerSyncRun(requiredRequestText(
        req.params.runId,
        "MBT_CUSTOMER_SYNC_RUN_REQUIRED",
        "A customer sync run ID is required."
      ));
      noStore(res);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/customers/conflicts", requireMbtAdmin, async (req, res, next) => {
    try {
      const service = await resolveCustomerOperationsService();
      const result = await service.listCustomerConflicts({
        status: req.query.status === undefined ? "open" : String(req.query.status),
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        cursor: req.query.cursor === undefined ? null : String(req.query.cursor)
      });
      noStore(res);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/customers/conflicts/:conflictId/resolve", requireMbtAdmin, async (req, res, next) => {
    try {
      const body = requestObject(req.body);
      const service = await resolveCustomerOperationsService();
      const result = await service.resolveCustomerConflict({
        actor: commandActor(req),
        conflictId: requiredRequestText(
          req.params.conflictId,
          "MBT_CUSTOMER_CONFLICT_REQUIRED",
          "A customer conflict ID is required."
        ),
        decision: body.decision,
        expectedRevision: /** @type {number} */ (body.expectedRevision),
        reason: requiredRequestText(
          body.reason,
          "MBT_AUDIT_REASON_REQUIRED",
          "A customer conflict audit reason is required."
        ),
        idempotencyKey: requiredRequestText(
          req.get("idempotency-key"),
          "MBT_IDEMPOTENCY_KEY_REQUIRED",
          "An Idempotency-Key header is required."
        ),
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/customers/search",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        const service = await resolveCustomerOperationsService();
        const result = await service.searchCustomers({
          query: String(req.query.query || ""),
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
          cursor: req.query.cursor === undefined ? null : String(req.query.cursor)
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get("/config/netsuite/mappings", requireMbtAdmin, async (_req, res, next) => {
    try {
      const netSuiteRuntime = requestRuntime();
      const configuration = await listNetSuiteMappings();
      noStore(res);
      res.json({
        phase: 2,
        configurationHash: configuration.configurationHash,
        runtimeBinding: publicRuntimeBinding(netSuiteRuntime),
        requirements: configuration.requirements.map((requirement) => ({
          ...requirement,
          mapping: requirement.currentMapping
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/config/netsuite/mappings", requireMbtAdmin, async (req, res, next) => {
    try {
      const result = await putNetSuiteMapping({
        actor: commandActor(req),
        mappingType: req.body?.mappingType,
        localKey: req.body?.localKey,
        mapping: req.body?.mapping,
        expectedRevision: req.body?.expectedRevision,
        reason: requiredRequestText(
          req.body?.reason,
          "MBT_AUDIT_REASON_REQUIRED",
          "A mapping audit reason is required."
        ),
        idempotencyKey: requiredRequestText(
          req.get("idempotency-key"),
          "MBT_IDEMPOTENCY_KEY_REQUIRED",
          "An Idempotency-Key header is required."
        ),
        correlationId: correlationId(req),
        requestId: requestId(req)
      });
      noStore(res);
      res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
      res.status(result.status).json({ phase: 2, ...result.body });
    } catch (error) {
      next(error);
    }
  });

  router.post("/config/netsuite/preflight", requireMbtAdmin, async (req, res, next) => {
    try {
      const netSuiteRuntime = requestRuntime();
      const actor = commandActor(req);
      const adapter = createSandboxAdapter(netSuiteTransport, netSuiteRuntime);
      const result = await runNetSuiteSandboxPreflight({
        adapter,
        repository: readinessRepository,
        accountId: String(netSuiteRuntime.accountId || ""),
        runtimeAccountId: String(netSuiteRuntime.runtimeAccountId || netSuiteRuntime.accountId || ""),
        environmentName: String(netSuiteRuntime.environmentName || "sandbox"),
        restBaseUrl: adapterEnvironment(netSuiteRuntime).restBaseUrl,
        requestedBy: actor.operatorId,
        correlationId: correlationId(req),
        leaseOwner: `mbt-http-${process.pid}-${crypto.randomUUID()}`,
        leaseSeconds: safePreflightLeaseSeconds(netSuiteRuntime),
        directAccessEnabled: netSuiteRuntime.directAccessEnabled,
        sandboxAccountAllowlist: netSuiteRuntime.sandboxAccountAllowlist,
        readTimeoutMs: Number(netSuiteRuntime.readTimeoutMs || 10000)
      });
      const run = await getPublicRun(String(result.claim.preflightRunId || ""), netSuiteRuntime);
      noStore(res);
      res.status(201).json({
        phase: 2,
        runtimeBinding: publicRuntimeBinding(netSuiteRuntime),
        run
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/netsuite/preflight/latest", requireMbtAdmin, async (_req, res, next) => {
    try {
      const netSuiteRuntime = requestRuntime();
      const run = await getLatestPublicRun(netSuiteRuntime);
      noStore(res);
      res.json({
        phase: 2,
        runtimeBinding: publicRuntimeBinding(netSuiteRuntime),
        run
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/netsuite/preflight/:runId/export", requireMbtAdmin, async (req, res, next) => {
    try {
      const netSuiteRuntime = requestRuntime();
      const runId = requiredRequestText(
        req.params.runId,
        "MBT_NETSUITE_PREFLIGHT_RUN_REQUIRED",
        "A preflight run ID is required."
      );
      const run = await getPublicRun(runId, netSuiteRuntime);
      const report = buildPreflightReport(run);
      const format = String(req.query.format || "json").trim().toLowerCase();
      if (!new Set(["json", "csv"]).has(format)) {
        throw new MbtError({
          status: 400,
          code: "MBT_NETSUITE_PREFLIGHT_EXPORT_FORMAT_INVALID",
          message: "Choose a JSON or CSV preflight export."
        });
      }
      const body = format === "csv"
        ? serializePreflightCsv(report)
        : serializePreflightJson(report);
      noStore(res);
      res.setHeader("content-type", format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/json; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="${run.runId}.${format}"`);
      res.setHeader("x-content-type-options", "nosniff");
      res.send(body);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/config/netsuite/preflight/:runId/signoff",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const netSuiteRuntime = requestRuntime();
        const result = await signoffNetSuitePreflightRun({
          actor: commandActor(req),
          preflightRunId: requiredRequestText(
            req.params.runId,
            "MBT_NETSUITE_PREFLIGHT_RUN_REQUIRED",
            "A preflight run ID is required."
          ),
          reason: requiredRequestText(
            req.body?.auditNote,
            "MBT_AUDIT_NOTE_REQUIRED",
            "A signoff audit note is required."
          ),
          runtime: readinessRuntime(netSuiteRuntime),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(201).json({ signoff: publicSignoff(result.body.signoff) });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get("/config/netsuite/preflight/:runId", requireMbtAdmin, async (req, res, next) => {
    try {
      const netSuiteRuntime = requestRuntime();
      const run = await getPublicRun(requiredRequestText(
        req.params.runId,
        "MBT_NETSUITE_PREFLIGHT_RUN_REQUIRED",
        "A preflight run ID is required."
      ), netSuiteRuntime);
      noStore(res);
      res.json({
        phase: 2,
        runtimeBinding: publicRuntimeBinding(netSuiteRuntime),
        run
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/config/flags/:flagKey/description",
    requireMbtAdmin,
    async (req, res, next) => {
      try {
        const result = await updateMbtFeatureFlagDescription({
          actor: commandActor(req),
          flagKey: requiredRequestText(
            req.params.flagKey,
            "MBT_FEATURE_FLAG_REQUIRED",
            "A feature flag key is required."
          ),
          description: req.body?.description,
          expectedRevision: req.body?.expectedRevision,
          reason: requiredRequestText(
            req.body?.reason,
            "MBT_AUDIT_REASON_REQUIRED",
            "An audit reason is required."
          ),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  /** @param {string} reason */
  function frontdeskGateMessage(reason) {
    return ({
      environment_root_disabled: "Front Desk is disabled by the server environment root setting.",
      environment_capability_disabled: "Front Desk is disabled by the server environment setting.",
      database_root_missing: "The MBT database root safety flag is missing.",
      database_root_disabled: "The MBT database root safety flag is disabled.",
      database_capability_missing: "The Front Desk database safety flag is missing.",
      database_capability_disabled: "The Front Desk database safety flag is disabled.",
      pilot_scope_denied: "This operator is outside the enabled Front Desk pilot scope."
    })[reason] || "Front Desk is disabled by an effective server safety gate.";
  }

  /** @param {import("express").Response} res @param {string} reason */
  function disabledFrontdeskStatus(res, reason) {
    noStore(res);
    return res.json({
      schemaVersion: "mbt-frontdesk-status-v1",
      phase: 3,
      surface: "frontdesk",
      enabled: false,
      code: "MBT_CAPABILITY_DISABLED",
      message: frontdeskGateMessage(reason),
      commandState: { enabled: false, reason }
    });
  }

  router.get(
    "/frontdesk/status",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (_req, res, next) => {
      if (config.mbt.enabled !== true) {
        return disabledFrontdeskStatus(res, "environment_root_disabled");
      }
      if (config.mbtPhase3.frontdeskOperationsEnabled !== true) {
        return disabledFrontdeskStatus(res, "environment_capability_disabled");
      }
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        noStore(res);
        return res.json({
          schemaVersion: "mbt-frontdesk-status-v1",
          phase: 3,
          surface: "frontdesk",
          enabled: true,
          postingEnabled: false,
          commandState: { enabled: true, reason: null }
        });
      } catch (error) {
        if (error instanceof MbtError && error.code === "MBT_CAPABILITY_DISABLED") {
          return disabledFrontdeskStatus(res, String(error.details?.reason || "effective_gate_disabled"));
        }
        return next(error);
      }
    }
  );

  router.get(
    "/frontdesk/configuration",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const service = await resolveFrontdeskService();
        const result = await service.getFrontdeskConfiguration({ actor: commandActor(req) });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/frontdesk/customer-charge/configuration",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const service = await resolveCustomerChargeService();
        const result = await service.getFrontdeskCustomerChargeConfiguration({
          actor: commandActor(req),
          rateCardVersionId: requiredRequestText(
            req.query.rateCardVersionId,
            "MBT_FRONTDESK_RATE_CARD_REQUIRED",
            "A Front Desk rate card version is required."
          )
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/frontdesk/charge-requests/preview",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const rawDistance = await frontdeskPricing.resolveDistance({
          serviceAddressText: body.serviceAddressText,
          originYardCode: body.orderFrom150 === true ? "150" : "3445",
          orderFrom150: body.orderFrom150 === true
        });
        const distanceMetres = Number(
          rawDistance && typeof rawDistance === "object"
            ? /** @type {Record<string, unknown>} */ (rawDistance).providerMetres
            : Number.NaN
        );
        if (!Number.isSafeInteger(distanceMetres) || distanceMetres < 0) {
          throw new MbtError({
            status: 422,
            code: "MBT_FRONTDESK_DISTANCE_INVALID",
            message: "The server distance resolver did not return a valid distance."
          });
        }
        const service = await resolveCustomerChargeService();
        const result = await service.previewFrontdeskChargeRequest({
          actor: commandActor(req),
          kind: body.kind,
          customerNetsuiteId: body.customerNetsuiteId,
          contractId: body.contractId,
          serviceLineId: body.serviceLineId,
          expectedContractRevision: body.expectedContractRevision,
          expectedServiceLineRevision: body.expectedServiceLineRevision,
          rateCardVersionId: body.rateCardVersionId,
          paymentMethod: body.paymentMethod,
          billingAddressText: body.billingAddressText,
          serviceAddressText: body.serviceAddressText,
          contractTelephone: body.contractTelephone,
          orderFrom150: body.orderFrom150 === true,
          distanceMetres,
          bin: body.bin,
          aggregateLines: body.aggregateLines,
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/frontdesk/charge-requests/:chargeRequestId/confirm",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const service = await resolveCustomerChargeService();
        const result = await service.confirmFrontdeskChargeRequest({
          actor: commandActor(req),
          chargeRequestId: requiredRequestText(
            req.params.chargeRequestId,
            "MBT_FRONTDESK_CHARGE_REQUEST_REQUIRED",
            "A Front Desk charge request ID is required."
          ),
          expectedRevision: body.expectedRevision,
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/frontdesk/customers",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const service = await resolveFrontdeskService();
        const result = await service.searchFrontdeskCustomers({
          actor: commandActor(req),
          query: String(req.query.query || ""),
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit)
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/frontdesk/customers/:customerNetsuiteId/contracts",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const service = await resolveFrontdeskService();
        const result = await service.getFrontdeskCustomerContracts({
          actor: commandActor(req),
          customerNetsuiteId: requiredRequestText(
            req.params.customerNetsuiteId,
            "MBT_FRONTDESK_CUSTOMER_REQUIRED",
            "A Front Desk customer ID is required."
          ),
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit)
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/frontdesk/quotes",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const service = await resolveFrontdeskService();
        const result = await service.createFrontdeskQuote({
          actor: commandActor(req),
          customerNetsuiteId: body.customerNetsuiteId,
          siteProfileId: body.siteProfileId,
          site: body.site,
          serviceTemplateVersionId: body.serviceTemplateVersionId,
          rateCardVersionId: body.rateCardVersionId,
          binItemCode: body.binItemCode,
          binTypeId: body.binTypeId,
          deliveryItemCode: body.deliveryItemCode,
          pricingOriginYardCode: body.pricingOriginYardCode,
          orderFrom150: body.orderFrom150 === true,
          paymentMethod: body.paymentMethod,
          billingAddressText: body.billingAddressText,
          serviceAddressText: body.serviceAddressText,
          contractTelephone: body.contractTelephone,
          contentCode: body.contentCode,
          discountMinor: body.discountMinor,
          discountReason: body.discountReason,
          aggregateLines: body.aggregateLines,
          dumpItemCode: body.dumpItemCode,
          estimatedTonnes: body.estimatedTonnes,
          surcharges: body.surcharges,
          serviceCode: body.serviceCode,
          proposedDeliveryAt: body.proposedDeliveryAt,
          proposedReturnAt: body.proposedReturnAt,
          serviceLines: body.serviceLines,
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        }, frontdeskPricing);
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/frontdesk/delivery-orders",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const service = await resolveFrontdeskService();
        const result = await service.createFrontdeskDeliveryOrder({
          actor: commandActor(req),
          customerNetsuiteId: body.customerNetsuiteId,
          itemCode: body.itemCode,
          pickupLocation: body.pickupLocation,
          dropoffLocation: body.dropoffLocation,
          orderDetails: body.orderDetails,
          weightLbs: body.weightLbs,
          stopMinutes: body.stopMinutes,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  /** @param {"issue" | "accept" | "convert"} action */
  function frontdeskQuoteAction(action) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const service = await resolveFrontdeskService();
        const operation = action === "issue"
          ? service.issueFrontdeskQuote
          : action === "accept"
            ? service.acceptFrontdeskQuote
            : service.convertFrontdeskQuote;
        const result = await operation({
          actor: commandActor(req),
          quoteId: requiredRequestText(
            req.params.quoteId,
            "MBT_FRONTDESK_QUOTE_REQUIRED",
            "A Front Desk quote ID is required."
          ),
          expectedRevision: body.expectedRevision,
          ...(action === "issue" ? { validUntil: body.validUntil } : {}),
          ...(action === "accept" ? { acceptedAt: body.acceptedAt } : {}),
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.post(
    "/frontdesk/quotes/:quoteId/issue",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    frontdeskQuoteAction("issue")
  );
  router.post(
    "/frontdesk/quotes/:quoteId/accept",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    frontdeskQuoteAction("accept")
  );
  router.post(
    "/frontdesk/quotes/:quoteId/convert",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    frontdeskQuoteAction("convert")
  );

  router.get(
    "/frontdesk/contracts/:contractId/charge-requests",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const service = await resolveCustomerChargeService();
        const result = await service.listFrontdeskContractChargeRequests({
          actor: commandActor(req),
          contractId: requiredRequestText(
            req.params.contractId,
            "MBT_FRONTDESK_CONTRACT_REQUIRED",
            "A Front Desk contract ID is required."
          )
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/frontdesk/contracts/:contractId",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const service = await resolveFrontdeskService();
        const result = await service.getFrontdeskContractTimeline({
          actor: commandActor(req),
          contractId: requiredRequestText(
            req.params.contractId,
            "MBT_FRONTDESK_CONTRACT_REQUIRED",
            "A Front Desk contract ID is required."
          )
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/frontdesk/contracts/:contractId/extensions",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const service = await resolveFrontdeskService();
        const result = await service.extendFrontdeskContract({
          actor: commandActor(req),
          contractId: requiredRequestText(
            req.params.contractId,
            "MBT_FRONTDESK_CONTRACT_REQUIRED",
            "A Front Desk contract ID is required."
          ),
          expectedRevision: body.expectedRevision,
          returnWindow: body.returnWindow,
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  /** @param {"extend" | "exchange" | "collect" | "confirm"} action */
  function frontdeskServiceLineMutation(action) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const service = await resolveFrontdeskService();
        const operation = action === "extend"
          ? service.extendFrontdeskServiceLine
          : action === "exchange"
            ? service.exchangeFrontdeskServiceLine
            : action === "collect"
              ? service.collectFrontdeskServiceLine
              : service.confirmFrontdeskServiceLineCustomerChange;
        const result = await operation({
          actor: commandActor(req),
          contractId: requiredRequestText(
            req.params.contractId,
            "MBT_FRONTDESK_CONTRACT_REQUIRED",
            "A Front Desk contract ID is required."
          ),
          serviceLineId: requiredRequestText(
            req.params.serviceLineId,
            "MBT_FRONTDESK_SERVICE_LINE_REQUIRED",
            "A Front Desk service-line ID is required."
          ),
          expectedRevision: body.expectedRevision,
          ...(action === "extend" ? { returnWindow: body.returnWindow } : {}),
          ...(action === "exchange" ? {
            exchangeWindow: body.exchangeWindow,
            incomingBinTypeId: body.incomingBinTypeId,
            chargeMode: body.chargeMode,
            waiverReason: body.waiverReason
          } : {}),
          ...(action === "collect" ? { collectionWindow: body.collectionWindow } : {}),
          ...(action === "confirm" ? { decision: body.decision } : {}),
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.post(
    "/frontdesk/contracts/:contractId/service-lines/:serviceLineId/extensions",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    frontdeskServiceLineMutation("extend")
  );
  router.post(
    "/frontdesk/contracts/:contractId/service-lines/:serviceLineId/exchanges",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    frontdeskServiceLineMutation("exchange")
  );
  router.post(
    "/frontdesk/contracts/:contractId/service-lines/:serviceLineId/collections",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    frontdeskServiceLineMutation("collect")
  );
  router.post(
    "/frontdesk/contracts/:contractId/service-lines/:serviceLineId/customer-confirmations",
    requireMbtSurface("mbt_frontdesk", "MBT Front Desk"),
    frontdeskServiceLineMutation("confirm")
  );

  router.post(
    "/dispatch/contracts/:contractId/service-lines/:serviceLineId/change-requests",
    requireMbtSurface("dispatcher", "Dispatcher"),
    async (req, res, next) => {
      try {
        await authorizePhase3Capability({ capability: "frontdeskOperations" });
        const body = requestObject(req.body);
        const service = await resolveFrontdeskService();
        const result = await service.markFrontdeskServiceLineDispatchChange({
          actor: commandActor(req),
          contractId: requiredRequestText(
            req.params.contractId,
            "MBT_FRONTDESK_CONTRACT_REQUIRED",
            "A Front Desk contract ID is required."
          ),
          serviceLineId: requiredRequestText(
            req.params.serviceLineId,
            "MBT_FRONTDESK_SERVICE_LINE_REQUIRED",
            "A Front Desk service-line ID is required."
          ),
          expectedRevision: body.expectedRevision,
          change: body.change,
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  /** @param {import("express").Request} req */
  async function binDispatchCapability(req) {
    const roles = normalizedRoles(requestOperator(req));
    const pilotAuthorized = roles.has("admin") || roles.has("dispatcher");
    await authorizePhase3Capability({ capability: "binDispatch", pilotAuthorized });
    return {
      environmentEnabled: true,
      databaseEnabled: true,
      pilotAuthorized: true
    };
  }

  router.get(
    "/dispatch/front-legs",
    requireMbtSurface("dispatcher", "Dispatcher"),
    async (req, res, next) => {
      try {
        const capability = await binDispatchCapability(req);
        const service = await resolveBinDispatchService();
        const result = await service.listMbtBinFrontLegs({
          planDate: req.query.planDate,
          search: req.query.search,
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit)
        }, { capability });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/dispatch/contracts/:contractId/timeline",
    requireMbtSurface("dispatcher", "Dispatcher"),
    async (req, res, next) => {
      try {
        const capability = await binDispatchCapability(req);
        const service = await resolveBinDispatchService();
        const result = await service.getMbtBinContractTimeline({
          contractId: req.params.contractId
        }, { capability });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  /** @param {"assign" | "move" | "recover" | "advance"} action */
  function binDispatchMutation(action) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        const capability = await binDispatchCapability(req);
        const body = requestObject(req.body);
        const service = await resolveBinDispatchService();
        const operation = action === "assign"
          ? service.assignMbtBinFrontLeg
          : action === "move"
            ? service.moveMbtBinFrontLegAssignment
            : action === "recover"
              ? service.recoverMbtBinFrontLegAssignment
              : service.advanceMbtBinContractLeg;
        const routeIdentity = action === "move" || action === "recover"
          ? { visitId: req.params.visitId }
          : action === "advance"
            ? { contractId: req.params.contractId }
            : {};
        const result = await operation({
          ...body,
          ...routeIdentity,
          actor: commandActor(req),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        }, { capability });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.post(
    "/dispatch/assignments",
    requireMbtSurface("dispatcher", "Dispatcher"),
    binDispatchMutation("assign")
  );
  router.post(
    "/dispatch/assignments/:visitId/move",
    requireMbtSurface("dispatcher", "Dispatcher"),
    binDispatchMutation("move")
  );
  router.post(
    "/dispatch/assignments/:visitId/recover",
    requireMbtSurface("dispatcher", "Dispatcher"),
    binDispatchMutation("recover")
  );
  router.post(
    "/dispatch/contracts/:contractId/advance",
    requireMbtSurface("dispatcher", "Dispatcher"),
    binDispatchMutation("advance")
  );

  /** @param {import("express").Request} req */
  async function billingCommandCapability(req) {
    const roles = normalizedRoles(requestOperator(req));
    const pilotAuthorized = roles.has("admin") || roles.has("mbt_billing");
    return authorizePhase3Capability({ capability: "billingOperations", pilotAuthorized });
  }

  /** @param {import("express").Request} req */
  async function billingCommandState(req) {
    try {
      await billingCommandCapability(req);
      return { enabled: true, code: null, reason: null };
    } catch (error) {
      if (!(error instanceof MbtError) || error.code !== "MBT_CAPABILITY_DISABLED") {
        throw error;
      }
      return {
        enabled: false,
        code: error.code,
        reason: String(error.details.reason || "capability_disabled")
      };
    }
  }

  router.get(
    "/billing/status",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        const commandState = await billingCommandState(req);
        noStore(res);
        if (!commandState.enabled && [
          "environment_root_disabled",
          "database_root_missing",
          "database_root_disabled"
        ].includes(String(commandState.reason || ""))) {
          return res.json({
            schemaVersion: "mbt-v1",
            phase: 1,
            surface: "billing",
            enabled: false,
            code: "MBT_CAPABILITY_DISABLED",
            message: "Billing operations are not enabled in Phase 1."
          });
        }
        return res.json({
          schemaVersion: "mbt-billing-surface-v1",
          phase: 3,
          surface: "billing",
          enabled: commandState.enabled,
          commandState,
          postingMode: "local_only",
          netSuiteWritesEnabled: false,
          readOnlyRecoveryAvailable: true,
          message: commandState.enabled
            ? "Local shadow calculation, reconciliation, and approval are enabled. NetSuite posting remains forbidden."
            : "Billing commands are closed. Retained local cases and reconciliation evidence remain available read-only."
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.get(
    "/billing/cases",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        const service = await resolveBillingService();
        const result = await service.listLocalBillingCases({
          actor: commandActor(req),
          status: req.query.status,
          caseType: req.query.caseType,
          billingMonth: req.query.billingMonth,
          cursor: req.query.cursor,
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit)
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/billing/cases/:caseId",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        const caseId = requiredRequestUuid(req.params.caseId, "Billing-case ID");
        const service = await resolveBillingService();
        const result = await service.getLocalBillingCase(caseId, commandActor(req));
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/billing/mbbs/candidates",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        const service = await resolveBillingCandidateService();
        const result = await service.listMbbsBillingCandidates({
          actor: commandActor(req),
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
          completedMonth: req.query.completedMonth
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/billing/mbbs/candidates/batch-preview",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        await billingCommandCapability(req);
        const body = requestObject(req.body);
        const service = await resolveBillingCandidateService();
        const result = await service.previewMbbsBillingCandidatesBatch({
          actor: commandActor(req),
          candidateIds: body.candidateIds,
          completedMonth: body.completedMonth,
          rateCardVersionId: body.rateCardVersionId
        }, { resolveDistance: frontdeskPricing.resolveDistance });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.put(
    "/billing/mbbs/candidates/:candidateId/address-override",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        await billingCommandCapability(req);
        const body = requestObject(req.body);
        const service = await resolveBillingCandidateService();
        const result = await service.setMbbsBillingCandidateAddressOverride({
          actor: commandActor(req),
          candidateId: requiredRequestText(
            req.params.candidateId,
            "MBT_BILLING_CANDIDATE_ID_INVALID",
            "An MBBS billing candidate ID is required."
          ),
          completedMonth: body.completedMonth,
          destinationAddressText: body.destinationAddressText,
          expectedRevision: body.expectedRevision,
          reason: body.reason,
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/billing/mbbs/candidates/:candidateId/preview",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        await billingCommandCapability(req);
        const body = requestObject(req.body);
        const service = await resolveBillingCandidateService();
        const result = await service.previewMbbsBillingCandidate({
          actor: commandActor(req),
          candidateId: requiredRequestText(
            req.params.candidateId,
            "MBT_BILLING_CANDIDATE_ID_INVALID",
            "An MBBS billing candidate ID is required."
          ),
          completedMonth: body.completedMonth,
          rateCardVersionId: body.rateCardVersionId
        }, { resolveDistance: frontdeskPricing.resolveDistance });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  /** @param {"calculate" | "approve" | "generate_mbbs"} action */
  function billingMutation(action) {
    /** @type {import("express").RequestHandler} */
    return async (req, res, next) => {
      try {
        await billingCommandCapability(req);
        const body = requestObject(req.body);
        const service = await resolveBillingService();
        const operation = action === "calculate"
          ? service.calculateMbtBillingCase
          : action === "approve"
            ? service.approveLocalBillingVersion
            : service.generateMbbsShadowBillingFromSnapshots;
        const routeIdentity = action === "calculate" || action === "approve"
          ? { billingCaseId: requiredRequestUuid(req.params.caseId, "Billing-case ID") }
          : {};
        const result = await operation({
          ...body,
          ...routeIdentity,
          actor: commandActor(req),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    };
  }

  router.post(
    "/billing/cases/:caseId/calculate",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    billingMutation("calculate")
  );
  router.post(
    "/billing/cases/:caseId/approve-local",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    billingMutation("approve")
  );
  router.post(
    "/billing/mbbs/generate",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    billingMutation("generate_mbbs")
  );

  router.get(
    "/reconciliation/batches",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        const service = await resolveReconciliationService();
        const result = await service.listPilotReconciliationBatches({
          actor: commandActor(req),
          cursor: req.query.cursor,
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit)
        });
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/reconciliation/batches/:batchId",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        const batchId = requiredRequestUuid(req.params.batchId, "Reconciliation batch ID");
        const service = await resolveReconciliationService();
        const result = await service.getPilotReconciliationBatch(batchId, commandActor(req));
        noStore(res);
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/reconciliation/batches",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        await billingCommandCapability(req);
        const body = requestObject(req.body);
        const service = await resolveReconciliationService();
        const result = await service.createPilotReconciliationBatch({
          ...body,
          actor: commandActor(req),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/reconciliation/batches/:batchId/resolve",
    requireMbtSurface("mbt_billing", "MBT Billing"),
    async (req, res, next) => {
      try {
        await billingCommandCapability(req);
        const body = requestObject(req.body);
        const service = await resolveReconciliationService();
        const result = await service.resolvePilotVariance({
          ...body,
          reconciliationBatchId: requiredRequestUuid(req.params.batchId, "Reconciliation batch ID"),
          reconciliationRowId: requiredRequestUuid(body.reconciliationRowId, "Reconciliation row ID"),
          actor: commandActor(req),
          idempotencyKey: requiredRequestText(
            req.get("idempotency-key"),
            "MBT_IDEMPOTENCY_KEY_REQUIRED",
            "An Idempotency-Key header is required."
          ),
          correlationId: correlationId(req),
          requestId: requestId(req)
        });
        noStore(res);
        res.setHeader("x-mbt-idempotent-replay", String(result.replayed));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    }
  );

  router.post("/bin-assets/:assetId/reservations", async (_req, _res, next) => {
    try {
      rejectDisabledCapability("bin_dispatch");
    } catch (error) {
      next(error);
    }
  });

  router.use(mbtErrorHandler);

  return router;
}
