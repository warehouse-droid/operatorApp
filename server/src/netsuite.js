import crypto from "node:crypto";
import { config, requireConfig } from "./config.js";
import { query } from "./db.js";

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
      throw new Error(`NetSuite request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  }
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
  t.custbody7 AS memo,
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
      if (isConcurrencyLimit(response.status, text) && attempt < 3) {
        await delay(2000 * (attempt + 1));
        continue;
      }
      throw lastError;
    }
    const location = response.headers.get("location") || "";
    const idMatch = location.match(/\/(?:itemFulfillment|itemReceipt|transferOrder|intercompanyTransferOrder)\/(\d+)/i);
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

export async function resolvePalletItemFromNetSuite() {
  const key = `${config.netsuite.accountId || ""}|${config.netsuite.restBaseUrl || ""}`;
  if (palletItemCache.key === key && palletItemCache.item) return palletItemCache.item;
  const rows = await suiteqlAll(`
    SELECT i.id, i.itemid, BUILTIN.DF(i.stockunit) AS stock_unit
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
    item: { id, itemId: id, itemName: String(row.itemid || "PALLET"), unit: String(row.stock_unit || "EACH") }
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
    SELECT
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
      t.custbody7 AS memo,
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
      i.weight AS item_weight,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs,
      ib.location AS location_id,
      BUILTIN.DF(ib.location) AS location,
      ib.quantityonhand AS quantity_on_hand,
      ib.quantityavailable AS quantity_available
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
      i.weight AS item_weight,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs,
      ib.location AS location_id,
      BUILTIN.DF(ib.location) AS location,
      ib.quantityonhand AS quantity_on_hand,
      ib.quantityavailable AS quantity_available
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
      t.custbody7 AS memo,
      t.location AS source_location_id,
      BUILTIN.DF(t.location) AS source_location,
      t.transferlocation AS destination_location_id,
      BUILTIN.DF(t.transferlocation) AS destination_location
    FROM transaction t
    WHERE t.id = ${id}
      AND t.type = 'TrnfrOrd'
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
      i.weight AS item_weight,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs,
      ib.location AS location_id,
      BUILTIN.DF(ib.location) AS location,
      ib.quantityonhand AS quantity_on_hand,
      ib.quantityavailable AS quantity_available
    FROM AggregateItemLocation ib
    INNER JOIN item i ON i.id = ib.item
    WHERE ib.item IN (${items.join(",")})
      AND ib.location IN (${locations.join(",")})
      AND i.isinactive = 'F'
    ORDER BY BUILTIN.DF(i.id), BUILTIN.DF(ib.location)
  `);
}
