// @ts-check

import { MbtError } from "./errors.js";

const SAFE_RECORD_TYPE = /^[A-Za-z][A-Za-z0-9_]*$/;
const SAFE_SCRIPT_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const SANDBOX_ACCOUNT = /_SB\d+$/i;
const SANDBOX_HOST = /-sb\d+\.suitetalk\.api\.netsuite\.com$/i;
const RECORD_API_PATH = "/services/rest/record/v1";

/** @param {string} code @param {string} message @param {number} [status] */
function adapterError(code, message, status = 409) {
  return new MbtError({ status, code, message });
}

/** @param {unknown} value */
function text(value) {
  return String(value ?? "");
}

/** @param {unknown} value */
function optionalText(value) {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/** @param {unknown} value */
function referenceId(value) {
  const normalized = value && typeof value === "object" && !Array.isArray(value)
    ? optionalText(/** @type {{id?: unknown}} */ (value).id)
    : optionalText(value);
  return normalized?.trim() ? normalized.trim() : null;
}

/** @param {unknown} value */
function referenceName(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const reference = /** @type {{refName?: unknown, name?: unknown}} */ (value);
    const normalized = optionalText(reference.refName ?? reference.name);
    return normalized?.trim() ? normalized.trim() : null;
  }
  return optionalText(value);
}

/** @param {unknown} value */
function referenceText(value) {
  return referenceName(value) ?? referenceId(value);
}

/** @param {Record<string, unknown>} target @param {string} key @param {unknown} value */
function assignText(target, key, value) {
  const normalized = optionalText(value);
  if (normalized !== null) {
    target[key] = normalized;
  }
}

/** @param {unknown} value @returns {string[]} */
function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .map(referenceText)
    .filter((entry) => entry !== null))].sort();
}

/** @param {unknown} value @returns {unknown[] | null} */
function referenceCollection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const items = /** @type {{items?: unknown}} */ (value).items;
  return Array.isArray(items) ? items : null;
}

/** @param {Record<string, unknown>} payload @param {string | null} primary */
function subsidiaryEvidence(payload, primary) {
  const nested = referenceCollection(payload.subsidiaries)
    ?? referenceCollection(payload.subsidiary);
  const direct = Array.isArray(payload.subsidiaryIds) ? payload.subsidiaryIds : null;
  const references = nested ?? direct;
  const ids = references === null
    ? []
    : references.map(referenceId).filter((id) => id !== null);
  if (primary !== null) {
    ids.push(primary);
  }
  return {
    ids: [...new Set(ids)].sort(),
    hasCollection: references !== null
  };
}

/** @param {unknown} value */
function assertSafeRecordType(value) {
  const recordType = text(value);
  if (!SAFE_RECORD_TYPE.test(recordType)) {
    throw new TypeError("A safe NetSuite record type is required.");
  }
  return recordType;
}

/** @param {Record<string, unknown>} projected @param {Record<string, unknown>} payload @param {string} recordType */
function projectIdentity(projected, payload, recordType) {
  for (const key of ["id", "scriptId", "entityId", "companyName"]) {
    assignText(projected, key, payload[key]);
  }
  assignText(projected, "name", payload.name ?? (recordType === "account" ? payload.acctName : undefined));
  if (recordType === "subsidiary") {
    assignText(projected, "legalName", payload.legalName ?? payload.legalname);
  }
}

/** @param {Record<string, unknown>} projected @param {Record<string, unknown>} payload */
function projectActiveState(projected, payload) {
  const inactive = payload.isInactive ?? payload.isinactive;
  if (typeof inactive === "boolean") {
    projected.active = !inactive;
  } else if (typeof payload.active === "boolean") {
    projected.active = payload.active;
  }
}

/** @param {Record<string, unknown>} projected @param {Record<string, unknown>} payload */
function projectSubsidiaries(projected, payload) {
  const primaryId = referenceId(payload.subsidiary ?? payload.subsidiaryId);
  if (primaryId !== null) {
    projected.subsidiaryId = primaryId;
  }
  const evidence = subsidiaryEvidence(payload, primaryId);
  if (evidence.ids.length > (primaryId === null ? 0 : 1) || evidence.hasCollection) {
    projected.subsidiaryIds = evidence.ids;
  }
}

/** @param {Record<string, unknown>} projected @param {Record<string, unknown>} payload */
function projectReferences(projected, payload) {
  /** @type {Array<[string, string, string]>} */
  const references = [
    ["currencyId", "currency", "currencyId"],
    ["termsId", "terms", "termsId"],
    ["taxItemId", "taxItem", "taxItemId"]
  ];
  for (const [key, officialKey, compatibilityKey] of references) {
    const sourceKey = Object.hasOwn(payload, officialKey)
      ? officialKey
      : Object.hasOwn(payload, compatibilityKey) ? compatibilityKey : null;
    if (sourceKey === null) {
      continue;
    }
    const value = payload[sourceKey];
    const id = referenceId(value);
    if (id !== null) {
      projected[key] = id;
    } else if (value === null) {
      projected[key] = null;
    }
  }
}

/** @param {Record<string, unknown>} target @param {string} key @param {unknown} value */
function assignReferenceText(target, key, value) {
  const normalized = referenceText(value);
  if (normalized !== null) {
    target[key] = normalized;
  }
}

/** @param {Record<string, unknown>} payload @param {string} recordType */
function accountTypeEvidence(payload, recordType) {
  if (recordType !== "account") {
    return referenceText(payload.accountType);
  }
  return Object.hasOwn(payload, "acctType")
    ? referenceId(payload.acctType)
    : referenceText(payload.accountType);
}

/** @param {Record<string, unknown>} projected @param {unknown} value */
function projectBaseCurrency(projected, value) {
  assignReferenceText(projected, "baseCurrency", value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const id = referenceId(value);
  const name = referenceName(value);
  if (id !== null) {
    projected.baseCurrencyId = id;
  }
  if (name !== null) {
    projected.baseCurrencyName = name;
  }
}

/** @param {Record<string, unknown>} projected @param {Record<string, unknown>} payload @param {string} recordType */
function projectMetadata(projected, payload, recordType) {
  assignReferenceText(projected, "creditHold", payload.creditHoldOverride ?? payload.creditHold);
  assignText(projected, "accountType", accountTypeEvidence(payload, recordType));
  for (const key of ["customerType", "fieldType", "permissionLevel"]) {
    assignReferenceText(projected, key, payload[key]);
  }
  projectBaseCurrency(
    projected,
    recordType === "subsidiary" ? payload.currency ?? payload.baseCurrency : payload.baseCurrency
  );
  const appliesTo = stringList(payload.appliesTo);
  if (appliesTo.length > 0) {
    projected.appliesTo = appliesTo;
  }
  assignText(projected, "folderPath", payload.path ?? payload.folderPath);
}

/**
 * Reduce a NetSuite response to the finite set of fields Phase 2 is permitted
 * to persist. Links, tokens, credentials, and arbitrary response branches are
 * inaccessible by construction.
 *
 * @param {unknown} recordTypeValue
 * @param {unknown} payloadValue
 * @returns {Readonly<Record<string, unknown>>}
 */
export function projectObservedNetSuiteRecord(recordTypeValue, payloadValue) {
  const recordType = assertSafeRecordType(recordTypeValue);
  if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) {
    throw new TypeError("A NetSuite record object is required.");
  }
  const payload = /** @type {Record<string, unknown>} */ (payloadValue);
  /** @type {Record<string, unknown>} */
  const projected = { recordType };
  projectIdentity(projected, payload, recordType);
  projectActiveState(projected, payload);
  projectSubsidiaries(projected, payload);
  projectReferences(projected, payload);
  projectMetadata(projected, payload, recordType);
  return Object.freeze(projected);
}

/** @param {unknown} value */
function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {Record<string, unknown>} payload @param {string} recordType @param {string} scriptId */
function metadataField(payload, recordType, scriptId) {
  const directField = plainRecord(plainRecord(payload.properties)[scriptId]);
  if (Object.keys(directField).length > 0) {
    return directField;
  }
  const components = plainRecord(payload.components);
  const schemas = plainRecord(components.schemas);
  const schema = plainRecord(schemas[recordType]);
  return plainRecord(plainRecord(schema.properties)[scriptId]);
}

/** @param {string} recordType @param {string} scriptId @param {unknown} payloadValue */
function projectMetadataField(recordType, scriptId, payloadValue) {
  if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) {
    throw new TypeError("A NetSuite metadata catalog object is required.");
  }
  const field = metadataField(
    /** @type {Record<string, unknown>} */ (payloadValue),
    recordType,
    scriptId
  );
  const fieldType = text(field.type);
  if (!fieldType) {
    return Object.freeze({ recordType, scriptId, active: false });
  }
  return Object.freeze({
    recordType,
    scriptId,
    fieldType,
    appliesTo: Object.freeze([recordType]),
    active: true
  });
}

/**
 * @typedef {object} SandboxEnvironment
 * @property {boolean} directAccessEnabled
 * @property {string} configuredAccountId
 * @property {string} runtimeAccountId
 * @property {string} [environmentName]
 * @property {readonly string[]} sandboxAccountAllowlist
 * @property {string} restBaseUrl
 */

/** @param {unknown} value @returns {URL | null} */
function parsedUrl(value) {
  try {
    return new URL(text(value));
  } catch {
    return null;
  }
}

/** @param {URL | null} url @param {string} accountId */
function isApprovedSandboxUrl(url, accountId) {
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    return false;
  }
  const expectedHost = `${accountId.toLowerCase().replaceAll("_", "-")}.suitetalk.api.netsuite.com`;
  const path = url.pathname.replace(/\/$/, "");
  return SANDBOX_HOST.test(url.hostname)
    && url.hostname.toLowerCase() === expectedHost
    && path === RECORD_API_PATH;
}

/**
 * @param {SandboxEnvironment & Record<string, unknown>} environment
 * @returns {{accountId: string, environmentName: "sandbox", restBaseUrl: string}}
 */
export function assertSandboxNetSuiteEnvironment(environment) {
  if (environment?.directAccessEnabled !== true) {
    throw adapterError(
      "MBT_NETSUITE_DIRECT_ACCESS_REQUIRED",
      "Direct NetSuite access must be enabled for sandbox readiness."
    );
  }
  const accountId = text(environment.configuredAccountId);
  const runtimeAccountId = text(environment.runtimeAccountId);
  const environmentName = text(environment.environmentName || "sandbox").trim().toLowerCase();
  const url = parsedUrl(environment.restBaseUrl);
  if (environmentName !== "sandbox"
      || !SANDBOX_ACCOUNT.test(accountId)
      || !isApprovedSandboxUrl(url, accountId)) {
    throw adapterError(
      "MBT_NETSUITE_PRODUCTION_REFUSED",
      "MBT readiness can contact only the configured NetSuite sandbox account."
    );
  }
  if (runtimeAccountId !== accountId) {
    throw adapterError(
      "MBT_NETSUITE_ACCOUNT_MISMATCH",
      "The configured NetSuite account does not match the runtime account."
    );
  }
  if (!Array.isArray(environment.sandboxAccountAllowlist)
    || !environment.sandboxAccountAllowlist.includes(accountId)) {
    throw adapterError(
      "MBT_NETSUITE_SANDBOX_NOT_ALLOWED",
      "The NetSuite sandbox account is not on the exact MBT allowlist."
    );
  }
  return {
    accountId,
    environmentName: "sandbox",
    restBaseUrl: /** @type {URL} */ (url).href.replace(/\/$/, "")
  };
}

/** @param {unknown} response */
function responseStatus(response) {
  return response && typeof response === "object"
    ? Number(/** @type {{status?: unknown}} */ (response).status)
    : 0;
}

/** @param {unknown} response */
function responseError(response) {
  const status = responseStatus(response);
  if (status === 403) {
    return adapterError("MBT_NETSUITE_PERMISSION_DENIED", "NetSuite denied a required metadata read.", 403);
  }
  if (status === 404) {
    return adapterError("MBT_NETSUITE_RECORD_NOT_FOUND", "The required NetSuite record was not found.", 404);
  }
  return adapterError("MBT_NETSUITE_UNABLE_TO_VERIFY", "NetSuite metadata could not be verified.", 502);
}

/** @param {unknown} value */
function assertInternalId(value) {
  const internalId = text(value);
  if (!internalId) {
    throw new TypeError("A NetSuite internal ID is required.");
  }
  return internalId;
}

/** @param {ReadDescriptor} descriptor */
function validatedReadDescriptor(descriptor) {
  const readStrategy = descriptor.readStrategy || "record_by_id";
  if (readStrategy !== "record_by_id" && readStrategy !== "metadata_catalog") {
    throw new TypeError("A supported NetSuite read strategy is required.");
  }
  const scriptId = text(descriptor.scriptId);
  if (readStrategy === "metadata_catalog" && !SAFE_SCRIPT_ID.test(scriptId)) {
    throw new TypeError("A safe NetSuite custom-field script ID is required.");
  }
  return { readStrategy, scriptId };
}

/**
 * @typedef {object} TransportResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {boolean} [redirected]
 * @property {string} [url]
 * @property {() => Promise<unknown>} json
 */

/**
 * @typedef {object} ReadDescriptor
 * @property {"record_by_id" | "metadata_catalog"} [readStrategy]
 * @property {string} [scriptId]
 */

/**
 * @typedef {object} ReadTransportInit
 * @property {"GET"} method
 * @property {"error"} redirect
 * @property {AbortSignal} signal
 * @property {Readonly<Record<string, string>>} [headers]
 * @property {undefined} [body]
 */

/**
 * @param {{restBaseUrl: string}} environment
 * @param {string} recordType
 * @param {string} internalId
 * @param {"record_by_id" | "metadata_catalog"} readStrategy
 * @param {AbortSignal} signal
 */
function readRequest(environment, recordType, internalId, readStrategy, signal) {
  if (readStrategy === "metadata_catalog") {
    return {
      url: `${environment.restBaseUrl}/metadata-catalog/${encodeURIComponent(recordType)}`,
      init: {
        method: /** @type {const} */ ("GET"),
        redirect: /** @type {const} */ ("error"),
        signal,
        headers: Object.freeze({ Accept: "application/schema+json" })
      }
    };
  }
  return {
    url: `${environment.restBaseUrl}/${encodeURIComponent(recordType)}/${encodeURIComponent(internalId)}`,
    init: {
      method: /** @type {const} */ ("GET"),
      redirect: /** @type {const} */ ("error"),
      signal
    }
  };
}

/**
 * @param {(url: string, init: ReadTransportInit) => Promise<TransportResponse>} transport
 * @param {string} url
 * @param {ReadTransportInit} init
 * @param {AbortController} controller
 * @param {number} timeoutMs
 */
async function readPayload(transport, url, init, controller, timeoutMs) {
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await transport(url, init);
  } catch (_error) {
    throw adapterError(
      "MBT_NETSUITE_UNABLE_TO_VERIFY",
      "NetSuite metadata could not be verified.",
      502
    );
  } finally {
    clearTimeout(timeout);
  }
  if (response?.redirected === true) {
    throw adapterError(
      "MBT_NETSUITE_REDIRECT_REFUSED",
      "NetSuite redirected a readiness metadata request.",
      502
    );
  }
  if (!response?.ok) {
    throw responseError(response);
  }
  try {
    return await response.json();
  } catch {
    throw adapterError(
      "MBT_NETSUITE_UNABLE_TO_VERIFY",
      "NetSuite returned malformed metadata.",
      502
    );
  }
}

/**
 * @param {object} input
 * @param {SandboxEnvironment & Record<string, unknown>} input.environment
 * @param {(url: string, init: ReadTransportInit) => Promise<TransportResponse>} input.transport
 * @param {number} [input.timeoutMs]
 */
export function createReadOnlyNetSuiteAdapter({ environment, transport, timeoutMs = 10_000 }) {
  const safeEnvironment = assertSandboxNetSuiteEnvironment(environment);
  if (typeof transport !== "function") {
    throw new TypeError("A NetSuite GET transport is required.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError("The NetSuite read timeout must be an integer from 1 to 60000 milliseconds.");
  }

  /** @type {Map<string, Promise<unknown>>} */
  const metadataPayloadsByRecordType = new Map();

  /**
   * @param {string} recordType
   * @param {string} internalId
   * @param {"record_by_id" | "metadata_catalog"} readStrategy
   */
  async function requestPayload(recordType, internalId, readStrategy) {
    const controller = new AbortController();
    const request = readRequest(
      safeEnvironment,
      recordType,
      internalId,
      readStrategy,
      controller.signal
    );
    return readPayload(transport, request.url, request.init, controller, timeoutMs);
  }

  /** @param {string} recordType @param {string} internalId */
  async function metadataPayload(recordType, internalId) {
    const cached = metadataPayloadsByRecordType.get(recordType);
    if (cached) {
      return cached;
    }
    const pending = requestPayload(recordType, internalId, "metadata_catalog");
    metadataPayloadsByRecordType.set(recordType, pending);
    try {
      return await pending;
    } catch (error) {
      if (metadataPayloadsByRecordType.get(recordType) === pending) {
        metadataPayloadsByRecordType.delete(recordType);
      }
      throw error;
    }
  }

  /** @param {unknown} recordTypeValue @param {unknown} internalIdValue @param {ReadDescriptor} [descriptor] */
  async function readRecord(recordTypeValue, internalIdValue, descriptor = {}) {
    const recordType = assertSafeRecordType(recordTypeValue);
    const internalId = assertInternalId(internalIdValue);
    const { readStrategy, scriptId } = validatedReadDescriptor(descriptor);
    const payload = readStrategy === "metadata_catalog"
      ? await metadataPayload(recordType, internalId)
      : await requestPayload(recordType, internalId, readStrategy);
    return readStrategy === "metadata_catalog"
      ? projectMetadataField(recordType, scriptId, payload)
      : projectObservedNetSuiteRecord(recordType, payload);
  }

  return Object.freeze({ readRecord });
}
