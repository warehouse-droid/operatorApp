import crypto from "node:crypto";
import { config, requireConfig } from "./config.js";
import { query } from "./db.js";
import { assertSandboxNetSuiteEnvironment } from "./mbt/netsuite-readonly-adapter.js";
import { normalizeSalesOrderReconciliationType } from "./sales-order-reconciliation.js";
import { buildTransferDependencyUpdateRequest } from "./transfer-dependency-netsuite.js";

let suiteqlQueue = Promise.resolve();
let restMutationQueue = Promise.resolve();
let locationDirectoryCache = { key: "", expiresAt: 0, rows: [] };
let palletItemCache = { key: "", item: null };

const LOCATION_DIRECTORY_TTL_MS = 10 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertNetSuiteDirectAccessEnabled() {
  if (config.netsuite?.directAccessEnabled) return;
  const error = new Error("Direct NetSuite access is disabled on this application. NetSuite data is mirrored from the current server.");
  error.status = 409;
  throw error;
}

async function netsuiteFetch(url, options = {}) {
  const timeoutMs = Number(config.netsuite.requestTimeoutMs || 120000);
  const signal = options.signal || (AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  assertNetSuiteDirectAccessEnabled();
  try {
    return await fetch(url, { ...options, signal });
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      const timeoutError = new Error(
        `NetSuite request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
      );
      timeoutError.code = "NETSUITE_REQUEST_TIMEOUT";
      timeoutError.timeoutMs = timeoutMs;
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  }
}

const MBT_NETSUITE_READ_RESPONSE_LIMIT = 1024 * 1024;
const MBT_NETSUITE_READ_ACCEPT_TYPES = new Set([
  "application/json",
  "application/schema+json"
]);

function mbtNetSuiteRecordBaseUrl() {
  requireConfig(["netsuite.restBaseUrl", "netsuite.accountId"]);
  const configured = String(config.netsuite.restBaseUrl || "").replace(/\/+$/, "");
  const recordRoot = configured.endsWith("/record/v1")
    ? configured
    : `${configured}/record/v1`;
  const accountId = String(config.netsuite.accountId || "");
  const sandbox = assertSandboxNetSuiteEnvironment({
    directAccessEnabled: config.netsuite.directAccessEnabled === true,
    configuredAccountId: accountId,
    runtimeAccountId: accountId,
    sandboxAccountAllowlist: Array.isArray(config.netsuite.mbtSandboxAccountAllowlist)
      ? config.netsuite.mbtSandboxAccountAllowlist
      : [],
    restBaseUrl: recordRoot
  });
  return new URL(`${sandbox.restBaseUrl}/`);
}

function mbtNetSuiteReadTarget(path) {
  const base = mbtNetSuiteRecordBaseUrl();
  const target = new URL(String(path || ""), base);
  if (target.origin !== base.origin
      || !target.pathname.startsWith(base.pathname)
      || target.username
      || target.password
      || target.search
      || target.hash) {
    const error = new Error("The MBT NetSuite metadata path is outside the configured record service.");
    error.code = "MBT_NETSUITE_READ_PATH_REFUSED";
    error.status = 409;
    throw error;
  }
  return target;
}

async function getUnexpiredMbtNetSuiteAccessToken() {
  const result = await query(
    "SELECT access_token, expires_at FROM netsuite_tokens WHERE id = 1"
  );
  const token = result.rows[0];
  const accessToken = String(token?.access_token || "");
  const expiresAt = token?.expires_at ? new Date(token.expires_at).getTime() : 0;
  if (!accessToken || !expiresAt || expiresAt - Date.now() <= 120000) {
    const error = new Error("An unexpired stored NetSuite access token is required for MBT readiness.");
    error.code = "MBT_NETSUITE_TOKEN_UNAVAILABLE";
    error.status = 502;
    throw error;
  }
  return accessToken;
}

function mbtResponseTooLarge() {
  const error = new Error("NetSuite returned an oversized MBT readiness response.");
  error.code = "MBT_NETSUITE_RESPONSE_TOO_LARGE";
  error.status = 502;
  return error;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The connection is already closed or the stream is locked; the response
    // is rejected either way and no evidence is persisted.
  }
}

async function boundedMbtResponseText(response) {
  const declaredLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MBT_NETSUITE_READ_RESPONSE_LIMIT) {
    await cancelResponseBody(response);
    throw mbtResponseTooLarge();
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const fallback = await response.text();
    if (Buffer.byteLength(fallback, "utf8") > MBT_NETSUITE_READ_RESPONSE_LIMIT) {
      throw mbtResponseTooLarge();
    }
    return fallback;
  }
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > MBT_NETSUITE_READ_RESPONSE_LIMIT) {
      try {
        await reader.cancel();
      } catch {
        // Rejecting the response is authoritative even if cancellation races
        // the remote close.
      }
      throw mbtResponseTooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

/**
 * Narrow OAuth-backed transport for MBT readiness. It accepts one explicit
 * GET request shape and returns parsed response evidence; no generic NetSuite
 * request or write capability crosses the MBT boundary.
 *
 * @param {{method?: unknown, path?: unknown, signal?: AbortSignal, accept?: unknown}} request
 */
export async function netSuiteReadOnlyGetTransport({ method, path, signal, accept = "application/json" } = {}) {
  if (String(method || "").toUpperCase() !== "GET") {
    const error = new Error("MBT NetSuite readiness permits GET requests only.");
    error.code = "MBT_NETSUITE_READ_METHOD_REFUSED";
    error.status = 409;
    throw error;
  }
  const acceptedType = String(accept || "");
  if (!MBT_NETSUITE_READ_ACCEPT_TYPES.has(acceptedType)) {
    const error = new Error("MBT NetSuite readiness permits only approved JSON response types.");
    error.code = "MBT_NETSUITE_READ_ACCEPT_REFUSED";
    error.status = 409;
    throw error;
  }
  const target = mbtNetSuiteReadTarget(path);
  const accessToken = await getUnexpiredMbtNetSuiteAccessToken();
  const response = await netsuiteFetch(target, {
    method: "GET",
    redirect: "error",
    signal,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": acceptedType
    }
  });
  if (response.redirected) {
    const error = new Error("NetSuite redirected an MBT readiness metadata request.");
    error.code = "MBT_NETSUITE_REDIRECT_REFUSED";
    error.status = 502;
    throw error;
  }
  const text = await boundedMbtResponseText(response);
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "" },
    body,
    redirected: response.redirected === true,
    url: response.url
  };
}

function isConcurrencyLimit(status, text) {
  return status === 429
    || status === 503
    || /CONCURRENT_REQUEST_LIMIT_EXCEEDED|concurrent limit|exceeded.*request/i.test(text || "");
}

function openLineQuantitySql(alias = "tl") {
  return `(ABS(NVL(${alias}.quantity, 0)) - ABS(NVL(${alias}.quantityshiprecv, 0)))`;
}

function openLineFilterSql(alias = "tl") {
  return `${openLineQuantitySql(alias)} > 0.000001`;
}

const EXCLUDED_SALES_ORDER_PREFIXES = ["SOT"];

function excludedSalesOrderPrefixSql(alias = "t") {
  return EXCLUDED_SALES_ORDER_PREFIXES
    .map((prefix) => `AND UPPER(${alias}.tranid) NOT LIKE '${prefix}%'`)
    .join("\n  ");
}

function outboundStatusFilterSql(alias = "t") {
  return `(${alias}.status = 'B' OR BUILTIN.DF(${alias}.status) LIKE '%Pending Fulfillment%' OR BUILTIN.DF(${alias}.status) LIKE '%Partially Fulfilled%')`;
}

function receivingStatusFilterSql(alias = "t") {
  return `(BUILTIN.DF(${alias}.status) LIKE '%Pending Receipt%' OR BUILTIN.DF(${alias}.status) LIKE '%Partially Received%')`;
}

function purchaseReceivingStatusFilterSql(alias = "t") {
  return `(${alias}.status = 'B' OR ${receivingStatusFilterSql(alias)})`;
}

function deliveryOrderListQuery(locationId = 1) {
  const id = Number(locationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite location ID is required.");
  }

  return `
SELECT DISTINCT
  t.id,
  t.tranid,
  t.trandate,
  t.createddate AS datecreated,
  t.entity AS customer_id,
  BUILTIN.DF(t.entity) AS customer,
  t.status,
  BUILTIN.DF(t.status) AS status_text,
  t.custbody7 AS memo,
  t.custbody4 AS expected_delivery_date,
  t.foreigntotal,
  t.location AS order_location_id,
  BUILTIN.DF(t.location) AS order_location,
  tl.location AS outbound_location_id,
  BUILTIN.DF(tl.location) AS outbound_location,
  t.custbody3 AS delivery_method_id,
  BUILTIN.DF(t.custbody3) AS delivery_method
FROM transaction t
INNER JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type = 'SalesOrd'
  ${excludedSalesOrderPrefixSql("t")}
  AND tl.item IS NOT NULL
  AND tl.location = ${id}
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  AND ${outboundStatusFilterSql("t")}
  AND ${openLineFilterSql("tl")}
  AND t.custbody3 = 2
ORDER BY t.createddate DESC, t.tranid DESC
`;
}

function purchaseOrderListQuery(locationId = 1) {
  const id = Number(locationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite location ID is required.");
  }
  return `
SELECT DISTINCT
  t.id,
  t.tranid,
  t.trandate,
  t.createddate AS datecreated,
  t.entity AS vendor_id,
  BUILTIN.DF(t.entity) AS vendor,
  t.status,
  BUILTIN.DF(t.status) AS status_text,
  t.memo,
  COALESCE(NULLIF(BUILTIN.DF(v.defaultbillingaddress), ''), NULLIF(BUILTIN.DF(t.billingaddress), '')) AS vendor_address,
  t.foreigntotal,
  tl.location AS destination_location_id,
  BUILTIN.DF(tl.location) AS destination_location
FROM transaction t
INNER JOIN transactionline tl ON tl.transaction = t.id
LEFT JOIN vendor v ON v.id = t.entity
WHERE t.type = 'PurchOrd'
  AND tl.item IS NOT NULL
  AND tl.location = ${id}
  AND tl.mainline = 'F'
  AND (tl.taxline = 'F' OR tl.taxline IS NULL)
  AND ${purchaseReceivingStatusFilterSql("t")}
  AND ${openLineFilterSql("tl")}
ORDER BY t.trandate DESC, t.tranid DESC
`;
}

function transferOrderListQuery({ statusText, sourceLocationId = null, destinationLocationId = null, lineLocationId = null, lineDirection = "source" } = {}) {
  const sourceFilter = sourceLocationId ? `AND EXISTS (
    SELECT 1
      FROM transactionline source_tl
     WHERE source_tl.transaction = t.id
       AND source_tl.item IS NOT NULL
       AND source_tl.quantity < 0
       AND source_tl.location = ${Number(sourceLocationId)}
       AND source_tl.mainline = 'F'
       AND source_tl.taxline = 'F'
  )` : "";
  const destinationFilter = destinationLocationId ? `AND t.transferlocation = ${Number(destinationLocationId)}` : "";
  const lineLocationFilter = lineLocationId ? `AND tl.location = ${Number(lineLocationId)}` : "";
  const statusFilter = statusText === "Pending Fulfillment"
    ? `AND ${outboundStatusFilterSql("t")}`
    : `AND ${receivingStatusFilterSql("t")}`;
  const lineSignFilter = lineDirection === "destination" ? "AND tl.quantity > 0" : "AND tl.quantity < 0";
  return `
SELECT DISTINCT
  t.id,
  t.tranid,
  t.trandate,
  t.createddate AS datecreated,
  t.status,
  BUILTIN.DF(t.status) AS status_text,
  t.memo,
  t.location AS source_location_id,
  BUILTIN.DF(t.location) AS source_location,
  tl.location AS line_location_id,
  BUILTIN.DF(tl.location) AS line_location,
  t.transferlocation AS destination_location_id,
  BUILTIN.DF(t.transferlocation) AS destination_location
FROM transaction t
INNER JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type = 'TrnfrOrd'
  AND tl.item IS NOT NULL
  ${lineSignFilter}
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  ${statusFilter}
  AND ${openLineFilterSql("tl")}
  ${sourceFilter}
  ${destinationFilter}
  ${lineLocationFilter}
ORDER BY t.trandate DESC, t.tranid DESC
`;
}

async function inferTransferSourceFromLines(orderId, destinationLocationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const destinationFilter = destinationLocationId ? `AND tl.location <> ${Number(destinationLocationId)}` : "";
  const result = await suiteql(`
    SELECT DISTINCT
      tl.location AS source_location_id,
      BUILTIN.DF(tl.location) AS source_location
    FROM transactionline tl
    WHERE tl.transaction = ${id}
      AND tl.item IS NOT NULL
      AND tl.quantity < 0
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      ${destinationFilter}
    ORDER BY tl.location
  `);
  return result.items?.[0] || null;
}

async function hydrateTransferReceivingSource(order) {
  if (!order) return order;
  if (order.source_location_id && order.source_location) return order;
  const inferred = await inferTransferSourceFromLines(order.id, order.destination_location_id);
  if (!inferred?.source_location_id) return order;
  return {
    ...order,
    source_location_id: inferred.source_location_id,
    source_location: inferred.source_location,
    vendor_id: inferred.source_location_id,
    vendor: inferred.source_location
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Math.abs(Number(String(value).replaceAll(",", ""))) || 0;
}

function derivePackQuantitiesFromConversion(line) {
  if (toNumber(line.pallet_qty) || toNumber(line.layer_qty) || toNumber(line.section_qty) || toNumber(line.piece_qty)) {
    return { ...line, pack_quantity_source: line.pack_quantity_source || "netsuite_manual" };
  }
  if (!hasConversion(line)) return { ...line, pack_quantity_source: "sales_only" };
  let remaining = toNumber(line.quantity);
  const next = { ...line, pack_quantity_source: "item_conversion" };
  const conversions = [
    ["pallet_qty", "to_plt"],
    ["layer_qty", "to_lyr"],
    ["section_qty", "to_sec"],
    ["piece_qty", "to_pcs"]
  ];
  for (const [qtyField, conversionField] of conversions) {
    const conversion = toNumber(line[conversionField]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    if (units > 0) {
      next[qtyField] = units;
      remaining = Number((remaining - (units * conversion)).toFixed(6));
    }
  }
  return next;
}

function hasConversion(line) {
  return toNumber(line.to_plt) > 0
    || toNumber(line.to_lyr) > 0
    || toNumber(line.to_sec) > 0
    || toNumber(line.to_pcs) > 0;
}

function deriveQuantitiesFromSalesQuantity(line, quantity) {
  const hasManualPackQuantity = toNumber(line.pallet_qty) > 0
    || toNumber(line.layer_qty) > 0
    || toNumber(line.section_qty) > 0
    || toNumber(line.piece_qty) > 0;
  if (hasManualPackQuantity) {
    return {
      ...line,
      quantity,
      pack_quantity_source: "netsuite_manual"
    };
  }
  const next = {
    ...line,
    quantity,
    pallet_qty: 0,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: 0
  };
  if (!hasConversion(next)) return { ...next, pack_quantity_source: "sales_only" };
  return derivePackQuantitiesFromConversion(next);
}

function normalizeOpenDeliveryLine(line) {
  const orderedQuantity = toNumber(line.quantity);
  return deriveQuantitiesFromSalesQuantity(line, orderedQuantity);
}

function normalizeTransferDetailLines(lines, { sourceLocationId = null, destinationLocationId = null } = {}) {
  const filtered = lines.filter((line) => {
    const quantity = Number(String(line.quantity || 0).replaceAll(",", ""));
    if (sourceLocationId && String(line.location_id) === String(sourceLocationId)) return quantity < 0;
    if (destinationLocationId && String(line.location_id) === String(destinationLocationId)) return quantity > 0;
    return true;
  });

  const bestByDuplicateKey = new Map();
  for (const line of filtered) {
    const key = [
      line.item_id,
      line.location_id,
      toNumber(line.quantity),
      line.item_description || "",
      toNumber(line.pallet_qty),
      toNumber(line.layer_qty),
      toNumber(line.section_qty),
      toNumber(line.piece_qty)
    ].join("|");
    const current = bestByDuplicateKey.get(key);
    if (!current || toNumber(line.netsuite_received_qty) > toNumber(current.netsuite_received_qty)) {
      bestByDuplicateKey.set(key, line);
    }
  }

  return [...bestByDuplicateKey.values()]
    .map((line) => ({ ...line, quantity: toNumber(line.quantity) }))
    .map(normalizeOpenDeliveryLine)
    .filter((line) => toNumber(line.quantity) > 0)
    .map(derivePackQuantitiesFromConversion);
}

export function buildAuthorizationUrl() {
  assertNetSuiteDirectAccessEnabled();
  requireConfig([
    "netsuite.clientId",
    "netsuite.redirectUri",
    "netsuite.authUrl"
  ]);

  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL(config.netsuite.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.netsuite.clientId);
  url.searchParams.set("redirect_uri", config.netsuite.redirectUri);
  url.searchParams.set("scope", config.netsuite.scopes);
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

export async function exchangeCodeForToken(code) {
  requireConfig([
    "netsuite.clientId",
    "netsuite.clientSecret",
    "netsuite.redirectUri",
    "netsuite.tokenUrl"
  ]);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.netsuite.redirectUri
  });

  const response = await netsuiteFetch(config.netsuite.tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`NetSuite token exchange failed: ${response.status} ${await response.text()}`);
  }

  const token = await response.json();
  await saveToken(token);
  return token;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const response = await netsuiteFetch(config.netsuite.tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`NetSuite token refresh failed: ${response.status} ${await response.text()}`);
  }

  const token = await response.json();
  await saveToken({ ...token, refresh_token: token.refresh_token || refreshToken });
  return token.access_token;
}

async function getAccessToken() {
  const result = await query("SELECT * FROM netsuite_tokens WHERE id = 1");
  const token = result.rows[0];
  if (!token) throw new Error("NetSuite is not connected. Open /api/auth/netsuite/start first.");

  const expiresAt = token.expires_at ? new Date(token.expires_at).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() > 120000) return token.access_token;
  if (!token.refresh_token) return token.access_token;
  return refreshAccessToken(token.refresh_token);
}

async function saveToken(token) {
  const expiresAt = token.expires_in
    ? new Date(Date.now() + Number(token.expires_in) * 1000)
    : null;

  await query(
    `INSERT INTO netsuite_tokens
      (id, access_token, refresh_token, token_type, expires_at, scope, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, netsuite_tokens.refresh_token),
      token_type = EXCLUDED.token_type,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      updated_at = now()`,
    [token.access_token, token.refresh_token || null, token.token_type || null, expiresAt, token.scope || null]
  );
}

function basicAuth() {
  const credentials = `${config.netsuite.clientId}:${config.netsuite.clientSecret}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

async function netsuiteRest(path, { method = "GET", body = null, headers = {} } = {}) {
  requireConfig(["netsuite.restBaseUrl"]);
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const accessToken = await getAccessToken();
    const response = await netsuiteFetch(`${config.netsuite.restBaseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let data = text;
    if (text && (contentType.includes("application/json") || /^[\s\r\n]*[\[{]/.test(text))) {
      data = JSON.parse(text);
    }
    if (!response.ok) {
      lastError = new Error(`NetSuite REST failed: ${response.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
      lastError.status = response.status;
      lastError.netsuiteResponseReceived = true;
      if (isConcurrencyLimit(response.status, text) && attempt < 3) {
        await delay(2000 * (attempt + 1));
        continue;
      }
      throw lastError;
    }
    const location = response.headers.get("location") || "";
    const idMatch = location.match(/\/(?:itemFulfillment|itemReceipt|transferOrder|intercompanyTransferOrder|purchaseOrder|returnAuthorization|creditMemo)\/(\d+)/i);
    return { status: response.status, location, id: idMatch ? Number(idMatch[1]) : null, data };
  }
  throw lastError;
}

export async function transformSalesOrderToItemFulfillment(orderId, payload) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite sales order ID is required.");
  }
  const run = () => netsuiteRest(`/record/v1/salesorder/${id}/!transform/itemfulfillment`, {
    method: "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function transformTransferOrderToItemFulfillment(orderId, payload) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transfer order ID is required.");
  }
  const run = () => netsuiteRest(`/record/v1/transferorder/${id}/!transform/itemfulfillment`, {
    method: "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function transformPurchaseOrderToItemReceipt(orderId, payload) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite purchase order ID is required.");
  }
  const run = () => netsuiteRest(`/record/v1/purchaseorder/${id}/!transform/itemreceipt`, {
    method: "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function transformTransferOrderToItemReceipt(orderId, payload) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transfer order ID is required.");
  }
  const run = () => netsuiteRest(`/record/v1/transferorder/${id}/!transform/itemreceipt`, {
    method: "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function createTransferOrderInNetSuite(payload, { intercompany = false } = {}) {
  const recordType = intercompany ? "intercompanyTransferOrder" : "transferOrder";
  const run = () => netsuiteRest(`/record/v1/${recordType}`, {
    method: "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function updateTransferOrderInNetSuite(orderId, payload, { intercompany = false } = {}) {
  const request = buildTransferDependencyUpdateRequest({
    transferOrderId: orderId,
    intercompany,
    payload
  });
  const run = () => netsuiteRest(request.path, {
    method: request.method,
    body: request.payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function createPurchaseOrderInNetSuite(payload) {
  const run = () => netsuiteRest("/record/v1/purchaseOrder", {
    method: "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function createOrUpdateReturnAuthorizationInNetSuite({
  salesOrderId,
  returnAuthorizationId = null,
  payload
} = {}) {
  const existingId = Number(returnAuthorizationId);
  const sourceId = Number(salesOrderId);
  if ((!Number.isInteger(existingId) || existingId <= 0)
      && (!Number.isInteger(sourceId) || sourceId <= 0)) {
    throw new Error("A valid Sales Order or Return Authorization ID is required.");
  }
  const path = Number.isInteger(existingId) && existingId > 0
    ? `/record/v1/returnAuthorization/${existingId}?replace=item`
    : `/record/v1/salesOrder/${sourceId}/!transform/returnAuthorization?replace=item`;
  const run = () => netsuiteRest(path, {
    method: Number.isInteger(existingId) && existingId > 0 ? "PATCH" : "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function createOrUpdateCreditMemoInNetSuite({
  creditMemoId = null,
  payload
} = {}) {
  const existingId = Number(creditMemoId);
  const path = Number.isInteger(existingId) && existingId > 0
    ? `/record/v1/creditMemo/${existingId}?replace=item`
    : "/record/v1/creditMemo";
  const run = () => netsuiteRest(path, {
    method: Number.isInteger(existingId) && existingId > 0 ? "PATCH" : "POST",
    body: payload
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function fetchReturnAuthorizationFromNetSuite(returnAuthorizationId) {
  const id = Number(returnAuthorizationId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const result = await netsuiteRest(`/record/v1/returnAuthorization/${id}?expandSubResources=true`, { method: "GET" });
    return result.data || null;
  } catch (error) {
    if (String(error.message).includes("NetSuite REST failed: 404")) return null;
    throw error;
  }
}

export async function fetchCreditMemoFromNetSuite(creditMemoId) {
  const id = Number(creditMemoId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const result = await netsuiteRest(`/record/v1/creditMemo/${id}?expandSubResources=true`, { method: "GET" });
    return result.data || null;
  } catch (error) {
    if (String(error.message).includes("NetSuite REST failed: 404")) return null;
    throw error;
  }
}

export async function fetchCreditMemoMetadataFromNetSuite() {
  const result = await netsuiteRest("/metadata-catalog/record/v1/creditMemo?expandSubResources=true", {
    method: "GET",
    headers: { Accept: "application/schema+json" }
  });
  return result.data || null;
}

export async function fetchSalesOrderReturnLinesFromNetSuite(salesOrderId) {
  const id = Number(salesOrderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid Sales Order ID is required.");
  const result = await netsuiteRest(`/record/v1/salesOrder/${id}?expandSubResources=true`, {
    method: "GET"
  });
  const record = result.data || null;
  const items = record?.item?.items;
  if (!Array.isArray(items)) {
    throw new Error("NetSuite Sales Order item subresource was not expanded.");
  }
  return items;
}

export async function updateTransferOrderStatusInNetSuite(orderId, { intercompany = false, statusId = "B" } = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite transfer order ID is required.");
  const recordType = intercompany ? "intercompanyTransferOrder" : "transferOrder";
  const run = () => netsuiteRest(`/record/v1/${recordType}/${id}`, {
    method: "PATCH",
    body: { orderStatus: { id: String(statusId || "B") } }
  });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

function configuredPickingTicketRestletUrl() {
  const endpoint = String(config.smartScm?.pickingTicketRestletUrl || "").trim();
  if (!endpoint) throw new Error("SMART_SCM_PICKING_TICKET_RESTLET_URL is not configured.");
  return new URL(endpoint);
}

function parsedRestletPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
    if (typeof payload === "string") payload = JSON.parse(payload);
  } catch {
    return null;
  }
  return payload && typeof payload === "object" ? payload : null;
}

function restletErrorDetail(payload, text) {
  const code = String(payload?.error?.code || payload?.code || "").trim();
  const message = String(payload?.error?.message || payload?.message || "").trim();
  const combined = [code, message].filter(Boolean).join(": ");
  return combined || String(text || "").trim().slice(0, 2000) || "Unknown RESTlet error";
}

async function configuredRestletJson(params = {}) {
  const url = configuredPickingTicketRestletUrl();
  const request = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  const accessToken = await getAccessToken();
  const response = await netsuiteFetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });
  const text = await response.text();
  const payload = parsedRestletPayload(text);
  if (!response.ok) {
    throw new Error(`NetSuite RESTlet failed: ${response.status} ${restletErrorDetail(payload, text)}`);
  }
  if (!payload) throw new Error("NetSuite RESTlet returned an invalid JSON response.");
  if (payload.ok === false) throw new Error(`NetSuite RESTlet failed: ${restletErrorDetail(payload, text)}`);
  return payload;
}

export async function probeNetSuiteRestlet({
  entityId = null,
  locationId = null,
  requireSandbox = true
} = {}) {
  const hasEntity = entityId !== null && entityId !== undefined && String(entityId).trim() !== "";
  const entity = hasEntity ? Number(entityId) : null;
  const location = Number(locationId);
  if (hasEntity && (!Number.isSafeInteger(entity) || entity <= 0)) {
    throw new Error("A valid numeric NetSuite transaction ID is required for a picking-ticket probe.");
  }
  if (locationId !== null && locationId !== undefined && String(locationId).trim() !== ""
      && (!Number.isSafeInteger(location) || location <= 0)) {
    throw new Error("A valid numeric NetSuite location ID is required for a picking-ticket probe.");
  }
  const payload = await configuredRestletJson({
    action: hasEntity ? "pickingTicket" : "health",
    requireSandbox: requireSandbox ? "true" : "false",
    entityId: hasEntity ? entity : null,
    location: Number.isSafeInteger(location) && location > 0 ? location : null,
    includeContent: hasEntity ? "false" : null
  });
  if (payload.ok !== true) throw new Error("NetSuite RESTlet did not return ok=true.");
  if (requireSandbox && payload.sandbox !== true) {
    throw new Error(`NetSuite RESTlet reported ${payload.environment || "a non-sandbox environment"}; sandbox was required.`);
  }
  if (hasEntity && (payload.action !== "pickingTicket" || Number(payload.entityId) !== entity)) {
    throw new Error("NetSuite RESTlet picking-ticket probe returned the wrong transaction identity.");
  }
  return payload;
}

function verifiedPdfBuffer(contents, documentName = "PDF") {
  const buffer = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(String(contents || "").replace(/^data:application\/pdf;base64,/, ""), "base64");
  if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`NetSuite ${documentName} RESTlet returned invalid PDF content.`);
  }
  return buffer;
}

export async function fetchPickingTicketFromNetSuite(orderId, { locationId = null, filenamePrefix = "TO" } = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite transaction ID is required.");
  const location = Number(locationId);
  const requestedLocation = Number.isSafeInteger(location) && location > 0;
  const prefix = String(filenamePrefix || "transaction").trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "transaction";
  const url = configuredPickingTicketRestletUrl();
  const request = {
    action: "pickingTicket",
    entityId: id,
    includeContent: true
  };
  if (requestedLocation) request.location = location;
  const accessToken = await getAccessToken();
  const response = await netsuiteFetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/pdf, application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NetSuite picking ticket failed: ${response.status} ${restletErrorDetail(parsedRestletPayload(text), text)}`);
  }
  if (contentType.includes("application/pdf")) {
    return {
      buffer: verifiedPdfBuffer(Buffer.from(await response.arrayBuffer())),
      contentType: "application/pdf",
      filename: `${prefix}-${id}-picking-ticket.pdf`,
      locationApplied: false
    };
  }
  const text = await response.text();
  const payload = parsedRestletPayload(text);
  if (!payload) throw new Error("NetSuite picking-ticket RESTlet returned an invalid JSON response.");
  if (payload.ok === false) throw new Error(`NetSuite picking-ticket RESTlet failed: ${restletErrorDetail(payload, text)}`);
  if (payload.entityId !== undefined && Number(payload.entityId) !== id) {
    throw new Error("NetSuite picking-ticket RESTlet returned the wrong transaction identity.");
  }
  const base64 = payload.contentBase64 || payload.base64 || payload.contents || "";
  if (!base64) throw new Error("NetSuite picking-ticket RESTlet returned no PDF content.");
  return {
    buffer: verifiedPdfBuffer(base64),
    contentType: payload.contentType || "application/pdf",
    filename: `${prefix}-${id}-picking-ticket.pdf`,
    locationApplied: requestedLocation && payload.locationApplied === true && Number(payload.locationId) === location
  };
}

export async function fetchPurchaseOrderPdfFromNetSuite(orderId, { filenamePrefix = "PO" } = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite purchase order ID is required.");
  const prefix = String(filenamePrefix || "PO").trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "PO";
  const payload = await configuredRestletJson({
    action: "purchaseOrderPdf",
    entityId: id,
    includeContent: true
  });
  if (payload.action !== "purchaseOrderPdf" || Number(payload.entityId) !== id) {
    throw new Error("NetSuite purchase-order PDF RESTlet returned the wrong transaction identity.");
  }
  const base64 = payload.contentBase64 || payload.base64 || payload.contents || "";
  if (!base64) throw new Error("NetSuite purchase-order PDF RESTlet returned no PDF content.");
  return {
    buffer: verifiedPdfBuffer(base64, "purchase-order PDF"),
    contentType: payload.contentType || "application/pdf",
    filename: String(payload.filename || `${prefix}-${id}.pdf`).replace(/[^a-zA-Z0-9_.-]+/g, "-")
  };
}

export function buildPurchaseOrderHistoryRestPayload({ header = {}, lines = [] } = {}) {
  const payload = {};
  if (Object.prototype.hasOwnProperty.call(header, "transactionDate")) payload.tranDate = header.transactionDate;
  if (Object.prototype.hasOwnProperty.call(header, "expectedDeliveryDate")) payload.custbody4 = header.expectedDeliveryDate || null;
  if (Object.prototype.hasOwnProperty.call(header, "memo")) payload.memo = String(header.memo ?? "");
  if (Object.prototype.hasOwnProperty.call(header, "vendorReference")) payload.otherRefNum = String(header.vendorReference ?? "");
  if (lines.length) {
    payload.item = {
      items: lines.map((entry) => {
        const restLineId = Number(entry.restLineId);
        if (!Number.isInteger(restLineId) || restLineId <= 0) {
          const error = new Error(`Purchase-order line ${entry.lineId || ""} has no REST sublist key.`.trim());
          error.code = "NETSUITE_PO_REST_LINE_KEY_MISSING";
          error.status = 409;
          throw error;
        }
        const line = { line: restLineId };
        if (Object.prototype.hasOwnProperty.call(entry, "quantity")) line.quantity = Number(entry.quantity);
        if (entry.updatePalletColumn === true
          && Object.prototype.hasOwnProperty.call(entry, "palletQuantity")) {
          line.custcol_plt = Number(entry.palletQuantity);
        }
        if (Object.prototype.hasOwnProperty.call(entry, "rate")) line.rate = Number(entry.rate);
        if (Object.prototype.hasOwnProperty.call(entry, "locationId")) {
          line.location = { id: String(Number(entry.locationId)) };
        }
        return line;
      })
    };
  }
  return payload;
}

function comparableNetSuiteDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const instant = new Date(raw);
  if (!Number.isNaN(instant.getTime())) return instant.toISOString().slice(0, 10);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : raw.slice(0, 10);
}

export async function updatePurchaseOrderHistoryInNetSuite(orderId, {
  expectedLastModifiedAt,
  header = {},
  lines = []
} = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite purchase order ID is required.");
  const run = async () => {
    const current = await netsuiteRest(`/record/v1/purchaseOrder/${id}?expandSubResources=true`, { method: "GET" });
    const record = current.data && typeof current.data === "object" ? current.data : {};
    const expected = String(expectedLastModifiedAt || "").trim();
    if (expected && comparableNetSuiteDate(expected) !== comparableNetSuiteDate(record.lastModifiedDate)) {
      const error = new Error("This purchase order changed in NetSuite. Refresh and review the latest values before saving.");
      error.code = "MBBS_PO_VERSION_CONFLICT";
      error.status = 409;
      throw error;
    }
    const remoteLines = new Map((record.item?.items || []).map((line) => [Number(line.line), line]));
    for (const requested of lines) {
      const remote = remoteLines.get(Number(requested.restLineId));
      if (!remote) {
        const error = new Error(`Purchase-order line ${requested.lineId || requested.restLineId} no longer exists.`);
        error.status = 409;
        throw error;
      }
      if (requested.itemId && Number(remote.item?.id) !== Number(requested.itemId)) {
        const error = new Error(`Item identity on purchase-order line ${requested.lineId || requested.restLineId} changed in NetSuite.`);
        error.status = 409;
        throw error;
      }
    }
    const payload = buildPurchaseOrderHistoryRestPayload({ header, lines });
    const updated = await netsuiteRest(`/record/v1/purchaseOrder/${id}`, {
      method: "PATCH",
      body: payload
    });
    return {
      operation: "purchaseOrderUpdate",
      entityId: id,
      transport: "restRecord",
      status: updated.status,
      lastModifiedBefore: record.lastModifiedDate || null
    };
  };
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}

export async function resolvePalletItemFromNetSuite() {
  const key = `${config.netsuite.accountId || ""}|${config.netsuite.restBaseUrl || ""}`;
  if (palletItemCache.key === key && palletItemCache.item) return palletItemCache.item;
  const rows = await suiteqlAll(`
    SELECT i.id, i.itemid, BUILTIN.DF(i.stockunit) AS stock_unit,
           BUILTIN.DF(i.purchaseunit) AS purchase_unit,
           i.lastpurchaseprice AS last_purchase_price,
           i.weight AS item_weight
      FROM item i
     WHERE i.itemid = 'PALLET'
       AND i.isinactive = 'F'
     ORDER BY i.id
  `);
  if (rows.length !== 1) {
    throw new Error(rows.length
      ? "More than one active NetSuite item is named exactly PALLET. Resolve the duplicate before creating Transfer Orders."
      : "The active NetSuite account has no active item named exactly PALLET.");
  }
  const row = rows[0];
  const id = Number(row.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error("NetSuite returned an invalid PALLET item ID.");
  palletItemCache = {
    key,
    item: {
      id,
      itemId: id,
      itemName: String(row.itemid || "PALLET"),
      unit: String(row.stock_unit || "EACH"),
      purchaseUnit: String(row.purchase_unit || row.stock_unit || "EACH"),
      itemWeightLbs: row.item_weight === null || row.item_weight === undefined
        ? null
        : Number(row.item_weight),
      lastPurchasePrice: row.last_purchase_price === null || row.last_purchase_price === undefined
        ? null
        : Number(row.last_purchase_price)
    }
  };
  return palletItemCache.item;
}

export async function fetchItemFulfillmentFromNetSuite(itemFulfillmentId) {
  const id = Number(itemFulfillmentId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const result = await netsuiteRest(`/record/v1/itemFulfillment/${id}`, { method: "GET" });
    return result.data || null;
  } catch (error) {
    if (String(error.message).includes("NetSuite REST failed: 404")) return null;
    throw error;
  }
}

export async function fetchItemReceiptFromNetSuite(itemReceiptId) {
  const id = Number(itemReceiptId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const result = await netsuiteRest(`/record/v1/itemReceipt/${id}`, { method: "GET" });
    return result.data || null;
  } catch (error) {
    if (String(error.message).includes("NetSuite REST failed: 404")) return null;
    throw error;
  }
}

export async function suiteql(q, params = [], options = {}) {
  const run = () => runSuiteql(q, params, options);
  const result = suiteqlQueue.then(run, run);
  suiteqlQueue = result.catch(() => {});
  return result;
}

async function runSuiteql(q, params = [], options = {}) {
  requireConfig(["netsuite.restBaseUrl"]);
  const accessToken = await getAccessToken();
  const body = params.length ? { q, params } : { q };
  const url = new URL(`${config.netsuite.restBaseUrl}/query/v1/suiteql`);
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (options.offset) url.searchParams.set("offset", String(options.offset));
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await netsuiteFetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Prefer": "transient"
      },
      body: JSON.stringify(body)
    });
    if (response.status !== 429) break;
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    await new Promise((resolve) => setTimeout(resolve, retryAfter ? retryAfter * 1000 : 2000 * (attempt + 1)));
  }

  if (!response.ok) {
    throw new Error(`NetSuite SuiteQL failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

export async function suiteqlAll(q, params = [], { pageSize = 1000 } = {}) {
  const items = [];
  let offset = 0;
  while (true) {
    const result = await suiteql(q, params, { limit: pageSize, offset });
    items.push(...(result.items || []));
    if (!result.hasMore) return items;
    offset += result.count || pageSize;
  }
}

export async function fetchTransactionReferenceByTranidFromNetSuite(tranid, recordType) {
  const orderRef = String(tranid || "").trim().toUpperCase();
  const allowedTypes = new Set(["SalesOrd", "PurchOrd", "TrnfrOrd"]);
  if (!orderRef || orderRef.length > 64 || !/^[A-Z0-9_-]+$/.test(orderRef)) {
    throw new Error("A valid NetSuite transaction number is required.");
  }
  if (!allowedTypes.has(recordType)) throw new Error("A valid NetSuite transaction type is required.");
  const result = await suiteql(`
    SELECT
      t.id,
      t.tranid,
      t.status,
      BUILTIN.DF(t.status) AS status_text
    FROM transaction t
    WHERE UPPER(t.tranid) = '${orderRef}'
      AND t.type = '${recordType}'
    ORDER BY t.id DESC
    FETCH FIRST 2 ROWS ONLY
  `);
  if ((result.items || []).length > 1) {
    throw new Error(`More than one ${recordType} transaction uses order number ${orderRef}.`);
  }
  return result.items?.[0] || null;
}

export async function fetchDeliveryOrdersFromNetSuite(locationId = 1) {
  return suiteqlAll(deliveryOrderListQuery(locationId));
}

export async function fetchSovPendingFulfillmentOrdersFromNetSuite() {
  return suiteqlAll(`
SELECT DISTINCT
  t.id,
  t.tranid,
  t.trandate,
  t.createddate AS datecreated,
  t.entity AS customer_id,
  BUILTIN.DF(t.entity) AS customer,
  t.status,
  BUILTIN.DF(t.status) AS status_text,
  t.custbody7 AS memo,
  t.custbody4 AS expected_delivery_date,
  t.foreigntotal,
  t.location AS order_location_id,
  BUILTIN.DF(t.location) AS order_location,
  tl.location AS outbound_location_id,
  BUILTIN.DF(tl.location) AS outbound_location,
  t.custbody3 AS delivery_method_id,
  BUILTIN.DF(t.custbody3) AS delivery_method
FROM transaction t
INNER JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type = 'SalesOrd'
  AND UPPER(t.tranid) LIKE 'SOV%'
  AND tl.item IS NOT NULL
  AND tl.location IS NOT NULL
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  AND ${outboundStatusFilterSql("t")}
  AND ${openLineFilterSql("tl")}
  AND t.custbody3 = 2
ORDER BY t.createddate DESC, t.tranid DESC
`);
}

export async function fetchTransferDeliveryOrdersFromNetSuite(locationId = 1) {
  const result = await suiteqlAll(transferOrderListQuery({ statusText: "Pending Fulfillment", lineLocationId: locationId }));
  return result.map((order) => ({
    ...order,
    order_type: "transfer_order",
    customer_id: order.destination_location_id,
    customer: `Transfer to ${order.destination_location || ""}`.trim(),
    order_location_id: order.destination_location_id,
    order_location: order.destination_location,
    source_location_id: order.line_location_id || order.source_location_id,
    source_location: order.line_location || order.source_location,
    outbound_location_id: order.line_location_id || order.source_location_id,
    outbound_location: order.line_location || order.source_location,
    delivery_method_id: null,
    delivery_method: "Transfer Order"
  }));
}

export async function fetchSalesOrderReferenceFromNetSuite(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite sales order ID is required.");
  const result = await suiteql(`
    SELECT
      t.id,
      t.tranid,
      t.trandate,
      t.entity AS customer_id,
      BUILTIN.DF(t.entity) AS customer,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.custbody7 AS memo,
      t.custbody4 AS expected_delivery_date,
      t.foreigntotal,
      t.location AS order_location_id,
      BUILTIN.DF(t.location) AS order_location,
      tl.location AS outbound_location_id,
      BUILTIN.DF(tl.location) AS outbound_location,
      t.custbody3 AS delivery_method_id,
      BUILTIN.DF(t.custbody3) AS delivery_method
    FROM transaction t
    LEFT JOIN transactionline tl
      ON tl.transaction = t.id
     AND tl.item IS NOT NULL
     AND tl.mainline = 'F'
     AND tl.taxline = 'F'
    WHERE t.id = ${id}
      AND t.type = 'SalesOrd'
      ${excludedSalesOrderPrefixSql("t")}
    ORDER BY tl.uniquekey
    FETCH FIRST 1 ROWS ONLY
  `);
  return result.items?.[0] || null;
}

export async function fetchDeliveryOrderFromNetSuite(orderId, locationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite sales order ID is required.");
  }
  const locationFilter = locationId ? `AND tl.location = ${Number(locationId)}` : "";

  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.trandate,
      t.entity AS customer_id,
      BUILTIN.DF(t.entity) AS customer,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.custbody7 AS memo,
      t.custbody4 AS expected_delivery_date,
      t.foreigntotal,
      t.location AS order_location_id,
      BUILTIN.DF(t.location) AS order_location,
      tl.location AS outbound_location_id,
      BUILTIN.DF(tl.location) AS outbound_location,
      t.custbody3 AS delivery_method_id,
      BUILTIN.DF(t.custbody3) AS delivery_method
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    WHERE t.id = ${id}
      AND t.type = 'SalesOrd'
      ${excludedSalesOrderPrefixSql("t")}
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND ${outboundStatusFilterSql("t")}
      AND ${openLineFilterSql("tl")}
      ${locationFilter}
    ORDER BY t.trandate DESC
  `);

  return result.items?.[0] || null;
}

export async function fetchCustomerPickupOrderFromNetSuite(code, locationId = null) {
  const text = String(code || "").trim();
  if (!text) throw new Error("Sales order number is required.");
  const locationFilter = locationId ? `AND tl.location = ${Number(locationId)}` : "";
  const orderFilter = /^\d+$/.test(text)
    ? `t.id = ${Number(text)}`
    : `UPPER(t.tranid) = '${text.replaceAll("'", "''").toUpperCase()}'`;

  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.trandate,
      t.createddate AS datecreated,
      t.entity AS customer_id,
      BUILTIN.DF(t.entity) AS customer,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.custbody7 AS memo,
      t.custbody4 AS expected_delivery_date,
      t.foreigntotal,
      t.location AS order_location_id,
      BUILTIN.DF(t.location) AS order_location,
      tl.location AS outbound_location_id,
      BUILTIN.DF(tl.location) AS outbound_location,
      t.custbody3 AS delivery_method_id,
      BUILTIN.DF(t.custbody3) AS delivery_method
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    WHERE ${orderFilter}
      AND t.type = 'SalesOrd'
      ${excludedSalesOrderPrefixSql("t")}
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      ${locationFilter}
      AND BUILTIN.DF(t.custbody3) = 'Pick-Up'
      AND ${openLineFilterSql("tl")}
    ORDER BY t.createddate DESC, t.tranid DESC
  `);
  return result.items?.[0] ? { ...result.items[0], order_type: "sales_order" } : null;
}

export async function fetchTransactionStatusFromNetSuite(orderId, recordType = "SalesOrd") {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transaction ID is required.");
  }
  const allowed = new Set(["SalesOrd", "PurchOrd", "TrnfrOrd"]);
  const type = allowed.has(recordType) ? recordType : "SalesOrd";
  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.custbody4 AS expected_delivery_date,
      t.lastmodifieddate
    FROM transaction t
    WHERE t.id = ${id}
      AND t.type = '${type}'
  `);
  return result.items?.[0] || null;
}

export async function fetchTransactionProgressFromNetSuite(orderId, recordType = "SalesOrd") {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transaction ID is required.");
  }
  const allowed = new Set(["SalesOrd", "PurchOrd", "TrnfrOrd"]);
  const type = allowed.has(recordType) ? recordType : "SalesOrd";
  const taxFilter = type === "PurchOrd" ? "(tl.taxline = 'F' OR tl.taxline IS NULL)" : "tl.taxline = 'F'";
  const result = await suiteql(`
    SELECT
      t.id,
      t.tranid,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.trandate,
      t.location AS source_location_id,
      BUILTIN.DF(t.location) AS source_location,
      t.transferlocation AS destination_location_id,
      BUILTIN.DF(t.transferlocation) AS destination_location,
      tl.uniquekey AS line_id,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      tl.memo AS item_description,
      tl.quantity,
      tl.quantityshiprecv AS netsuite_received_qty,
      BUILTIN.DF(tl.units) AS unit,
      i.weight AS item_weight,
      tl.location AS location_id,
      BUILTIN.DF(tl.location) AS location,
      tl.custcol_plt AS pallet_qty,
      tl.custcol_lyr AS layer_qty,
      tl.custcol_pcs AS piece_qty,
      tl.custcol_sec AS section_qty,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    LEFT JOIN item i ON i.id = tl.item
    WHERE t.id = ${id}
      AND t.type = '${type}'
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND ${taxFilter}
    ORDER BY tl.uniquekey
  `);
  const rows = result.items || [];
  if (!rows.length) {
    const status = await fetchTransactionStatusFromNetSuite(id, type);
    return status ? { ...status, record_type: type, lines: [] } : null;
  }
  const first = rows[0];
  return {
    id: first.id,
    tranid: first.tranid,
    status: first.status,
    status_text: first.status_text,
    trandate: first.trandate,
    source_location_id: first.source_location_id,
    source_location: first.source_location,
    destination_location_id: first.destination_location_id,
    destination_location: first.destination_location,
    record_type: type,
    lines: rows.map((line) => deriveQuantitiesFromSalesQuantity(line, toNumber(line.quantity)))
  };
}

function positiveNetSuiteIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function reconciliationSourceFilter({
  orderIds = [],
  kind = "",
  modifiedSince = "2026-01-01",
  includeOpen = true,
  targetOnly = false,
  includeSalesOrders = true,
  soOrderType = "all"
} = {}) {
  const ids = positiveNetSuiteIds(orderIds);
  const cleanKind = String(kind || "").trim().toUpperCase();
  const cleanSoOrderType = normalizeSalesOrderReconciliationType(soOrderType, "all");
  if (!cleanSoOrderType) {
    throw Object.assign(
      new Error("Select Delivery or Pick-Up for Sales Order reconciliation."),
      { status: 400 }
    );
  }
  const types = cleanKind === "SO"
    ? ["SalesOrd"]
    : cleanKind === "PO"
      ? ["PurchOrd"]
      : cleanKind === "TO"
        ? ["TrnfrOrd"]
        : includeSalesOrders === false
          ? ["PurchOrd", "TrnfrOrd"]
          : ["SalesOrd", "PurchOrd", "TrnfrOrd"];
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(modifiedSince || ""))
    ? String(modifiedSince)
    : "2026-01-01";
  const discovery = targetOnly && ids.length
    ? [`t.id IN (${ids.join(",")})`]
    : [
      `t.lastmodifieddate >= TO_DATE('${since}', 'YYYY-MM-DD')`,
      ...(ids.length ? [`t.id IN (${ids.join(",")})`] : []),
      ...(includeOpen ? [
        `UPPER(NVL(BUILTIN.DF(t.status), '')) LIKE '%PENDING%'`,
        `UPPER(NVL(BUILTIN.DF(t.status), '')) LIKE '%PARTIALLY%'`
      ] : [])
    ];
  const salesOrderTypeFilter = types.includes("SalesOrd")
    && ["delivery", "pickup"].includes(cleanSoOrderType)
    ? `AND (
        t.type <> 'SalesOrd'
        ${ids.length && !targetOnly ? `OR t.id IN (${ids.join(",")})` : ""}
        OR UPPER(TRIM(NVL(BUILTIN.DF(t.custbody3), ''))) = '${cleanSoOrderType === "delivery" ? "DELIVERY" : "PICK-UP"}'
      )`
    : "";
  return {
    ids,
    types,
    sql: `t.type IN (${types.map((type) => `'${type}'`).join(",")})
      ${types.includes("SalesOrd") ? excludedSalesOrderPrefixSql("t") : ""}
      ${salesOrderTypeFilter}
      AND (${discovery.join("\n        OR ")})`
  };
}

function reconciliationIdentityNumber(value) {
  const number = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(number) ? String(number) : "0";
}

function reconciliationLineAlias(value) {
  const alias = String(value ?? "").trim();
  return alias && alias !== "0" && alias.toLowerCase() !== "null" ? alias : "";
}

function reconciliationAliasSort(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

function reconciliationMirrorSignature(line, { includeProgress = false } = {}) {
  return [
    line.stage,
    line.itemId ?? "",
    reconciliationIdentityNumber(line.signedQuantity),
    reconciliationIdentityNumber(line.quantity),
    line.unit || "",
    line.locationId ?? "",
    line.itemDescription || "",
    line.itemType || "",
    reconciliationIdentityNumber(line.itemWeight),
    reconciliationIdentityNumber(line.palletQty),
    reconciliationIdentityNumber(line.layerQty),
    reconciliationIdentityNumber(line.sectionQty),
    reconciliationIdentityNumber(line.pieceQty),
    reconciliationIdentityNumber(line.toPlt),
    reconciliationIdentityNumber(line.toLyr),
    reconciliationIdentityNumber(line.toSec),
    reconciliationIdentityNumber(line.toPcs),
    ...(includeProgress
      ? [reconciliationIdentityNumber(line.cumulativeProgressQuantity)]
      : [])
  ].join("|");
}

function reconciliationTransferBaseSignature(line) {
  return [
    line.itemId ?? "",
    reconciliationIdentityNumber(line.quantity),
    String(line.unit || "").trim().toUpperCase()
  ].join("|");
}

function reconciliationBoolean(value) {
  if (value === true || value === 1) return true;
  return ["T", "TRUE", "1", "Y", "YES"].includes(String(value ?? "").trim().toUpperCase());
}

function reconciliationLineSort(left, right) {
  const leftSequence = Number(left.lineSequenceNumber);
  const rightSequence = Number(right.lineSequenceNumber);
  if (
    Number.isFinite(leftSequence)
    && Number.isFinite(rightSequence)
    && leftSequence !== rightSequence
  ) {
    return leftSequence - rightSequence;
  }
  const leftOrderLine = reconciliationLineAlias(left.orderLine);
  const rightOrderLine = reconciliationLineAlias(right.orderLine);
  const orderLineDifference = reconciliationAliasSort(leftOrderLine, rightOrderLine);
  if (orderLineDifference) return orderLineDifference;
  return reconciliationAliasSort(
    reconciliationLineAlias(left.sourceLineKey),
    reconciliationLineAlias(right.sourceLineKey)
  );
}

function collapseTransferMirrorRows(rows, {
  identityStatus,
  identityIssue = "",
  mirrorSignature,
  occurrence,
  logicalLineIdentity = ""
}) {
  const sorted = [...rows].sort(reconciliationLineSort);
  const aliases = [...new Set(sorted
    .map((line) => reconciliationLineAlias(line.sourceLineKey))
    .filter(Boolean))]
    .sort(reconciliationAliasSort);
  const orderLineAliases = [...new Set(sorted
    .map((line) => reconciliationLineAlias(line.orderLine))
    .filter(Boolean))]
    .sort(reconciliationAliasSort);
  const base = sorted.reduce(
    (best, line) =>
      toNumber(line.cumulativeProgressQuantity) > toNumber(best.cumulativeProgressQuantity)
        ? line
        : best,
    sorted[0]
  );
  const canonicalKey = aliases[0] || orderLineAliases[0] || "";
  const canonicalOrderLine = orderLineAliases[0] || reconciliationLineAlias(base.orderLine);
  return {
    ...base,
    sourceLineKey: canonicalKey,
    orderLine: Number(canonicalOrderLine) || canonicalOrderLine,
    sourceLineAliases: aliases,
    orderLineAliases,
    identityStatus,
    identityIssue,
    mirrorRowCount: sorted.length,
    mirrorSignature,
    mirrorOccurrence: occurrence,
    logicalLineIdentity: logicalLineIdentity || (
      orderLineAliases.length === 1
        ? `order-line:${orderLineAliases[0]}`
        : `mirror:${mirrorSignature}:${occurrence}`
    ),
    cumulativeProgressQuantity: Math.max(
      ...sorted.map((line) => toNumber(line.cumulativeProgressQuantity))
    ),
    cumulativeProgressObserved: sorted.some((line) =>
      line.cumulativeProgressObserved !== false
    ),
    raw: {
      ...(base.raw && typeof base.raw === "object" ? base.raw : {}),
      sourceLineAliases: aliases,
      orderLineAliases,
      identityStatus,
      identityIssue,
      mirrorRowCount: sorted.length,
      physicalRows: sorted.map((line) => line.raw || line)
    }
  };
}

function normalizeLegacyTransferMirrorRows(lines = []) {
  const buckets = new Map();
  for (const line of lines || []) {
    const signature = reconciliationMirrorSignature(line);
    if (!buckets.has(signature)) buckets.set(signature, []);
    buckets.get(signature).push(line);
  }

  const normalized = [];
  for (const [signature, bucket] of buckets) {
    const byOrderLine = new Map();
    for (const line of bucket) {
      const orderLine = reconciliationLineAlias(line.orderLine);
      if (!byOrderLine.has(orderLine)) byOrderLine.set(orderLine, []);
      byOrderLine.get(orderLine).push(line);
    }

    const unresolved = [];
    let occurrence = 0;
    for (const [orderLine, candidates] of byOrderLine) {
      if (
        orderLine
        && candidates.length === 2
        && reconciliationMirrorSignature(candidates[0], { includeProgress: true })
          === reconciliationMirrorSignature(candidates[1], { includeProgress: true })
      ) {
        normalized.push(collapseTransferMirrorRows(candidates, {
          identityStatus: "exact",
          mirrorSignature: signature,
          occurrence
        }));
        occurrence += 1;
      } else {
        unresolved.push(...candidates);
      }
    }

    unresolved.sort(reconciliationLineSort);
    for (let index = 0; index < unresolved.length; index += 2) {
      const pair = unresolved.slice(index, index + 2);
      const isPair = pair.length === 2;
      const duplicateOrderLine = isPair
        && reconciliationLineAlias(pair[0].orderLine)
        && reconciliationLineAlias(pair[0].orderLine) === reconciliationLineAlias(pair[1].orderLine);
      normalized.push(collapseTransferMirrorRows(pair, {
        identityStatus: "ambiguous",
        identityIssue: isPair
          ? duplicateOrderLine
            ? "Transfer mirror rows share a line number but disagree on progress or line attributes."
            : "Transfer mirror rows were paired by equal line values because NetSuite did not expose a shared line number."
          : "A Transfer Order row has no exact physical/accounting mirror partner.",
        mirrorSignature: signature,
        occurrence
      }));
      occurrence += 1;
    }
  }
  return normalized;
}

/**
 * This NetSuite account exposes each logical TO item as a visible source row,
 * a hidden source-progress row, and a hidden destination-progress row. Their
 * line IDs are intentionally different. Use the visible row as the logical
 * anchor, then align equal immutable item buckets by line-sequence occurrence.
 * This retains repeated identical item lines without treating normal accounting
 * rows as extra ordered quantity.
 */
export function normalizePoToReconciliationLines(lines = [], kind = "") {
  const cleanKind = String(kind || "").trim().toUpperCase();
  if (cleanKind !== "TO") {
    return (lines || []).map((line) => {
      const sourceLineKey = reconciliationLineAlias(line.sourceLineKey || line.orderLine);
      const orderLine = reconciliationLineAlias(line.orderLine);
      return {
        ...line,
        sourceLineKey,
        sourceLineAliases: sourceLineKey ? [sourceLineKey] : [],
        orderLineAliases: orderLine ? [orderLine] : [],
        identityStatus: sourceLineKey ? "exact" : "missing",
        identityIssue: sourceLineKey ? "" : "NetSuite did not return a unique source-line key.",
        mirrorRowCount: 1,
        logicalLineIdentity: orderLine ? `order-line:${orderLine}` : `source-line:${sourceLineKey}`
      };
    });
  }

  const hasTransferRoles = (lines || []).some((line) =>
    line.doNotPrintLine !== undefined && line.doNotPrintLine !== null
  );
  if (!hasTransferRoles) {
    return normalizeLegacyTransferMirrorRows(lines).sort((left, right) => {
      const stageDifference = (left.stage === "outbound" ? 0 : 1) - (right.stage === "outbound" ? 0 : 1);
      return stageDifference || reconciliationLineSort(left, right);
    });
  }

  const buckets = new Map();
  for (const line of lines || []) {
    const signature = reconciliationTransferBaseSignature(line);
    if (!buckets.has(signature)) buckets.set(signature, []);
    buckets.get(signature).push(line);
  }
  const normalized = [];
  for (const [signature, bucket] of buckets) {
    const visibleSource = bucket
      .filter((line) => line.stage === "outbound" && !reconciliationBoolean(line.doNotPrintLine))
      .sort(reconciliationLineSort);
    const hiddenSource = bucket
      .filter((line) => line.stage === "outbound" && reconciliationBoolean(line.doNotPrintLine))
      .sort(reconciliationLineSort);
    const destination = bucket
      .filter((line) => line.stage === "receiving")
      .sort(reconciliationLineSort);
    if (!visibleSource.length) {
      normalized.push(...normalizeLegacyTransferMirrorRows(bucket).map((line) => ({
        ...line,
        identityStatus: "ambiguous",
        identityIssue: line.identityIssue
          || "Transfer rows could not be assigned to a visible source-line anchor."
      })));
      continue;
    }

    const aligned = visibleSource.length === hiddenSource.length
      && visibleSource.length === destination.length;
    for (let occurrence = 0; occurrence < visibleSource.length; occurrence += 1) {
      const anchor = visibleSource[occurrence];
      const sourceProgress = hiddenSource[occurrence];
      const receipt = destination[occurrence];
      const anchorIdentity = reconciliationLineAlias(anchor.sourceLineKey || anchor.orderLine);
      const logicalLineIdentity = `transfer-anchor:${anchorIdentity || `${signature}:${occurrence}`}`;
      const identityStatus = aligned && sourceProgress && receipt ? "exact" : "ambiguous";
      const identityIssue = identityStatus === "exact"
        ? ""
        : "Transfer accounting rows could not be aligned one-to-one with the visible source line.";
      normalized.push(collapseTransferMirrorRows(
        [anchor, sourceProgress].filter(Boolean),
        {
          identityStatus,
          identityIssue,
          mirrorSignature: signature,
          occurrence,
          logicalLineIdentity
        }
      ));
      if (receipt) {
        normalized.push(collapseTransferMirrorRows([receipt], {
          identityStatus,
          identityIssue,
          mirrorSignature: signature,
          occurrence,
          logicalLineIdentity
        }));
      }
    }

    // Extra hidden accounting rows are evidence of an identity problem, not
    // additional logical order lines. `aligned` already marks every anchored
    // line in this bucket ambiguous, so dropping extras prevents double-counting.
  }

  return normalized.sort((left, right) => {
    const stageDifference = (left.stage === "outbound" ? 0 : 1) - (right.stage === "outbound" ? 0 : 1);
    return stageDifference || reconciliationLineSort(left, right);
  });
}

async function fetchScmReconciliationOrdersBatch(options = {}) {
  const filter = reconciliationSourceFilter(options);
  const rows = await suiteqlAll(`
    SELECT
      t.id,
      t.type AS record_type,
      t.tranid,
      t.trandate,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.lastmodifieddate,
      t.entity AS entity_id,
      BUILTIN.DF(t.entity) AS entity,
      t.memo,
      t.foreigntotal,
      t.custbody4 AS expected_delivery_date,
      t.location AS order_location_id,
      BUILTIN.DF(t.location) AS order_location,
      t.custbody3 AS delivery_method_id,
      BUILTIN.DF(t.custbody3) AS delivery_method,
      CASE
        WHEN t.type = 'TrnfrOrd' THEN t.location
        WHEN t.type = 'SalesOrd' THEN NVL(tl.location, t.location)
        ELSE NULL
      END AS source_location_id,
      CASE
        WHEN t.type = 'TrnfrOrd' THEN BUILTIN.DF(t.location)
        WHEN t.type = 'SalesOrd' THEN NVL(BUILTIN.DF(tl.location), BUILTIN.DF(t.location))
        ELSE BUILTIN.DF(t.entity)
      END AS source_location,
      CASE
        WHEN t.type = 'TrnfrOrd' THEN t.transferlocation
        WHEN t.type = 'PurchOrd' THEN tl.location
        ELSE NULL
      END AS destination_location_id,
      CASE
        WHEN t.type = 'TrnfrOrd' THEN BUILTIN.DF(t.transferlocation)
        WHEN t.type = 'PurchOrd' THEN BUILTIN.DF(tl.location)
        ELSE NULL
      END AS destination_location,
      tl.id AS order_line_number,
      tl.uniquekey AS source_line_key,
      tl.donotprintline AS do_not_print_line,
      tl.linesequencenumber AS line_sequence_number,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      tl.memo AS item_description,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      tl.quantity AS signed_quantity,
      ABS(NVL(tl.quantity, 0)) AS ordered_quantity,
      tl.quantityshiprecv AS cumulative_progress_raw,
      ABS(NVL(tl.quantityshiprecv, 0)) AS cumulative_progress_quantity,
      BUILTIN.DF(tl.units) AS unit,
      tl.location AS line_location_id,
      BUILTIN.DF(tl.location) AS line_location,
      i.weight AS item_weight,
      tl.custcol_plt AS pallet_qty,
      tl.custcol_lyr AS layer_qty,
      tl.custcol_pcs AS piece_qty,
      tl.custcol_sec AS section_qty,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    LEFT JOIN item i ON i.id = tl.item
    WHERE ${filter.sql}
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND (tl.taxline = 'F' OR tl.taxline IS NULL)
    ORDER BY t.id, tl.id, tl.uniquekey
  `);
  const orders = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    const kind = String(row.record_type) === "SalesOrd"
      ? "SO"
      : String(row.record_type) === "PurchOrd"
        ? "PO"
        : "TO";
    if (!orders.has(id)) {
      orders.set(id, {
        id,
        kind,
        recordType: row.record_type,
        tranid: row.tranid || "",
        trandate: row.trandate || null,
        status: row.status || "",
        statusText: row.status_text || "",
        lastModifiedAt: row.lastmodifieddate || null,
        entityId: Number(row.entity_id) || null,
        entity: row.entity || "",
        memo: row.memo || "",
        foreignTotal: row.foreigntotal === null || row.foreigntotal === undefined ? null : Number(row.foreigntotal),
        expectedDeliveryDate: row.expected_delivery_date || null,
        orderLocationId: Number(row.order_location_id) || null,
        orderLocation: row.order_location || "",
        deliveryMethodId: Number(row.delivery_method_id) || null,
        deliveryMethod: row.delivery_method || "",
        sourceLocationId: Number(row.source_location_id) || null,
        sourceLocation: row.source_location || "",
        destinationLocationId: Number(row.destination_location_id) || null,
        destinationLocation: row.destination_location || "",
        lines: []
      });
    }
    const signedQuantity = Number(String(row.signed_quantity || 0).replaceAll(",", "")) || 0;
    orders.get(id).lines.push({
      sourceLineKey: String(row.source_line_key || row.order_line_number || ""),
      orderLine: Number(row.order_line_number),
      doNotPrintLine: row.do_not_print_line,
      lineSequenceNumber: Number(row.line_sequence_number),
      stage: kind === "PO" ? "receiving" : kind === "SO" ? "outbound" : signedQuantity < 0 ? "outbound" : "receiving",
      itemId: Number(row.item_id) || null,
      itemName: row.item_name || "",
      itemDescription: row.item_description || "",
      itemType: row.item_type || "",
      itemTypeText: row.item_type_text || "",
      signedQuantity,
      quantity: toNumber(row.ordered_quantity),
      cumulativeProgressQuantity: toNumber(row.cumulative_progress_quantity),
      cumulativeProgressObserved: row.cumulative_progress_raw !== null
        && row.cumulative_progress_raw !== undefined
        && row.cumulative_progress_raw !== "",
      unit: row.unit || "",
      locationId: Number(row.line_location_id) || null,
      location: row.line_location || "",
      itemWeight: row.item_weight === null || row.item_weight === undefined ? null : Number(row.item_weight),
      palletQty: toNumber(row.pallet_qty),
      layerQty: toNumber(row.layer_qty),
      sectionQty: toNumber(row.section_qty),
      pieceQty: toNumber(row.piece_qty),
      toPlt: toNumber(row.to_plt),
      toLyr: toNumber(row.to_lyr),
      toSec: toNumber(row.to_sec),
      toPcs: toNumber(row.to_pcs),
      raw: row
    });
  }
  return [...orders.values()].map((order) => ({
    ...order,
    lines: normalizePoToReconciliationLines(order.lines, order.kind)
  }));
}

const RECONCILIATION_SOURCE_ID_CHUNK_SIZE = 800;

export async function fetchScmReconciliationOrdersFromNetSuite(options = {}) {
  const ids = positiveNetSuiteIds(options.orderIds);
  if (options.targetOnly && !ids.length) return [];
  if (ids.length <= RECONCILIATION_SOURCE_ID_CHUNK_SIZE) {
    return fetchScmReconciliationOrdersBatch({ ...options, orderIds: ids });
  }

  const orders = new Map();
  const collect = (rows) => {
    for (const order of rows || []) {
      orders.set(`${order.kind}:${order.id}`, order);
    }
  };
  if (!options.targetOnly) {
    collect(await fetchScmReconciliationOrdersBatch({
      ...options,
      orderIds: []
    }));
  }
  for (let offset = 0; offset < ids.length; offset += RECONCILIATION_SOURCE_ID_CHUNK_SIZE) {
    collect(await fetchScmReconciliationOrdersBatch({
      ...options,
      orderIds: ids.slice(offset, offset + RECONCILIATION_SOURCE_ID_CHUNK_SIZE),
      includeOpen: false,
      targetOnly: true
    }));
  }
  return [...orders.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id - right.id
  );
}

// Compatibility export for the existing PO/TO callers. The generic fetcher
// adds SO only when the caller requests SO or leaves kind unscoped.
export async function fetchPoToReconciliationOrdersFromNetSuite(options = {}) {
  const rows = await fetchScmReconciliationOrdersFromNetSuite({
    ...options,
    includeSalesOrders: false
  });
  return rows.filter((order) => order.kind === "PO" || order.kind === "TO");
}

export function normalizePoToLinkedTransactionRows(rows = []) {
  const transactionLines = new Map();
  for (const row of rows || []) {
    const key = [
      row.sourceOrderId,
      row.transactionType,
      row.transactionId,
      row.transactionLineKey
    ].join("|");
    if (!transactionLines.has(key)) {
      transactionLines.set(key, {
        ...row,
        sourceLineAliases: [],
        sourceOrderLineAliases: [],
        sourceIdentityIssue: ""
      });
    }
    const current = transactionLines.get(key);
    const sourceLineKey = reconciliationLineAlias(row.sourceLineKey);
    const sourceOrderLine = reconciliationLineAlias(row.sourceOrderLine);
    if (sourceLineKey && !current.sourceLineAliases.includes(sourceLineKey)) {
      current.sourceLineAliases.push(sourceLineKey);
    }
    if (sourceOrderLine && !current.sourceOrderLineAliases.includes(sourceOrderLine)) {
      current.sourceOrderLineAliases.push(sourceOrderLine);
    }
    if (
      current.itemId !== row.itemId
      || reconciliationIdentityNumber(current.quantity) !== reconciliationIdentityNumber(row.quantity)
    ) {
      current.sourceIdentityIssue = "A linked IF/IR line resolved to conflicting Transfer Order source rows.";
    }
  }
  return [...transactionLines.values()].map((row) => {
    row.sourceLineAliases.sort(reconciliationAliasSort);
    row.sourceOrderLineAliases.sort(reconciliationAliasSort);
    if (row.sourceOrderLineAliases.length > 1 && !row.sourceIdentityIssue) {
      row.sourceIdentityIssue = "A linked IF/IR line points to more than one Transfer Order line number.";
    }
    return {
      ...row,
      sourceLineKey: row.sourceLineAliases[0] || row.sourceLineKey,
      sourceOrderLine: Number(row.sourceOrderLineAliases[0]) || row.sourceOrderLineAliases[0] || row.sourceOrderLine,
      raw: {
        ...(row.raw && typeof row.raw === "object" ? row.raw : {}),
        sourceLineAliases: row.sourceLineAliases,
        sourceOrderLineAliases: row.sourceOrderLineAliases,
        sourceIdentityIssue: row.sourceIdentityIssue
      }
    };
  });
}

export async function fetchPoToLinkedTransactionsFromNetSuite(orderIds = []) {
  const ids = positiveNetSuiteIds(orderIds);
  if (!ids.length) return [];
  const allRows = [];
  const chunkSize = 200;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const rows = await suiteqlAll(`
      SELECT
        link.previousdoc AS source_order_id,
        source_t.type AS source_record_type,
        source_t.tranid AS source_order_ref,
        source_line.id AS source_order_line,
        source_line.uniquekey AS source_line_key,
        event_t.id AS transaction_id,
        event_t.type AS transaction_type,
        event_t.tranid AS transaction_ref,
        event_t.status,
        BUILTIN.DF(event_t.status) AS status_text,
        event_t.trandate,
        event_t.lastmodifieddate,
        event_line.id AS transaction_line,
        event_line.uniquekey AS transaction_line_key,
        event_line.item AS item_id,
        BUILTIN.DF(event_line.item) AS item_name,
        ABS(NVL(event_line.quantity, 0)) AS quantity,
        BUILTIN.DF(event_line.units) AS unit,
        event_line.location AS location_id,
        BUILTIN.DF(event_line.location) AS location
      FROM NextTransactionLineLink link
      INNER JOIN transaction source_t ON source_t.id = link.previousdoc
      INNER JOIN transactionline source_line
        ON source_line.transaction = link.previousdoc
       AND source_line.id = link.previousline
      INNER JOIN transaction event_t ON event_t.id = link.nextdoc
      INNER JOIN transactionline event_line
        ON event_line.transaction = link.nextdoc
       AND event_line.id = link.nextline
      WHERE link.previousdoc IN (${chunk.join(",")})
        AND event_t.type IN ('ItemShip', 'ItemRcpt')
        AND event_line.item IS NOT NULL
        AND (event_line.taxline = 'F' OR event_line.taxline IS NULL)
      ORDER BY link.previousdoc, event_t.id, event_line.id
    `);
    allRows.push(...rows);
  }
  const mapped = allRows.map((row) => ({
    sourceOrderId: Number(row.source_order_id),
    sourceRecordType: row.source_record_type || "",
    sourceOrderRef: row.source_order_ref || "",
    sourceOrderLine: Number(row.source_order_line),
    sourceLineKey: String(row.source_line_key || row.source_order_line || ""),
    transactionId: Number(row.transaction_id),
    transactionType: row.transaction_type || "",
    transactionRef: row.transaction_ref || "",
    status: row.status || "",
    statusText: row.status_text || "",
    transactionDate: row.trandate || null,
    lastModifiedAt: row.lastmodifieddate || null,
    transactionLine: Number(row.transaction_line),
    transactionLineKey: String(row.transaction_line_key || row.transaction_line || ""),
    itemId: Number(row.item_id) || null,
    itemName: row.item_name || "",
    quantity: toNumber(row.quantity),
    unit: row.unit || "",
    locationId: Number(row.location_id) || null,
    location: row.location || "",
    raw: row
  }));
  return normalizePoToLinkedTransactionRows(mapped);
}

export async function fetchTransferDeliveryOrderFromNetSuite(orderId, locationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transfer order ID is required.");
  }
  const locationFilter = locationId ? `AND tl.location = ${Number(locationId)}` : "";
  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.trandate,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      t.location AS source_location_id,
      BUILTIN.DF(t.location) AS source_location,
      tl.location AS line_location_id,
      BUILTIN.DF(tl.location) AS line_location,
      t.transferlocation AS destination_location_id,
      BUILTIN.DF(t.transferlocation) AS destination_location
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    WHERE t.id = ${id}
      AND t.type = 'TrnfrOrd'
      AND tl.item IS NOT NULL
      AND tl.quantity < 0
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND ${outboundStatusFilterSql("t")}
      AND ${openLineFilterSql("tl")}
      ${locationFilter}
    ORDER BY t.trandate DESC
  `);
  const order = result.items?.[0];
  if (!order) return null;
  return {
    ...order,
    order_type: "transfer_order",
    customer_id: order.destination_location_id,
    customer: `Transfer to ${order.destination_location || ""}`.trim(),
    order_location_id: order.destination_location_id,
    order_location: order.destination_location,
    source_location_id: order.line_location_id || order.source_location_id,
    source_location: order.line_location || order.source_location,
    outbound_location_id: order.line_location_id || order.source_location_id,
    outbound_location: order.line_location || order.source_location,
    delivery_method_id: null,
    delivery_method: "Transfer Order"
  };
}

export async function fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite sales order ID is required.");
  }
  const locationFilter = locationId ? `AND tl.location = ${Number(locationId)}` : "";

  const detailQuery = `
    SELECT
      tl.uniquekey AS line_id,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      tl.memo AS item_description,
      tl.quantity,
      tl.quantitycommitted AS netsuite_committed_qty,
      tl.quantitybackordered AS netsuite_backordered_qty,
      tl.quantityshiprecv AS netsuite_received_qty,
      BUILTIN.DF(tl.units) AS unit,
      i.weight AS item_weight,
      tl.location AS location_id,
      BUILTIN.DF(tl.location) AS location,
      tl.custcol_plt AS pallet_qty,
      tl.custcol_lyr AS layer_qty,
      tl.custcol_pcs AS piece_qty,
      tl.custcol_sec AS section_qty,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs
    FROM transactionline tl
    LEFT JOIN item i ON i.id = tl.item
    WHERE tl.transaction = ${id}
      AND EXISTS (
        SELECT 1
          FROM transaction t
         WHERE t.id = tl.transaction
           AND t.type = 'SalesOrd'
           ${excludedSalesOrderPrefixSql("t")}
      )
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND ${openLineFilterSql("tl")}
      ${locationFilter}
    ORDER BY tl.uniquekey
  `;

  const result = await suiteql(detailQuery);
  return (result.items || []).map(normalizeOpenDeliveryLine);
}

export async function fetchDeliveryOrderDetailsBatchFromNetSuite(orderIds) {
  if (orderIds === null || orderIds === undefined || typeof orderIds[Symbol.iterator] !== "function") {
    throw new Error("NetSuite sales order IDs must be provided as an iterable.");
  }
  const requestedIds = [...orderIds];
  const parsedIds = requestedIds.map((orderId) => Number(orderId));
  if (parsedIds.some((orderId) => !Number.isSafeInteger(orderId) || orderId <= 0)) {
    throw new Error("Every NetSuite sales order ID must be a valid positive integer.");
  }
  const ids = [...new Set(parsedIds)];
  const linesByOrderId = new Map(ids.map((orderId) => [orderId, []]));
  if (!ids.length) return linesByOrderId;

  // Oracle-backed SuiteQL limits IN lists to 1,000 expressions. Normal requests
  // use one query; unusually large refreshes are split below that hard limit.
  const chunkSize = 900;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const rows = await suiteqlAll(`
      SELECT
        tl.transaction AS transaction_id,
        tl.uniquekey AS line_id,
        tl.item AS item_id,
        BUILTIN.DF(tl.item) AS item_name,
        i.itemtype AS item_type,
        BUILTIN.DF(i.itemtype) AS item_type_text,
        tl.memo AS item_description,
        tl.quantity,
        tl.quantitycommitted AS netsuite_committed_qty,
        tl.quantitybackordered AS netsuite_backordered_qty,
        tl.quantityshiprecv AS netsuite_received_qty,
        BUILTIN.DF(tl.units) AS unit,
        i.weight AS item_weight,
        tl.location AS location_id,
        BUILTIN.DF(tl.location) AS location,
        tl.custcol_plt AS pallet_qty,
        tl.custcol_lyr AS layer_qty,
        tl.custcol_pcs AS piece_qty,
        tl.custcol_sec AS section_qty,
        i.custitem_toplt AS to_plt,
        i.custitem_tolyr AS to_lyr,
        i.custitem_tosec AS to_sec,
        i.custitem_topcs AS to_pcs
      FROM transactionline tl
      LEFT JOIN item i ON i.id = tl.item
      WHERE tl.transaction IN (${chunk.join(",")})
        AND EXISTS (
          SELECT 1
            FROM transaction t
           WHERE t.id = tl.transaction
             AND t.type = 'SalesOrd'
             ${excludedSalesOrderPrefixSql("t")}
        )
        AND tl.item IS NOT NULL
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND ${openLineFilterSql("tl")}
      ORDER BY tl.transaction, tl.uniquekey
    `);
    for (const line of rows.map(normalizeOpenDeliveryLine)) {
      const orderId = Number(line.transaction_id);
      const groupedLines = linesByOrderId.get(orderId);
      if (groupedLines) groupedLines.push(line);
    }
  }
  return linesByOrderId;
}

export async function fetchTransferOrderDetailsFromNetSuite(orderId, locationId = null, { direction = "source" } = {}) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transfer order ID is required.");
  }
  const locationFilter = locationId ? `AND tl.location = ${Number(locationId)}` : "";

  const result = await suiteql(`
    SELECT
      tl.uniquekey AS line_id,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      tl.memo AS item_description,
      tl.quantity,
      tl.quantityshiprecv AS netsuite_received_qty,
      BUILTIN.DF(tl.units) AS unit,
      i.weight AS item_weight,
      tl.location AS location_id,
      BUILTIN.DF(tl.location) AS location,
      tl.custcol_plt AS pallet_qty,
      tl.custcol_lyr AS layer_qty,
      tl.custcol_pcs AS piece_qty,
      tl.custcol_sec AS section_qty,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs
    FROM transactionline tl
    LEFT JOIN item i ON i.id = tl.item
    WHERE tl.transaction = ${id}
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      ${locationFilter}
    ORDER BY tl.uniquekey
  `);
  return normalizeTransferDetailLines(result.items || [], direction === "destination"
    ? { destinationLocationId: locationId }
    : { sourceLocationId: locationId });
}

export async function fetchTransferOrderVerificationLinesFromNetSuite(orderId, sourceLocationId) {
  const id = Number(orderId);
  const source = Number(sourceLocationId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite transfer order ID is required.");
  if (!Number.isInteger(source) || source <= 0) throw new Error("A valid NetSuite source location ID is required.");
  // NetSuite exposes two identical source-side transaction rows for each TO item
  // (the physical line and its transfer accounting mirror). Aggregate both and
  // divide once so repeated legitimate item lines still retain their full total.
  const result = await suiteql(`
    SELECT
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      ABS(SUM(NVL(tl.quantity, 0))) / 2 AS quantity,
      SUM(NVL(tl.custcol_plt, 0)) / 2 AS pallet_qty,
      SUM(NVL(tl.custcol_lyr, 0)) / 2 AS layer_qty,
      SUM(NVL(tl.custcol_sec, 0)) / 2 AS section_qty,
      SUM(NVL(tl.custcol_pcs, 0)) / 2 AS piece_qty
    FROM transactionline tl
    WHERE tl.transaction = ${id}
      AND tl.item IS NOT NULL
      AND tl.location = ${source}
      AND tl.quantity < 0
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
    GROUP BY tl.item, BUILTIN.DF(tl.item)
    ORDER BY tl.item
  `);
  return result.items || [];
}

export async function fetchPurchaseOrdersFromNetSuite(locationId = 1) {
  const result = await suiteqlAll(purchaseOrderListQuery(locationId));
  return result.map((order) => ({ ...order, order_type: "purchase_order" }));
}

export async function fetchPurchaseOrderFromNetSuite(orderId, locationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite purchase order ID is required.");
  }
  const locationFilter = locationId ? `AND tl.location = ${Number(locationId)}` : "";
  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.trandate,
      t.entity AS vendor_id,
      BUILTIN.DF(t.entity) AS vendor,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      COALESCE(NULLIF(BUILTIN.DF(v.defaultbillingaddress), ''), NULLIF(BUILTIN.DF(t.billingaddress), '')) AS vendor_address,
      t.foreigntotal,
      tl.location AS destination_location_id,
      BUILTIN.DF(tl.location) AS destination_location
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    LEFT JOIN vendor v ON v.id = t.entity
    WHERE t.id = ${id}
      AND t.type = 'PurchOrd'
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND (tl.taxline = 'F' OR tl.taxline IS NULL)
      AND ${purchaseReceivingStatusFilterSql("t")}
      AND ${openLineFilterSql("tl")}
      ${locationFilter}
    ORDER BY t.trandate DESC
  `);
  const order = result.items?.[0];
  return order ? { ...order, order_type: "purchase_order" } : null;
}

export async function fetchPurchaseOrderReferenceFromNetSuite(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite purchase order ID is required.");
  const result = await suiteql(`
    SELECT
      t.id,
      t.tranid,
      t.trandate,
      t.entity AS vendor_id,
      BUILTIN.DF(t.entity) AS vendor,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      COALESCE(NULLIF(BUILTIN.DF(v.defaultbillingaddress), ''), NULLIF(BUILTIN.DF(t.billingaddress), '')) AS vendor_address,
      t.foreigntotal,
      tl.location AS destination_location_id,
      BUILTIN.DF(tl.location) AS destination_location
    FROM transaction t
    LEFT JOIN vendor v ON v.id = t.entity
    LEFT JOIN transactionline tl
      ON tl.transaction = t.id
     AND tl.item IS NOT NULL
     AND tl.mainline = 'F'
     AND (tl.taxline = 'F' OR tl.taxline IS NULL)
    WHERE t.id = ${id}
      AND t.type = 'PurchOrd'
    ORDER BY tl.uniquekey
    FETCH FIRST 1 ROWS ONLY
  `);
  const order = result.items?.[0];
  return order ? { ...order, order_type: "purchase_order" } : null;
}

export async function fetchPurchaseOrderDetailsFromNetSuite(orderId, locationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite purchase order ID is required.");
  }
  const locationFilter = locationId ? `AND tl.location = ${Number(locationId)}` : "";
  const result = await suiteql(`
    SELECT
      tl.uniquekey AS line_id,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      tl.memo AS item_description,
      tl.quantity,
      tl.quantityshiprecv AS netsuite_received_qty,
      BUILTIN.DF(tl.units) AS unit,
      i.weight AS item_weight,
      tl.location AS location_id,
      BUILTIN.DF(tl.location) AS location,
      tl.custcol_plt AS pallet_qty,
      tl.custcol_lyr AS layer_qty,
      tl.custcol_pcs AS piece_qty,
      tl.custcol_sec AS section_qty,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs
    FROM transactionline tl
    LEFT JOIN item i ON i.id = tl.item
    WHERE tl.transaction = ${id}
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND (tl.taxline = 'F' OR tl.taxline IS NULL)
      ${locationFilter}
    ORDER BY tl.uniquekey
  `);
  return (result.items || []).map(normalizeOpenDeliveryLine);
}

function purchaseOrderHistorySnapshotFromRows(rows) {
  if (!rows.length) return null;
  const first = rows[0];
  return {
    id: Number(first.id),
    tranid: first.tranid || "",
    trandate: first.trandate || null,
    createdAt: first.createddate || null,
    lastModifiedAt: first.lastmodifieddate || null,
    vendorId: Number(first.vendor_id) || null,
    vendor: first.vendor || "",
    status: first.status || "",
    statusText: first.status_text || "",
    memo: first.memo || "",
    vendorReference: first.vendor_reference || "",
    expectedDeliveryDate: first.expected_delivery_date || null,
    foreignTotal: first.foreigntotal === null || first.foreigntotal === undefined ? null : Number(first.foreigntotal),
    lines: rows.filter((row) => row.line_id !== null && row.line_id !== undefined).map((row) => ({
      lineId: Number(row.line_id),
      restLineId: Number(row.rest_line_id) || null,
      itemId: Number(row.item_id) || null,
      itemName: row.item_name || "",
      itemType: row.item_type || "",
      itemTypeText: row.item_type_text || "",
      description: row.item_description || "",
      quantity: Number(row.quantity) || 0,
      receivedQuantity: Number(row.received_quantity) || 0,
      rate: row.rate === null || row.rate === undefined ? null : Number(row.rate),
      amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
      closed: /^(t|true|yes|1)$/i.test(String(row.line_closed || "")),
      unit: row.unit || "",
      itemWeight: row.item_weight === null || row.item_weight === undefined ? null : Number(row.item_weight),
      locationId: Number(row.location_id) || null,
      location: row.location || "",
      palletQuantity: Number(row.pallet_qty) || 0,
      layerQuantity: Number(row.layer_qty) || 0,
      sectionQuantity: Number(row.section_qty) || 0,
      pieceQuantity: Number(row.piece_qty) || 0,
      toPlt: row.to_plt === null || row.to_plt === undefined ? null : Number(row.to_plt),
      toLyr: row.to_lyr === null || row.to_lyr === undefined ? null : Number(row.to_lyr),
      toSec: row.to_sec === null || row.to_sec === undefined ? null : Number(row.to_sec),
      toPcs: row.to_pcs === null || row.to_pcs === undefined ? null : Number(row.to_pcs)
    }))
  };
}

export async function fetchPurchaseOrderHistorySnapshotsFromNetSuite(orderIds = []) {
  const ids = [...new Set((orderIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  if (ids.length > 50) throw new Error("At most 50 NetSuite purchase orders can be reconciled at once.");
  const rows = await suiteqlAll(`
    SELECT
      t.id,
      t.tranid,
      t.trandate,
      t.createddate,
      t.lastmodifieddate,
      t.entity AS vendor_id,
      BUILTIN.DF(t.entity) AS vendor,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      t.otherrefnum AS vendor_reference,
      t.custbody4 AS expected_delivery_date,
      t.foreigntotal,
      tl.uniquekey AS line_id,
      tl.id AS rest_line_id,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      tl.memo AS item_description,
      ABS(NVL(tl.quantity, 0)) AS quantity,
      ABS(NVL(tl.quantityshiprecv, 0)) AS received_quantity,
      tl.rate,
      ABS(NVL(tl.foreignamount, 0)) AS amount,
      tl.isclosed AS line_closed,
      BUILTIN.DF(tl.units) AS unit,
      i.weight AS item_weight,
      tl.location AS location_id,
      BUILTIN.DF(tl.location) AS location,
      tl.custcol_plt AS pallet_qty,
      tl.custcol_lyr AS layer_qty,
      tl.custcol_sec AS section_qty,
      tl.custcol_pcs AS piece_qty,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs
    FROM transaction t
    LEFT JOIN transactionline tl
      ON tl.transaction = t.id
     AND tl.item IS NOT NULL
     AND tl.mainline = 'F'
     AND (tl.taxline = 'F' OR tl.taxline IS NULL)
    LEFT JOIN item i ON i.id = tl.item
    WHERE t.id IN (${ids.join(", ")})
      AND t.type = 'PurchOrd'
    ORDER BY t.id, tl.uniquekey
  `);
  const byId = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
  }
  return ids.map((id) => purchaseOrderHistorySnapshotFromRows(byId.get(id) || [])).filter(Boolean);
}

export async function fetchPurchaseOrderHistorySnapshotFromNetSuite(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite purchase order ID is required.");
  }
  const snapshots = await fetchPurchaseOrderHistorySnapshotsFromNetSuite([id]);
  return snapshots[0] || null;
}

export async function fetchVendorItemCodesFromNetSuite({ vendorId, itemIds = [], subsidiaryId = null } = {}) {
  const vendor = Number(vendorId);
  if (!Number.isInteger(vendor) || vendor <= 0) throw new Error("A valid numeric NetSuite vendor ID is required.");
  const items = [...new Set((itemIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!items.length) return [];
  const subsidiary = Number(subsidiaryId);
  const subsidiaryFilter = Number.isInteger(subsidiary) && subsidiary > 0
    ? `AND (iv.subsidiary = ${subsidiary} OR iv.subsidiary IS NULL)`
    : "";
  try {
    const rows = await suiteqlAll(`
      SELECT
        iv.item AS item_id,
        iv.vendor AS vendor_id,
        iv.subsidiary AS subsidiary_id,
        iv.vendorcode AS vendor_code,
        iv.preferredvendor AS preferred_vendor
      FROM itemvendor iv
      WHERE iv.vendor = ${vendor}
        AND iv.item IN (${items.join(",")})
        ${subsidiaryFilter}
      ORDER BY iv.item, iv.preferredvendor DESC, iv.subsidiary
    `);
    const found = new Map();
    for (const row of rows) {
      const itemId = Number(row.item_id);
      const vendorCode = String(row.vendor_code || "").trim();
      if (!vendorCode || found.has(itemId)) continue;
      found.set(itemId, {
        itemId,
        vendorId: vendor,
        subsidiaryId: Number(row.subsidiary_id) || 0,
        vendorCode,
        preferredVendor: /^(t|true|yes|1)$/i.test(String(row.preferred_vendor || "")),
        source: "item_vendor"
      });
    }
    if (found.size === items.length) return [...found.values()];
    const missing = items.filter((itemId) => !found.has(itemId));
    const fallback = await suiteqlAll(`
      SELECT i.id AS item_id, i.vendorname AS vendor_code, i.vendor AS vendor_id
        FROM item i
       WHERE i.id IN (${missing.join(",")})
         AND i.vendor = ${vendor}
    `);
    for (const row of fallback) {
      const vendorCode = String(row.vendor_code || "").trim();
      if (!vendorCode) continue;
      found.set(Number(row.item_id), {
        itemId: Number(row.item_id),
        vendorId: vendor,
        subsidiaryId: 0,
        vendorCode,
        preferredVendor: true,
        source: "single_vendor_fallback"
      });
    }
    return [...found.values()];
  } catch (itemVendorError) {
    const fallback = await suiteqlAll(`
      SELECT i.id AS item_id, i.vendorname AS vendor_code, i.vendor AS vendor_id
        FROM item i
       WHERE i.id IN (${items.join(",")})
         AND i.vendor = ${vendor}
    `);
    return fallback.map((row) => ({
      itemId: Number(row.item_id),
      vendorId: vendor,
      subsidiaryId: 0,
      vendorCode: String(row.vendor_code || "").trim(),
      preferredVendor: true,
      source: "single_vendor_fallback",
      itemVendorLookupError: itemVendorError.message
    })).filter((row) => row.vendorCode);
  }
}

export async function fetchTransferReceivingOrdersFromNetSuite({ sourceLocationId = null, destinationLocationId = null } = {}) {
  const result = await suiteqlAll(transferOrderListQuery({
    statusText: "Pending Receipt",
    sourceLocationId,
    destinationLocationId,
    lineLocationId: destinationLocationId || null,
    lineDirection: "destination"
  }));
  return Promise.all(result.map((order) => hydrateTransferReceivingSource({
    ...order,
    order_type: "transfer_order",
    source_location_id: order.source_location_id,
    source_location: order.source_location,
    vendor_id: order.source_location_id,
    vendor: order.source_location
  })));
}

export async function fetchTransferReceivingOrderFromNetSuite(orderId, sourceLocationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transfer order ID is required.");
  }
  const sourceFilter = sourceLocationId ? `AND EXISTS (
    SELECT 1
      FROM transactionline source_tl
     WHERE source_tl.transaction = t.id
       AND source_tl.item IS NOT NULL
       AND source_tl.quantity < 0
       AND source_tl.location = ${Number(sourceLocationId)}
       AND source_tl.mainline = 'F'
       AND source_tl.taxline = 'F'
  )` : "";
  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.trandate,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      t.location AS source_location_id,
      BUILTIN.DF(t.location) AS source_location,
      tl.location AS line_location_id,
      BUILTIN.DF(tl.location) AS line_location,
      t.transferlocation AS destination_location_id,
      BUILTIN.DF(t.transferlocation) AS destination_location
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    WHERE t.id = ${id}
      AND t.type = 'TrnfrOrd'
      AND tl.item IS NOT NULL
      AND tl.quantity > 0
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND ${receivingStatusFilterSql("t")}
      AND ${openLineFilterSql("tl")}
      ${sourceFilter}
    ORDER BY t.trandate DESC
  `);
  const order = result.items?.[0];
  if (!order) return null;
  return hydrateTransferReceivingSource({
    ...order,
    order_type: "transfer_order",
    source_location_id: order.source_location_id,
    source_location: order.source_location,
    vendor_id: order.source_location_id,
    vendor: order.source_location
  });
}

export async function fetchInventoryBalancesFromNetSuite(locationIds = [1, 28, 15, 26]) {
  const ids = locationIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) throw new Error("At least one NetSuite location ID is required.");

  return suiteqlAll(`
    SELECT
      i.id AS item_id,
      BUILTIN.DF(i.id) AS item_name,
      i.displayname AS display_name,
      i.description AS item_description,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      BUILTIN.DF(i.stockunit) AS stock_unit,
      BUILTIN.DF(i.purchaseunit) AS purchase_unit,
      i.vendor AS vendor_id,
      BUILTIN.DF(i.vendor) AS vendor,
      i.leadtime AS netsuite_lead_time_days,
      i.safetystocklevel AS netsuite_safety_stock_level,
      i.seasonaldemand AS netsuite_seasonal_demand,
      i.lastpurchaseprice AS last_purchase_price,
      i.weight AS item_weight,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs,
      ib.location AS location_id,
      BUILTIN.DF(ib.location) AS location,
      ib.quantityonhand AS quantity_on_hand,
      ib.quantityavailable AS quantity_available,
      ib.quantityonorder AS quantity_on_order,
      ib.quantitybackordered AS quantity_backordered
    FROM AggregateItemLocation ib
    INNER JOIN item i ON i.id = ib.item
    WHERE ib.location IN (${ids.join(",")})
      AND i.isinactive = 'F'
      AND i.itemtype IN ('InvtPart', 'NonInvtPart')
    ORDER BY BUILTIN.DF(i.itemtype), BUILTIN.DF(i.id), BUILTIN.DF(ib.location)
  `);
}

export async function fetchInventoryBalanceForItemFromNetSuite(itemId, locationId) {
  const item = Number(itemId);
  const location = Number(locationId);
  if (!Number.isInteger(item) || item <= 0) throw new Error("A valid NetSuite item ID is required.");
  if (!Number.isInteger(location) || location <= 0) throw new Error("A valid NetSuite location ID is required.");

  const result = await suiteql(`
    SELECT
      i.id AS item_id,
      BUILTIN.DF(i.id) AS item_name,
      i.displayname AS display_name,
      i.description AS item_description,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      BUILTIN.DF(i.stockunit) AS stock_unit,
      BUILTIN.DF(i.purchaseunit) AS purchase_unit,
      i.vendor AS vendor_id,
      BUILTIN.DF(i.vendor) AS vendor,
      i.leadtime AS netsuite_lead_time_days,
      i.safetystocklevel AS netsuite_safety_stock_level,
      i.seasonaldemand AS netsuite_seasonal_demand,
      i.lastpurchaseprice AS last_purchase_price,
      i.weight AS item_weight,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs,
      ib.location AS location_id,
      BUILTIN.DF(ib.location) AS location,
      ib.quantityonhand AS quantity_on_hand,
      ib.quantityavailable AS quantity_available,
      ib.quantityonorder AS quantity_on_order,
      ib.quantitybackordered AS quantity_backordered
    FROM AggregateItemLocation ib
    INNER JOIN item i ON i.id = ib.item
    WHERE ib.item = ${item}
      AND ib.location = ${location}
      AND i.isinactive = 'F'
    FETCH FIRST 1 ROWS ONLY
  `);

  return result.items || [];
}

function normalizedLocationLabel(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function locationCodeScore(row = {}, code = "") {
  const normalizedCode = normalizedLocationLabel(code);
  if (!normalizedCode) return 0;
  const name = String(row.name || "").trim();
  const fullname = String(row.fullname || "").trim();
  const leafName = fullname.split(":").at(-1)?.trim() || "";
  if (normalizedLocationLabel(name) === normalizedCode) return 100;
  if (normalizedLocationLabel(leafName) === normalizedCode) return 95;
  if (normalizedLocationLabel(fullname) === normalizedCode) return 90;
  if (normalizedCode === "150") {
    if (/^150(?:\D|$)/i.test(name)) return 80;
    if (/^150(?:\D|$)/i.test(leafName)) return 75;
  }
  return 0;
}

export function matchNetSuiteLocation(directory = [], { locationId = null, code = "" } = {}) {
  const activeRows = (directory || []).filter((row) => String(row.isinactive || "F").toUpperCase() !== "T");
  const normalizedCode = normalizedLocationLabel(code);
  if (!normalizedCode) {
    const byId = activeRows.find((row) => String(row.id) === String(locationId));
    if (!byId) throw new Error(`NetSuite location ${locationId || "(missing)"} is not active in the selected account.`);
    return byId;
  }

  const ranked = activeRows
    .map((row) => ({ row, score: locationCodeScore(row, normalizedCode) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || Number(left.row.id) - Number(right.row.id));
  if (!ranked.length) {
    throw new Error(`Yard ${code} could not be matched to an active NetSuite location in account ${config.netsuite.accountId || "current"}.`);
  }
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    throw new Error(`Yard ${code} matches multiple active NetSuite locations. Rename the locations so the yard code is unique.`);
  }
  return ranked[0].row;
}

async function activeNetSuiteLocationDirectory() {
  const key = `${config.netsuite.accountId || ""}|${config.netsuite.restBaseUrl || ""}`;
  if (locationDirectoryCache.key === key && locationDirectoryCache.expiresAt > Date.now()) {
    return locationDirectoryCache.rows;
  }
  const rows = await suiteqlAll(`
    SELECT l.id, l.name, l.fullname, l.isinactive, l.subsidiary,
           BUILTIN.DF(l.subsidiary) AS subsidiary_name
      FROM location l
     WHERE l.isinactive = 'F'
     ORDER BY l.id
  `);
  locationDirectoryCache = {
    key,
    expiresAt: Date.now() + LOCATION_DIRECTORY_TTL_MS,
    rows
  };
  return rows;
}

function resolvedNetSuiteLocation(row, local = {}) {
  const netsuiteLocationId = Number(row?.id);
  const subsidiaryId = Number(row?.subsidiary);
  if (!Number.isInteger(netsuiteLocationId) || netsuiteLocationId <= 0) {
    throw new Error(`NetSuite returned an invalid location for yard ${local.code || local.locationId || "unknown"}.`);
  }
  return {
    localLocationId: Number(local.locationId),
    localLocationCode: String(local.code || "").trim(),
    netsuiteLocationId,
    netsuiteLocationName: String(row.name || row.fullname || "").trim(),
    subsidiaryId: Number.isInteger(subsidiaryId) && subsidiaryId > 0 ? subsidiaryId : null,
    subsidiaryName: String(row.subsidiary_name || "").trim()
  };
}

export async function resolveNetSuiteYardLocations(yards = []) {
  const directory = await activeNetSuiteLocationDirectory();
  return (yards || []).map((yard) => resolvedNetSuiteLocation(
    matchNetSuiteLocation(directory, { locationId: yard.locationId, code: yard.code }),
    yard
  ));
}

export async function resolveNetSuiteTransferLocations({
  sourceLocationId,
  sourceLocation,
  destinationLocationId,
  destinationLocation
} = {}) {
  const [source, destination] = await resolveNetSuiteYardLocations([
    { locationId: sourceLocationId, code: sourceLocation },
    { locationId: destinationLocationId, code: destinationLocation }
  ]);
  if (!source.subsidiaryId || !destination.subsidiaryId) {
    throw new Error("NetSuite subsidiary could not be determined for the selected transfer locations.");
  }
  return {
    source,
    destination,
    intercompany: source.subsidiaryId !== destination.subsidiaryId
  };
}

export async function fetchTransferOrderByIdFromNetSuite(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid numeric NetSuite transfer order ID is required.");
  const result = await suiteql(`
    SELECT
      t.id,
      t.tranid,
      t.trandate,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      source_tl.location AS source_location_id,
      BUILTIN.DF(source_tl.location) AS source_location,
      t.transferlocation AS destination_location_id,
      BUILTIN.DF(t.transferlocation) AS destination_location
    FROM transaction t
    LEFT JOIN transactionline source_tl
      ON source_tl.transaction = t.id
     AND source_tl.item IS NOT NULL
     AND source_tl.quantity < 0
     AND source_tl.mainline = 'F'
     AND source_tl.taxline = 'F'
    WHERE t.id = ${id}
      AND t.type = 'TrnfrOrd'
    ORDER BY source_tl.uniquekey
    FETCH FIRST 1 ROWS ONLY
  `);
  const order = result.items?.[0];
  if (!order) return null;
  return {
    ...order,
    order_type: "transfer_order",
    customer_id: order.destination_location_id,
    customer: `Transfer to ${order.destination_location || ""}`.trim(),
    order_location_id: order.destination_location_id,
    order_location: order.destination_location,
    outbound_location_id: order.source_location_id,
    outbound_location: order.source_location,
    delivery_method: "Transfer Order"
  };
}

export async function findTransferOrdersByDependencyMarkerFromNetSuite({
  batchId,
  proposalId = null,
  sourceLocationId,
  destinationLocationId
} = {}) {
  const batch = Number(batchId);
  const proposal = Number(proposalId);
  const source = Number(sourceLocationId);
  const destination = Number(destinationLocationId);
  if (!Number.isInteger(batch) || batch <= 0) throw new Error("A valid dependency batch ID is required.");
  if (!Number.isInteger(source) || source <= 0 || !Number.isInteger(destination) || destination <= 0) {
    throw new Error("Valid NetSuite transfer locations are required to recover a Transfer Order.");
  }
  const exactMarker = Number.isInteger(proposal) && proposal > 0
    ? `MBBS DEPENDENCY BATCH ${batch} PROPOSAL ${proposal}`
    : "";
  const legacyMarker = `MBBS DEPENDENCY BATCH ${batch}`;
  const markerFilter = exactMarker
    ? `(UPPER(t.memo) LIKE '%${exactMarker}%' OR UPPER(t.memo) LIKE '%${legacyMarker}%')`
    : `UPPER(t.memo) LIKE '%${legacyMarker}%'`;
  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.trandate,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      source_tl.location AS source_location_id,
      BUILTIN.DF(source_tl.location) AS source_location,
      t.transferlocation AS destination_location_id,
      BUILTIN.DF(t.transferlocation) AS destination_location
    FROM transaction t
    INNER JOIN transactionline source_tl
      ON source_tl.transaction = t.id
     AND source_tl.item IS NOT NULL
     AND source_tl.quantity < 0
     AND source_tl.location = ${source}
     AND source_tl.mainline = 'F'
     AND source_tl.taxline = 'F'
    WHERE t.type = 'TrnfrOrd'
      AND t.transferlocation = ${destination}
      AND ${markerFilter}
    ORDER BY t.id DESC
    FETCH FIRST 10 ROWS ONLY
  `);
  return result.items || [];
}

export async function findTransferOrdersBySmartScmMarkerFromNetSuite({
  proposalId,
  sourceLocationId,
  destinationLocationId
} = {}) {
  const proposal = Number(proposalId);
  const source = Number(sourceLocationId);
  const destination = Number(destinationLocationId);
  if (!Number.isInteger(proposal) || proposal <= 0) {
    throw new Error("A valid Smart SCM proposal ID is required.");
  }
  if (!Number.isInteger(source) || source <= 0 || !Number.isInteger(destination) || destination <= 0) {
    throw new Error("Valid NetSuite transfer locations are required to recover a Smart SCM Transfer Order.");
  }
  const marker = `MBBS-SCM:${proposal}`.toUpperCase();
  const result = await suiteql(`
    SELECT DISTINCT
      t.id,
      t.tranid,
      t.trandate,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.memo,
      source_tl.location AS source_location_id,
      BUILTIN.DF(source_tl.location) AS source_location,
      t.transferlocation AS destination_location_id,
      BUILTIN.DF(t.transferlocation) AS destination_location
    FROM transaction t
    INNER JOIN transactionline source_tl
      ON source_tl.transaction = t.id
     AND source_tl.item IS NOT NULL
     AND source_tl.quantity < 0
     AND source_tl.location = ${source}
     AND source_tl.mainline = 'F'
     AND source_tl.taxline = 'F'
    WHERE t.type = 'TrnfrOrd'
      AND t.transferlocation = ${destination}
      AND (
        UPPER(COALESCE(t.memo, '')) LIKE '%${marker} |%'
        OR UPPER(COALESCE(t.memo, '')) LIKE '%${marker}'
      )
    ORDER BY t.id DESC
    FETCH FIRST 10 ROWS ONLY
  `);
  return result.items || [];
}

export async function findPurchaseOrdersBySmartScmMarkerFromNetSuite({ proposalId, vendorId = null } = {}) {
  const proposal = Number(proposalId);
  const vendor = Number(vendorId);
  if (!Number.isInteger(proposal) || proposal <= 0) {
    throw new Error("A valid Smart SCM PO review proposal ID is required.");
  }
  const vendorFilter = Number.isInteger(vendor) && vendor > 0 ? `AND t.entity = ${vendor}` : "";
  const marker = `MBBS-SCM-PO:${proposal}`.toUpperCase();
  const result = await suiteql(`
    SELECT t.id,
           t.tranid,
           t.trandate,
           t.entity AS vendor_id,
           BUILTIN.DF(t.entity) AS vendor,
           t.status,
           BUILTIN.DF(t.status) AS status_text,
           t.memo
      FROM transaction t
     WHERE t.type = 'PurchOrd'
       AND (
         UPPER(COALESCE(t.memo, '')) LIKE '%${marker} |%'
         OR UPPER(COALESCE(t.memo, '')) LIKE '%${marker}'
       )
       ${vendorFilter}
     ORDER BY t.id DESC
     FETCH FIRST 10 ROWS ONLY
  `);
  return result.items || [];
}

export async function fetchInventoryBalancesForItemsFromNetSuite(itemIds = [], locationIds = [1, 28, 15, 26]) {
  const items = [...new Set((itemIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const locations = [...new Set((locationIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!items.length) return [];
  if (!locations.length) throw new Error("At least one NetSuite location ID is required.");
  return suiteqlAll(`
    SELECT
      i.id AS item_id,
      BUILTIN.DF(i.id) AS item_name,
      i.displayname AS display_name,
      i.description AS item_description,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      BUILTIN.DF(i.stockunit) AS stock_unit,
      BUILTIN.DF(i.purchaseunit) AS purchase_unit,
      i.vendor AS vendor_id,
      BUILTIN.DF(i.vendor) AS vendor,
      i.leadtime AS netsuite_lead_time_days,
      i.safetystocklevel AS netsuite_safety_stock_level,
      i.seasonaldemand AS netsuite_seasonal_demand,
      i.lastpurchaseprice AS last_purchase_price,
      i.weight AS item_weight,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs,
      ib.location AS location_id,
      BUILTIN.DF(ib.location) AS location,
      ib.quantityonhand AS quantity_on_hand,
      ib.quantityavailable AS quantity_available,
      ib.quantityonorder AS quantity_on_order,
      ib.quantitybackordered AS quantity_backordered
    FROM AggregateItemLocation ib
    INNER JOIN item i ON i.id = ib.item
    WHERE ib.item IN (${items.join(",")})
      AND ib.location IN (${locations.join(",")})
      AND i.isinactive = 'F'
    ORDER BY BUILTIN.DF(i.id), BUILTIN.DF(ib.location)
  `);
}

function smartScmSuiteQlDate(value, fallback) {
  const resolved = String(value || fallback || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolved)) throw new Error("Smart SCM sales dates must use YYYY-MM-DD.");
  return resolved;
}

export async function fetchSmartScmSalesHistoryFromNetSuite({
  itemIds = [],
  locationIds = [1, 28, 15, 26],
  startDate,
  endDate
} = {}) {
  const items = [...new Set((itemIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const locations = [...new Set((locationIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!items.length) return [];
  if (!locations.length) throw new Error("At least one NetSuite location ID is required.");
  const start = smartScmSuiteQlDate(startDate);
  const end = smartScmSuiteQlDate(endDate, start);
  return suiteqlAll(`
    SELECT
      t.id AS transaction_id,
      t.tranid AS document_ref,
      t.trandate AS transaction_date,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.custbody3 AS delivery_method_id,
      BUILTIN.DF(t.custbody3) AS delivery_method,
      tl.uniquekey AS line_id,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      ABS(NVL(tl.quantity, 0)) AS quantity,
      tl.location AS location_id,
      BUILTIN.DF(tl.location) AS location
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    WHERE t.type = 'SalesOrd'
      ${excludedSalesOrderPrefixSql("t")}
      AND t.trandate >= TO_DATE('${start}', 'YYYY-MM-DD')
      AND t.trandate <= TO_DATE('${end}', 'YYYY-MM-DD')
      AND tl.item IN (${items.join(",")})
      AND tl.location IN (${locations.join(",")})
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND ABS(NVL(tl.quantity, 0)) > 0.000001
      AND UPPER(BUILTIN.DF(t.status)) NOT LIKE '%CANCEL%'
    ORDER BY t.trandate, t.id, tl.uniquekey
  `);
}
