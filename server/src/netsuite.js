import crypto from "node:crypto";
import { config, requireConfig } from "./config.js";
import { query } from "./db.js";

let suiteqlQueue = Promise.resolve();
let restMutationQueue = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function netsuiteFetch(url, options = {}) {
  const timeoutMs = Number(config.netsuite.requestTimeoutMs || 120000);
  const signal = options.signal || (AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
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

function isoDateDaysAgo(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function normalizeSuiteqlDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : isoDateDaysAgo(1);
}

function openLineQuantitySql(alias = "tl") {
  return `(ABS(NVL(${alias}.quantity, 0)) - ABS(NVL(${alias}.quantityshiprecv, 0)))`;
}

function openLineFilterSql(alias = "tl") {
  return `${openLineQuantitySql(alias)} > 0.000001`;
}

function deliveryOrderListQuery(locationId = 1, { createdFrom = "" } = {}) {
  const id = Number(locationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite location ID is required.");
  }
  const orderCreatedFrom = normalizeSuiteqlDate(createdFrom);

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
  AND tl.item IS NOT NULL
  AND tl.location = ${id}
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  AND (
    (t.status = 'B' AND t.createddate >= TO_DATE('${orderCreatedFrom}', 'YYYY-MM-DD'))
    OR BUILTIN.DF(t.status) LIKE '%Partially Fulfilled%'
  )
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
  t.foreigntotal,
  tl.location AS destination_location_id,
  BUILTIN.DF(tl.location) AS destination_location
FROM transaction t
INNER JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type = 'PurchOrd'
  AND tl.item IS NOT NULL
  AND tl.location = ${id}
  AND tl.mainline = 'F'
  AND (tl.taxline = 'F' OR tl.taxline IS NULL)
  AND (t.status = 'B' OR BUILTIN.DF(t.status) LIKE '%Partially Received%')
  AND ${openLineFilterSql("tl")}
ORDER BY t.trandate DESC, t.tranid DESC
`;
}

function transferOrderListQuery({ statusText, sourceLocationId = null, destinationLocationId = null, lineLocationId = null, lineDirection = "source" } = {}) {
  const sourceFilter = sourceLocationId ? `AND t.location = ${Number(sourceLocationId)}` : "";
  const destinationFilter = destinationLocationId ? `AND t.transferlocation = ${Number(destinationLocationId)}` : "";
  const lineLocationFilter = lineLocationId ? `AND tl.location = ${Number(lineLocationId)}` : "";
  const statusFilter = statusText === "Pending Fulfillment"
    ? "AND (t.status = 'B' OR BUILTIN.DF(t.status) LIKE '%Partially Fulfilled%')"
    : `AND (BUILTIN.DF(t.status) LIKE '%${statusText}%' OR BUILTIN.DF(t.status) LIKE '%Partially Received%')`;
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

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Math.abs(Number(String(value).replaceAll(",", ""))) || 0;
}

function derivePackQuantitiesFromConversion(line) {
  if (toNumber(line.pallet_qty) || toNumber(line.layer_qty) || toNumber(line.section_qty) || toNumber(line.piece_qty)) {
    return line;
  }
  let remaining = toNumber(line.quantity);
  const next = { ...line };
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
  if (!toNumber(next.pallet_qty) && !toNumber(next.layer_qty) && !toNumber(next.section_qty) && !toNumber(next.piece_qty)) {
    next.piece_qty = toNumber(line.quantity);
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
  const next = {
    ...line,
    quantity,
    pallet_qty: 0,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: 0
  };
  if (!hasConversion(next)) return next;
  return derivePackQuantitiesFromConversion(next);
}

function normalizeOpenDeliveryLine(line) {
  const orderedQuantity = toNumber(line.quantity);
  const processedQuantity = toNumber(line.netsuite_received_qty);
  const remainingQuantity = Math.max(orderedQuantity - processedQuantity, 0);
  if (processedQuantity <= 0) return line;
  return deriveQuantitiesFromSalesQuantity(line, remainingQuantity);
}

function normalizeTransferDetailLines(lines, { sourceLocationId = null, destinationLocationId = null } = {}) {
  const filtered = lines.filter((line) => {
    const quantity = Number(String(line.quantity || 0).replaceAll(",", ""));
    if (sourceLocationId && String(line.location_id) === String(sourceLocationId)) return quantity < 0;
    if (destinationLocationId && String(line.location_id) === String(destinationLocationId)) return quantity > 0;
    return true;
  });
  const seen = new Set();
  return filtered
    .map((line) => ({ ...line, quantity: toNumber(line.quantity) }))
    .map((line) => (sourceLocationId ? normalizeOpenDeliveryLine(line) : line))
    .filter((line) => {
      const key = [
        line.item_id,
        line.location_id,
        line.quantity,
        line.item_description || "",
        line.pallet_qty || "",
        line.layer_qty || "",
        line.section_qty || "",
        line.piece_qty || ""
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(derivePackQuantitiesFromConversion);
}

export function buildAuthorizationUrl() {
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
    const idMatch = location.match(/\/(?:itemFulfillment|itemReceipt)\/(\d+)/i);
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

export async function fetchDeliveryOrdersFromNetSuite(locationId = 1, { createdFrom = "" } = {}) {
  const result = await suiteql(deliveryOrderListQuery(locationId, { createdFrom }));
  return result.items || [];
}

export async function fetchTransferDeliveryOrdersFromNetSuite(locationId = 1) {
  const result = await suiteql(transferOrderListQuery({ statusText: "Pending Fulfillment", lineLocationId: locationId }));
  return (result.items || []).map((order) => ({
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
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
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
      t.lastmodifieddate
    FROM transaction t
    WHERE t.id = ${id}
      AND t.type = '${type}'
  `);
  return result.items?.[0] || null;
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
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
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
      tl.id AS line_id,
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
    ORDER BY tl.id
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
      tl.id AS line_id,
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
    ORDER BY tl.id
  `);
  return normalizeTransferDetailLines(result.items || [], direction === "destination"
    ? { destinationLocationId: locationId }
    : { sourceLocationId: locationId });
}

export async function fetchPurchaseOrdersFromNetSuite(locationId = 1) {
  const result = await suiteql(purchaseOrderListQuery(locationId));
  return (result.items || []).map((order) => ({ ...order, order_type: "purchase_order" }));
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
      t.foreigntotal,
      tl.location AS destination_location_id,
      BUILTIN.DF(tl.location) AS destination_location
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    WHERE t.id = ${id}
      AND t.type = 'PurchOrd'
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND (tl.taxline = 'F' OR tl.taxline IS NULL)
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
      tl.id AS line_id,
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
    ORDER BY tl.id
  `);
  return result.items || [];
}

export async function fetchTransferReceivingOrdersFromNetSuite({ sourceLocationId = null, destinationLocationId = null } = {}) {
  const result = await suiteql(transferOrderListQuery({
    statusText: "Pending Receipt",
    sourceLocationId,
    destinationLocationId,
    lineLocationId: destinationLocationId || null,
    lineDirection: "destination"
  }));
  return (result.items || []).map((order) => ({
    ...order,
    order_type: "transfer_order",
    source_location_id: order.source_location_id,
    source_location: order.source_location,
    vendor_id: order.source_location_id,
    vendor: order.source_location
  }));
}

export async function fetchTransferReceivingOrderFromNetSuite(orderId, sourceLocationId = null) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transfer order ID is required.");
  }
  const sourceFilter = sourceLocationId ? `AND t.location = ${Number(sourceLocationId)}` : "";
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
      ${sourceFilter}
    ORDER BY t.trandate DESC
  `);
  const order = result.items?.[0];
  if (!order) return null;
  return {
    ...order,
    order_type: "transfer_order",
    source_location_id: order.source_location_id,
    source_location: order.source_location,
    vendor_id: order.source_location_id,
    vendor: order.source_location
  };
}

export async function fetchInventoryBalancesFromNetSuite(locationIds = [1, 13]) {
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
