import { config } from "./config.js";
import { NetSuiteM2mTokenProvider } from "./netsuite-m2m-auth.js";
import { NetSuiteM2mSettingsStore } from "./netsuite-m2m-settings.js";

const OAUTH_ENDPOINT_PATH = "/services/rest/auth/oauth2/v1/token";
const METADATA_PATH = "/services/rest/record/v1/metadata-catalog";

function exactNetSuiteHttpsUrl(value, requiredPath, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`A valid NetSuite HTTPS ${label} is required.`);
  }
  if (url.protocol !== "https:"
      || !url.hostname.toLowerCase().endsWith(".suitetalk.api.netsuite.com")
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== requiredPath) {
    throw new Error(`A valid NetSuite HTTPS ${label} is required.`);
  }
  return url.toString();
}

export function resolveNetSuiteM2mTokenUrl({ accountId, tokenUrl } = {}) {
  if (String(tokenUrl || "").trim()) {
    return exactNetSuiteHttpsUrl(tokenUrl, OAUTH_ENDPOINT_PATH, "token URL");
  }
  const account = String(accountId || "").trim();
  if (!account || account.length > 128 || !/^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/.test(account)) {
    throw new Error("A valid NetSuite account ID is required to derive the M2M token URL.");
  }
  const hostname = `${account.toLowerCase().replaceAll("_", "-")}.suitetalk.api.netsuite.com`;
  return `https://${hostname}${OAUTH_ENDPOINT_PATH}`;
}

function runtimeTokenUrl() {
  return resolveNetSuiteM2mTokenUrl({
    accountId: config.netsuite.accountId,
    tokenUrl: config.netsuite.tokenUrl
  });
}

function metadataUrl(restBaseUrl) {
  let base;
  try {
    base = new URL(String(restBaseUrl || ""));
  } catch {
    throw new Error("A valid NetSuite HTTPS REST base URL is required for the M2M probe.");
  }
  return exactNetSuiteHttpsUrl(`${base.origin}${METADATA_PATH}`, METADATA_PATH, "REST metadata URL");
}

async function cancelProbeBody(response) {
  const cancel = response?.body?.cancel;
  if (typeof cancel !== "function") {
    return;
  }
  await cancel.call(response.body).catch(() => {});
}

async function validateProbeResponse(response) {
  if (response.redirected) {
    throw new Error("NetSuite M2M read-only probe refused a redirect.");
  }
  if (!response.ok) {
    await cancelProbeBody(response);
    throw new Error(`NetSuite M2M read-only probe failed: ${response.status}.`);
  }
  const contentType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!new Set(["application/json", "application/schema+json"]).has(contentType)) {
    await cancelProbeBody(response);
    throw new Error("NetSuite M2M read-only probe returned an unsupported content type.");
  }
  await cancelProbeBody(response);
  return { ok: true, status: response.status, contentType };
}

export async function probeNetSuiteM2mCredentials({
  credentials,
  restBaseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A NetSuite M2M probe transport is required.");
  }
  const target = metadataUrl(restBaseUrl);
  const provider = new NetSuiteM2mTokenProvider({ loadCredentials: async () => credentials, fetchImpl });
  const accessToken = await provider.getAccessToken({ force: true });
  const timeout = Math.max(1_000, Math.min(60_000, Number(timeoutMs) || 30_000));
  const response = await fetchImpl(target, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/schema+json, application/json"
    }
  });
  return validateProbeResponse(response);
}

const settingsStore = new NetSuiteM2mSettingsStore({
  settingsPath: config.netsuite.m2mSettingsPath,
  masterKeyPath: config.netsuite.m2mMasterKeyPath,
  storageSecret: config.netsuite.m2mStorageSecret,
  tokenUrl: runtimeTokenUrl
});

async function runtimeFetch(url, options = {}) {
  const timeoutMs = Math.max(1_000, Number(config.netsuite.requestTimeoutMs || 120_000));
  const signal = options.signal || (AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  return fetch(url, { ...options, signal });
}

const tokenProvider = new NetSuiteM2mTokenProvider({
  loadCredentials: () => settingsStore.getActiveCredentials(),
  fetchImpl: runtimeFetch
});

function liveProbe(credentials) {
  if (config.netsuite.directAccessEnabled !== true) {
    throw new Error("Direct NetSuite access is disabled on this application.");
  }
  return probeNetSuiteM2mCredentials({
    credentials,
    restBaseUrl: config.netsuite.restBaseUrl,
    fetchImpl: runtimeFetch,
    timeoutMs: Math.min(30_000, Number(config.netsuite.requestTimeoutMs || 30_000))
  });
}

export async function getNetSuiteM2mStatus() {
  const status = await settingsStore.getStatus();
  let tokenUrlReady = true;
  try {
    runtimeTokenUrl();
  } catch {
    tokenUrlReady = false;
  }
  return {
    ...status,
    prerequisites: {
      directAccessEnabled: config.netsuite.directAccessEnabled === true,
      tokenUrlReady,
      restBaseUrlReady: Boolean(String(config.netsuite.restBaseUrl || "").trim())
    }
  };
}

export function stageNetSuiteM2mCertificate(options) {
  return settingsStore.stageCertificate(options);
}

export function getNetSuiteM2mPublicCertificate(slot) {
  return settingsStore.getPublicCertificate(slot);
}

export async function activateNetSuiteM2m(options) {
  const status = await settingsStore.activate({ ...options, probe: liveProbe });
  tokenProvider.invalidate();
  return status;
}

export async function reactivateNetSuiteM2m() {
  const status = await settingsStore.reactivate({ probe: liveProbe });
  tokenProvider.invalidate();
  return status;
}

export async function useNetSuiteAuthorizationCodeFallback() {
  const status = await settingsStore.useAuthorizationCodeFallback();
  tokenProvider.invalidate();
  return status;
}

export async function isNetSuiteM2mActive() {
  const status = await settingsStore.getStatus();
  return status.authMode === "client_credentials" && Boolean(status.active);
}

export function getNetSuiteM2mAccessToken(options) {
  return tokenProvider.getAccessToken(options);
}

export function invalidateNetSuiteM2mAccessToken() {
  tokenProvider.invalidate();
}
