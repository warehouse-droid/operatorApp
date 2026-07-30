import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import {
  assertCrossYardReturn,
  canonicalReturnQuantity,
  deriveStockReturnStatus,
  effectiveReturnPolicy,
  returnBalance
} from "./return-policy.js";
import {
  attachReturnSalesOrderRestLineMapping,
  CONFIRMED_RETURN_REASONS,
  fetchLinkedReturnTransaction,
  fetchPalletBalanceFromNetSuite,
  fetchReturnCustomerFromNetSuite,
  fetchReturnReasonsFromNetSuite,
  fetchReturnSalesOrderFromNetSuite,
  fetchStockReturnsFromNetSuite,
  findCreditMemosFromReturnAuthorization,
  findReturnTransactionByExternalId,
  upsertPalletCreditMemoInNetSuite,
  upsertReturnAuthorizationInNetSuite
} from "./return-netsuite.js";
import {
  getLocalReturnCustomerById,
  searchReturnCustomerDirectory
} from "./return-customer-directory.js";
import {
  createPhotoReadToken,
  isOperatorReturnPhotoForActor,
  normalizeR2Key
} from "./photo-upload.js";
import { readArchivedPhoto } from "./photo-archive-repository.js";

export const RETURN_YARDS = Object.freeze([
  { locationId: 1, yardCode: "3445", name: "3445" },
  { locationId: 28, yardCode: "2967", name: "2967" },
  { locationId: 15, yardCode: "12441", name: "12441" },
  { locationId: 26, yardCode: "150", name: "150" }
]);

const RETURN_YARD_BY_ID = new Map(RETURN_YARDS.map((yard) => [yard.locationId, yard]));
const QUALITY_REASON_IDS = new Set([5, 6, 7, 8, 9]);
const NORMAL_REASON_ID = 10;
const RESERVING_APPROVAL_STATUSES = ["not_required", "pending", "approved"];
const MAX_PHOTOS = 5;
const QUANTITY_EPSILON = 0.000001;
const RETURN_REASON_DB_CACHE_TTL_MS = 10 * 60 * 1000;
let returnReasonRefreshPromise = null;
const TORONTO_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function httpError(status, message, fields = {}) {
  return Object.assign(new Error(message), { status, ...fields });
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, `A valid ${label} is required.`);
  return id;
}

function optionalPositiveId(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return positiveId(value, label);
}

function cleanText(value, label, maxLength, { required = false } = {}) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (required && !text) throw httpError(400, `${label} is required.`);
  if (text.length > maxLength) throw httpError(400, `${label} must be ${maxLength} characters or fewer.`);
  return text;
}

function cleanVehiclePlate(value) {
  return cleanText(value, "Vehicle plate", 32, { required: true }).toUpperCase();
}

function quantity(value, label, { whole = false, positive = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (whole && !Number.isInteger(number)) || (positive && !(number > 0))) {
    const qualifier = positive ? "above zero" : whole ? "a non-negative whole number" : "a non-negative number";
    throw httpError(400, `${label} must be ${qualifier}.`);
  }
  return Math.round(number * 1e8) / 1e8;
}

function dateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(400, "Return date is invalid.");
  const parts = Object.fromEntries(
    TORONTO_DATE_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function yard(locationId) {
  const location = RETURN_YARD_BY_ID.get(Number(locationId));
  if (!location) throw httpError(400, "Select a valid receiving yard.");
  return location;
}

function normalizePhotos(values, label, { operatorId } = {}) {
  const source = Array.isArray(values) ? values : values ? [values] : [];
  if (source.length > MAX_PHOTOS) throw httpError(400, `${label} cannot contain more than ${MAX_PHOTOS} photos.`);
  return source.map((value, index) => {
    const reference = typeof value === "string"
      ? value
      : value?.reference || value?.photoReference || value?.url || "";
    const clean = String(reference || "").trim();
    if (!clean) throw httpError(400, `${label} photo ${index + 1} is empty.`);
    if (clean.length > 15 * 1024 * 1024) throw httpError(413, `${label} photo ${index + 1} is too large.`);
    const key = normalizeR2Key(clean);
    if (!clean.startsWith("r2://") || !key || !isOperatorReturnPhotoForActor(key, operatorId)) {
      throw httpError(400, `${label} photo ${index + 1} must be a completed application photo upload.`);
    }
    return `r2://${key}`;
  });
}

async function verifyReturnPhotos(references, operatorId) {
  const unique = [...new Set(references.filter(Boolean))];
  for (const reference of unique) {
    const archived = await readArchivedPhoto(reference);
    if (archived?.available) continue;
    if (archived?.found && archived.remoteDeleted) {
      throw httpError(409, "A return photo archive is unavailable. Upload that photo again.");
    }
    const ticket = createPhotoReadToken({
      actor: { id: operatorId, role: "operator" },
      key: reference,
      options: { ttlMinutes: 2 }
    });
    let response;
    try {
      response = await fetch(ticket.objectUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${ticket.token}`,
          Range: "bytes=0-0"
        }
      });
    } catch {
      throw httpError(409, "A return photo could not be verified. Check the connection and upload it again.");
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok || !contentType.startsWith("image/")) {
      await response.body?.cancel().catch(() => null);
      throw httpError(409, "A return photo is missing or is not a valid image. Upload it again.");
    }
    await response.body?.cancel().catch(() => null);
  }
}

function normalizedStockReturnType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!["normal", "quality"].includes(type)) {
    throw httpError(400, "Select Normal or Quality Stock Return.");
  }
  return type;
}

function normalizedIdempotencyKey(input = {}, operatorId = "") {
  const explicit = cleanText(input.idempotencyKey || input.clientRequestId || "", "Idempotency key", 180);
  if (explicit) return `client:${operatorId}:${explicit}`;
  const draftId = cleanText(input.draftId || "", "Draft ID", 80);
  if (draftId) return `draft:${operatorId}:${draftId}`;
  // A five-minute fingerprint protects an un-drafted request retry without
  // preventing a later, legitimately identical physical return.
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({
      operatorId,
      bucket,
      receivingLocationId: input.receivingLocationId,
      orderId: input.orderId,
      customerId: input.customerId,
      vehiclePlate: input.vehiclePlate,
      stockReturnType: input.stockReturnType || input.type,
      lines: input.lines,
      palletQuantity: input.palletQuantity,
      photos: input.photos,
      palletPhotos: input.palletPhotos
    }))
    .digest("hex");
  return `fallback:${fingerprint}`;
}

function publicYardSettings(row = {}) {
  return {
    locationId: Number(row.location_id),
    yardCode: row.yard_code || "",
    allowCrossYardReturns: Boolean(row.allow_cross_yard_returns),
    crossYardExplanation: "Allowing cross-yard stock returns for this yard means this yard accepts stock from both its own orders and other-yard orders. Customer-level PALLET returns are accepted at every yard.",
    autoCreateStockRa: Boolean(row.auto_create_stock_ra),
    autoCreatePalletCreditMemo: Boolean(row.auto_create_pallet_credit_memo),
    automationWarning: "NetSuite return automation is off by default. Test each yard in a NetSuite sandbox before enabling.",
    stockRaLimitation: "Returns with multiple reason rows on the same Sales Order line stay local and require a manually linked Return Authorization.",
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null
  };
}

export async function listReturnYardSettings() {
  const result = await query(
    `SELECT *
       FROM return_yard_settings
      ORDER BY CASE yard_code WHEN '3445' THEN 1 WHEN '2967' THEN 2 WHEN '12441' THEN 3 ELSE 4 END`
  );
  return result.rows.map(publicYardSettings);
}

export async function getReturnYardSettings(locationId) {
  const location = yard(locationId);
  const result = await query("SELECT * FROM return_yard_settings WHERE location_id = $1", [location.locationId]);
  if (!result.rowCount) throw httpError(404, "Return settings were not found for this yard.");
  return publicYardSettings(result.rows[0]);
}

export async function updateReturnYardSettings(locationId, input = {}, {
  operatorId,
  allowCrossYard = false,
  allowAutomation = false
} = {}) {
  const location = yard(locationId);
  const hasCross = Object.hasOwn(input, "allowCrossYardReturns");
  const hasStockRa = Object.hasOwn(input, "autoCreateStockRa");
  const hasPalletCm = Object.hasOwn(input, "autoCreatePalletCreditMemo");
  if (hasCross && !allowCrossYard) throw httpError(403, "Admin access is required to change cross-yard returns.");
  if ((hasStockRa || hasPalletCm) && !allowAutomation) throw httpError(403, "Admin access is required to change NetSuite return automation.");
  for (const [supplied, key] of [
    [hasCross, "allowCrossYardReturns"],
    [hasStockRa, "autoCreateStockRa"],
    [hasPalletCm, "autoCreatePalletCreditMemo"]
  ]) {
    if (supplied && typeof input[key] !== "boolean") {
      throw httpError(400, `${key} must be true or false.`);
    }
  }
  return withTransaction(async () => {
    const locked = await query(
      "SELECT * FROM return_yard_settings WHERE location_id = $1 FOR UPDATE",
      [location.locationId]
    );
    if (!locked.rowCount) throw httpError(404, "Return settings were not found for this yard.");
    const current = publicYardSettings(locked.rows[0]);
    const next = {
      allowCrossYardReturns: hasCross ? input.allowCrossYardReturns : current.allowCrossYardReturns,
      autoCreateStockRa: hasStockRa ? input.autoCreateStockRa : current.autoCreateStockRa,
      autoCreatePalletCreditMemo: hasPalletCm
        ? input.autoCreatePalletCreditMemo
        : current.autoCreatePalletCreditMemo
    };
    const changed = next.allowCrossYardReturns !== current.allowCrossYardReturns
      || next.autoCreateStockRa !== current.autoCreateStockRa
      || next.autoCreatePalletCreditMemo !== current.autoCreatePalletCreditMemo;
    const result = await query(
      `UPDATE return_yard_settings
          SET allow_cross_yard_returns = $2,
              auto_create_stock_ra = $3,
              auto_create_pallet_credit_memo = $4,
              updated_by = CASE WHEN $6::boolean THEN $5 ELSE updated_by END,
              updated_at = CASE WHEN $6::boolean THEN now() ELSE updated_at END
        WHERE location_id = $1
        RETURNING *`,
      [
        current.locationId,
        next.allowCrossYardReturns,
        next.autoCreateStockRa,
        next.autoCreatePalletCreditMemo,
        operatorId || null,
        changed
      ]
    );
    const after = publicYardSettings(result.rows[0]);
    if (changed) {
      await writeAudit({
        actorOperatorId: operatorId,
        source: "returns",
        action: "returns.yard_settings.update",
        details: { locationId: current.locationId, before: current, after }
      });
    }
    return after;
  });
}

export async function localPalletReserved(customerId, observedExternalIds = [], observedTransactionIds = []) {
  const result = await query(
    `SELECT COALESCE(SUM(r.pallet_quantity), 0) AS reserved
       FROM return_records r
      WHERE r.record_type = 'pallet'
        AND r.customer_id = $1
        AND r.status NOT IN ('rejected', 'voided')
        AND NOT (r.external_id = ANY($2::text[]))
        AND (
          r.netsuite_transaction_id IS NULL
          OR NOT (r.netsuite_transaction_id = ANY($3::bigint[]))
        )`,
    [
      customerId,
      observedExternalIds.map(String).filter(Boolean),
      observedTransactionIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    ]
  );
  return Number(result.rows[0]?.reserved || 0);
}

export async function localStockReserved(sourceLineIds = [], observedExternalIds = [], observedTransactionIds = []) {
  const lineIds = [...new Set(sourceLineIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!lineIds.length) return new Map();
  const result = await query(
    `SELECT l.source_sales_order_line_id,
            COALESCE(SUM(l.returned_sales_quantity), 0) AS reserved
       FROM return_record_lines l
       INNER JOIN return_records r ON r.id = l.return_record_id
      WHERE l.source_sales_order_line_id = ANY($1::bigint[])
        AND l.approval_status = ANY($2::text[])
        AND r.status NOT IN ('rejected', 'voided')
        AND NOT (r.external_id = ANY($3::text[]))
        AND (
          r.netsuite_transaction_id IS NULL
          OR NOT (r.netsuite_transaction_id = ANY($4::bigint[]))
        )
      GROUP BY l.source_sales_order_line_id`,
    [
      lineIds,
      RESERVING_APPROVAL_STATUSES,
      observedExternalIds.map(String).filter(Boolean),
      observedTransactionIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    ]
  );
  return new Map(result.rows.map((row) => [
    String(row.source_sales_order_line_id),
    Number(row.reserved || 0)
  ]));
}

async function returnPolicies(itemIds = []) {
  const ids = [...new Set(itemIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT item_id, product_type, return_policy_override
       FROM inventory_items
      WHERE item_id = ANY($1::bigint[])`,
    [ids]
  );
  return new Map(result.rows.map((row) => [String(row.item_id), row]));
}

async function customerPalletBalance(customer, remoteBalance = null, { force = false } = {}) {
  const remote = remoteBalance || await fetchPalletBalanceFromNetSuite(
    customer.id || customer.internalId,
    { force }
  );
  const localReserved = await localPalletReserved(
    customer.id || customer.internalId,
    remote.externalIds || [],
    remote.transactionIds || []
  );
  return {
    customer,
    item: remote.item,
    externalIds: remote.externalIds || [],
    transactionIds: remote.transactionIds || [],
    ...returnBalance({
      fulfilled: remote.fulfilled,
      netsuiteReturned: remote.netsuiteReturned,
      localReserved
    }),
    lookedUpAt: remote.lookedUpAt || new Date().toISOString()
  };
}

export async function lookupReturnCustomerPalletBalance(customerId) {
  let customer = null;
  try {
    customer = await getLocalReturnCustomerById(customerId);
  } catch (error) {
    console.error("Local Return customer lookup failed; using NetSuite:", error.message);
  }
  customer ||= await fetchReturnCustomerFromNetSuite(customerId);
  if (!customer) throw httpError(404, "Active NetSuite customer was not found.");
  return customerPalletBalance(customer);
}

export async function searchReturnCustomers(search, options = {}) {
  return searchReturnCustomerDirectory(search, options);
}

function isPhysicalItem(line) {
  const type = String(line.itemType || line.itemTypeText || "").toLowerCase();
  return type.includes("invtpart")
    || type.includes("inventory")
    || type.includes("noninvtpart")
    || type.includes("non-inventory");
}

export function assertReturnOrderFullyFulfilled(order = {}) {
  const statusText = String(order.statusText || order.status_text || "").trim();
  const status = String(order.status || "").trim();
  const normalized = `${status} ${statusText}`.replace(/\s+/g, " ").trim().toUpperCase();
  const rawCode = status.toUpperCase().match(/(?:^|:)([A-Z])$/)?.[1] || "";
  const blockedCode = ["A", "B", "C", "D", "E", "Y"].includes(rawCode);
  const blockedText = [
    "PENDING APPROVAL",
    "PENDING FULFILLMENT",
    "PARTIALLY FULFILLED",
    "CANCELLED",
    "CANCELED",
    "UNDEFINED"
  ].some((value) => normalized.includes(value));
  const closed = rawCode === "H" || normalized.includes("CLOSED");
  const incompleteClosedLine = closed && (order.lines || [])
    .filter((line) => isPhysicalItem(line))
    .some((line) => Number(line.fulfilledQuantity || 0) + QUANTITY_EPSILON
      < Number(line.salesQuantity || 0));
  if (!blockedCode && !blockedText && !incompleteClosedLine) {
    return;
  }
  const displayedStatus = statusText || status || "not fully fulfilled";
  throw httpError(
    409,
    `Sales Order ${order.tranid || order.id || ""} is ${displayedStatus}. Only fully fulfilled Sales Orders can be returned.`,
    {
      code: "ORDER_NOT_FULLY_FULFILLED",
      orderStatus: status,
      orderStatusText: statusText
    }
  );
}

export async function lookupReturnSalesOrder({
  code,
  receivingLocationId,
  includeStockReturns = true,
  includeNetSuiteOrderLines = false,
  includePalletBalance = true,
  enforceYardRestriction = true,
  forcePalletBalance = false
} = {}) {
  const receiving = yard(receivingLocationId);
  let [order, settings] = await Promise.all([
    fetchReturnSalesOrderFromNetSuite(code, {
      includeRestLineMapping: false
    }),
    getReturnYardSettings(receiving.locationId)
  ]);
  if (!order) throw httpError(404, "Sales Order was not found in NetSuite.");
  // The first SO-lines response already contains the authoritative header
  // status. Fail here before PALLET/stock history or REST line expansion.
  assertReturnOrderFullyFulfilled(order);
  if (!order.orderingLocationId) {
    const prefix = String(order.tranid || "").toUpperCase();
    const fallback = prefix.startsWith("SOA")
      ? RETURN_YARD_BY_ID.get(28)
      : prefix.startsWith("SOB")
        ? RETURN_YARD_BY_ID.get(1)
        : prefix.startsWith("SOM")
          ? RETURN_YARD_BY_ID.get(26)
          : null;
    if (!fallback) throw httpError(409, "This Sales Order has no ordering yard in NetSuite.");
    order.orderingLocationId = fallback.locationId;
    order.orderingLocationName = fallback.name;
    order.orderingLocationSource = "order_prefix_fallback";
  } else {
    order.orderingLocationSource = "netsuite_header";
  }
  const defaultReturnLocation = RETURN_YARD_BY_ID.get(Number(order.orderingLocationId)) || {
    locationId: Number(order.orderingLocationId),
    yardCode: order.orderingLocationName || String(order.orderingLocationId),
    name: order.orderingLocationName || String(order.orderingLocationId)
  };
  const crossYard = Number(order.orderingLocationId) !== receiving.locationId;
  const crossYardAllowed = !enforceYardRestriction
    || !crossYard
    || settings.allowCrossYardReturns;

  // Reject immediately after the authoritative SO-header check. Do not spend
  // more NetSuite calls on return history, PALLET history, or REST order-line
  // expansion for a stock return this yard cannot receive. PALLET-only returns
  // are customer-level and may be received at any operator yard.
  if (!crossYardAllowed) {
    throw httpError(
      409,
      `This return must be processed at ${defaultReturnLocation.yardCode || defaultReturnLocation.name}.`,
      {
        code: "CROSS_YARD_RETURN_BLOCKED",
        requiredReturnLocation: defaultReturnLocation,
        receivingLocation: receiving
      }
    );
  }

  const [mappedOrder, remoteReturns, policies, palletBalance] = await Promise.all([
    includeStockReturns && includeNetSuiteOrderLines
      ? attachReturnSalesOrderRestLineMapping(order)
      : Promise.resolve(order),
    includeStockReturns ? fetchStockReturnsFromNetSuite(order.id) : Promise.resolve(new Map()),
    includeStockReturns
      ? returnPolicies(order.lines.map((line) => line.itemId))
      : Promise.resolve(new Map()),
    includePalletBalance
      ? customerPalletBalance(order.customer, null, { force: forcePalletBalance })
      : Promise.resolve(null)
  ]);
  order = mappedOrder;
  const observedStockExternalIds = [...remoteReturns.values()]
    .flatMap((line) => line.transactions || [])
    .flatMap((transaction) => [
      transaction.externalId,
      ...(transaction.linkedCreditMemos || []).map((credit) => credit.externalId)
    ])
    .filter(Boolean);
  const observedStockTransactionIds = [...remoteReturns.values()]
    .flatMap((line) => line.transactions || [])
    .flatMap((transaction) => [
      transaction.id,
      ...(transaction.linkedCreditMemos || []).map((credit) => credit.id)
    ])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const localReserved = includeStockReturns
    ? await localStockReserved(
      order.lines.map((line) => line.sourceLineId),
      observedStockExternalIds,
      observedStockTransactionIds
    )
    : new Map();

  const lines = (includeStockReturns ? order.lines : [])
    .filter((line) => isPhysicalItem(line))
    .filter((line) => Number(line.itemId) !== Number(palletBalance?.item?.id || palletBalance?.item?.itemId)
      && String(line.itemName || "").trim().toUpperCase() !== "PALLET")
    .map((line) => {
      const stored = policies.get(String(line.itemId)) || {};
      const policy = effectiveReturnPolicy({
        productType: stored.product_type || line.productType,
        override: stored.return_policy_override
      });
      const remote = remoteReturns.get(String(line.sourceLineId)) || {};
      const reserved = localReserved.get(String(line.sourceLineId)) || 0;
      const balance = returnBalance({
        fulfilled: line.fulfilledQuantity,
        netsuiteReturned: remote.netsuiteReturned,
        localReserved: reserved
      });
      const hasConversion = [line.toPlt, line.toLyr, line.toSec, line.toPcs].some((value) => Number(value) > 0);
      return {
        ...line,
        ...balance,
        remainingReturnable: balance.available,
        entryMode: hasConversion ? "physical_units" : "sales_uom",
        returnPolicy: {
          default: policy.default,
          override: policy.override,
          effective: policy.effective,
          source: policy.source,
          requiresApproval: policy.effective === "APPROVAL_REQUIRED"
        },
        netsuiteReturnTransactions: remote.transactions || []
      };
    })
    .filter((line) => line.returnPolicy.effective !== "NOT_RETURNABLE")
    .filter((line) => Number(line.remainingReturnable) > QUANTITY_EPSILON);
  return {
    order: { ...order, lines: undefined },
    customer: order.customer,
    defaultReturnLocation,
    receivingLocation: receiving,
    crossYard,
    crossYardAllowed,
    crossYardBlocked: false,
    returnAllowed: true,
    crossYardExplanation: settings.crossYardExplanation,
    requiredReturnLocation: crossYardAllowed ? null : defaultReturnLocation,
    lines,
    palletBalance,
    observedStockExternalIds,
    observedStockTransactionIds,
    lookedUpAt: new Date().toISOString()
  };
}

function publicReturnReasons(options, {
  source = "database_cache",
  fetchedAt = new Date().toISOString()
} = {}) {
  const normalReason = options.find((option) => option.id === NORMAL_REASON_ID);
  return {
    normalReason,
    qualityReasons: options.filter((option) => QUALITY_REASON_IDS.has(option.id)),
    source,
    fetchedAt
  };
}

async function cachedReturnReasons() {
  const result = await query(
    `SELECT reason_id, reason_code, reason_label, source, fetched_at
       FROM return_reason_cache
      WHERE active = true
        AND reason_id = ANY($1::bigint[])
      ORDER BY reason_id`,
    [[...QUALITY_REASON_IDS, NORMAL_REASON_ID]]
  );
  const options = result.rows.map((row) => ({
    id: Number(row.reason_id),
    code: row.reason_code,
    label: row.reason_label,
    kind: Number(row.reason_id) === NORMAL_REASON_ID ? "normal" : "quality"
  }));
  const expectedIds = [...QUALITY_REASON_IDS, NORMAL_REASON_ID].sort((left, right) => left - right);
  if (options.length !== expectedIds.length
      || options.some((option, index) => option.id !== expectedIds[index])) {
    return null;
  }
  const fetchedTimes = result.rows
    .map((row) => new Date(row.fetched_at).getTime())
    .filter(Number.isFinite);
  const oldestFetchedAt = fetchedTimes.length ? Math.min(...fetchedTimes) : 0;
  const newestFetchedAt = fetchedTimes.length ? Math.max(...fetchedTimes) : 0;
  const sources = [...new Set(result.rows.map((row) => row.source).filter(Boolean))];
  return {
    ...publicReturnReasons(options, {
      source: sources.length === 1 ? sources[0] : "database_cache",
      fetchedAt: newestFetchedAt ? new Date(newestFetchedAt).toISOString() : new Date(0).toISOString()
    }),
    stale: !oldestFetchedAt || Date.now() - oldestFetchedAt > RETURN_REASON_DB_CACHE_TTL_MS
  };
}

async function refreshReturnReasons() {
  if (returnReasonRefreshPromise) return returnReasonRefreshPromise;
  returnReasonRefreshPromise = (async () => {
    const result = await fetchReturnReasonsFromNetSuite({ force: true });
    const options = result.options
      .filter((option) => QUALITY_REASON_IDS.has(Number(option.id)) || Number(option.id) === NORMAL_REASON_ID)
      .sort((left, right) => Number(left.id) - Number(right.id));
    await query(
      `INSERT INTO return_reason_cache (
         reason_id, reason_code, reason_label, active, source, fetched_at
       )
       SELECT reason_id, reason_code, reason_label, true, $4, now()
         FROM UNNEST($1::bigint[], $2::text[], $3::text[])
              AS reason(reason_id, reason_code, reason_label)
       ON CONFLICT (reason_id) DO UPDATE SET
         reason_code = EXCLUDED.reason_code,
         reason_label = EXCLUDED.reason_label,
         active = true,
         source = EXCLUDED.source,
         fetched_at = now()`,
      [
        options.map((option) => Number(option.id)),
        options.map((option) => option.code),
        options.map((option) => option.label),
        result.source
      ]
    );
    return publicReturnReasons(options, {
      source: result.source,
      fetchedAt: new Date().toISOString()
    });
  })();
  try {
    return await returnReasonRefreshPromise;
  } finally {
    returnReasonRefreshPromise = null;
  }
}

export async function getReturnReasons({ refresh = false } = {}) {
  const cached = await cachedReturnReasons();
  if (!refresh && cached) {
    if (cached.stale) void refreshReturnReasons().catch(() => {});
    const { stale, ...response } = cached;
    return response;
  }
  try {
    return await refreshReturnReasons();
  } catch (error) {
    if (cached) {
      const { stale, ...response } = cached;
      return response;
    }
    throw error;
  }
}

async function pruneExpiredReturnDrafts() {
  const expired = await query(
    `DELETE FROM return_drafts
      WHERE expires_at <= now()
      RETURNING id, operator_id, receiving_location_id`
  );
  if (expired.rowCount) {
    await writeAudit({
      actorType: "system",
      source: "returns",
      action: "returns.draft.expire",
      details: {
        count: expired.rowCount,
        drafts: expired.rows.slice(0, 100).map((row) => ({
          draftId: row.id,
          ownerOperatorId: row.operator_id,
          receivingLocationId: Number(row.receiving_location_id)
        }))
      }
    });
  }
}

function publicDraft(row = {}) {
  return {
    payload: row.payload || {},
    ...(row.payload && typeof row.payload === "object" ? row.payload : {}),
    id: row.id,
    draftId: row.id,
    operatorId: row.operator_id,
    receivingLocationId: Number(row.receiving_location_id),
    type: row.draft_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

export async function listReturnDrafts({ operatorId, receivingLocationId = null } = {}) {
  await pruneExpiredReturnDrafts();
  const params = [operatorId];
  const location = receivingLocationId ? yard(receivingLocationId) : null;
  const locationClause = location ? `AND receiving_location_id = $2` : "";
  if (location) params.push(location.locationId);
  const result = await query(
    `SELECT *
       FROM return_drafts
      WHERE operator_id = $1
        ${locationClause}
        AND expires_at > now()
      ORDER BY updated_at DESC`,
    params
  );
  return result.rows.map(publicDraft);
}

function publicControlDraft(row = {}) {
  const draft = publicDraft(row);
  const payload = row.payload || {};
  const lookup = payload.lookup || {};
  const sourceLines = Array.isArray(lookup.lines) ? lookup.lines : [];
  const lines = (Array.isArray(payload.lines) ? payload.lines : []).map((saved) => {
    const sourceLineId = Number(saved.sourceLineId ?? saved.source_line_id);
    const source = sourceLines.find((line) =>
      Number(line.sourceLineId ?? line.source_line_id ?? line.lineId ?? line.line_id) === sourceLineId) || {};
    const policy = source.returnPolicy || source.return_policy || {};
    return {
      ...source,
      ...saved,
      sourceLineId,
      itemName: source.itemName || source.item_name || saved.itemName || saved.item_name || "",
      description: source.description || source.itemDescription || source.item_description || "",
      salesUom: source.salesUom || source.sales_uom || "",
      returnedSalesQuantity: Number(saved.salesQuantity ?? saved.sales_quantity ?? 0),
      reasonLabel: saved.reasonLabel || saved.reason_label || "",
      returnPolicyEffective: policy.effective || source.returnPolicyEffective || source.return_policy_effective || "",
      approvalStatus: policy.requiresApproval ? "pending" : "not_required"
    };
  });
  const customer = payload.customer || lookup.customer || {};
  const order = payload.order || lookup.order || {};
  return {
    ...draft,
    isDraft: true,
    draftType: row.draft_type,
    recordType: row.draft_type,
    stockReturnType: payload.stockReturnType || payload.stock_return_type || null,
    status: "draft",
    reference: `Draft ${String(row.id || "").slice(0, 8)}`,
    recordReference: "",
    batchReference: "",
    operatorName: row.operator_name || "",
    customerId: customer.id || payload.customerId || null,
    customerCode: customer.code || customer.entityId || customer.entity_id
      || payload.customerCode || payload.customer_code || "",
    customerName: customer.name || customer.companyName || payload.customerName || "",
    sourceSalesOrderRef: order.tranid || payload.orderRef || payload.orderCode || payload.salesOrderNumber || "",
    orderingLocationId: order.orderingLocationId || order.ordering_location_id
      || lookup.orderingLocationId || lookup.ordering_location_id
      || payload.orderingLocationId || payload.ordering_location_id || null,
    orderingLocationName: order.orderingLocationName || order.ordering_location_name
      || lookup.orderingLocationName || lookup.ordering_location_name
      || payload.orderingLocationName || payload.ordering_location_name || "",
    vehiclePlate: payload.vehiclePlate || "",
    note: payload.note || "",
    palletQuantity: Number(payload.palletQuantity ?? payload.pallet_quantity ?? 0),
    lines,
    submittedAt: null
  };
}

export async function listReturnDraftsForControl({
  receivingLocationIds = null,
  receivingLocationId = null,
  search = "",
  returnType = "",
  from = "",
  to = "",
  limit = 100,
  offset = 0
} = {}) {
  await pruneExpiredReturnDrafts();
  const params = [];
  const clauses = ["d.expires_at > now()"];
  if (receivingLocationId) {
    params.push(yard(receivingLocationId).locationId);
    clauses.push(`d.receiving_location_id = $${params.length}`);
  }
  if (receivingLocationIds?.length) {
    params.push(receivingLocationIds.map(Number));
    clauses.push(`d.receiving_location_id = ANY($${params.length}::bigint[])`);
  }
  const cleanSearch = cleanText(search, "Search", 120);
  if (cleanSearch) {
    params.push(`%${cleanSearch}%`);
    clauses.push(`(
      d.id::text ILIKE $${params.length}
      OR d.payload::text ILIKE $${params.length}
      OR op.display_name ILIKE $${params.length}
    )`);
  }
  const cleanType = String(returnType || "").trim().toLowerCase();
  if (cleanType === "pallet") {
    clauses.push("d.draft_type IN ('pallet', 'combined')");
  } else if (["normal_stock", "quality_stock", "stock"].includes(cleanType)) {
    clauses.push("d.draft_type IN ('stock', 'combined')");
    if (cleanType !== "stock") {
      params.push(cleanType === "quality_stock" ? "quality" : "normal");
      clauses.push(`COALESCE(d.payload->>'stockReturnType', d.payload->>'stock_return_type', 'normal') = $${params.length}`);
    }
  }
  if (from) {
    params.push(String(from).slice(0, 10));
    clauses.push(`d.updated_at >= $${params.length}::date`);
  }
  if (to) {
    params.push(String(to).slice(0, 10));
    clauses.push(`d.updated_at < ($${params.length}::date + interval '1 day')`);
  }
  const count = await query(
    `SELECT COUNT(*)::int AS total
       FROM return_drafts d
       LEFT JOIN operators op ON op.id = d.operator_id
      WHERE ${clauses.join(" AND ")}`,
    params
  );
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  params.push(Math.max(0, Number(offset) || 0));
  const result = await query(
    `SELECT d.*, op.display_name AS operator_name
       FROM return_drafts d
       LEFT JOIN operators op ON op.id = d.operator_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY d.updated_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}`,
    params
  );
  return {
    records: result.rows.map(publicControlDraft),
    total: Number(count.rows[0]?.total || 0)
  };
}

export async function getReturnDraftForControl(draftId, { receivingLocationIds = null } = {}) {
  const params = [String(draftId || "")];
  const clauses = ["d.id::text = $1", "d.expires_at > now()"];
  if (receivingLocationIds?.length) {
    params.push(receivingLocationIds.map(Number));
    clauses.push(`d.receiving_location_id = ANY($2::bigint[])`);
  }
  const result = await query(
    `SELECT d.*, op.display_name AS operator_name
       FROM return_drafts d
       LEFT JOIN operators op ON op.id = d.operator_id
      WHERE ${clauses.join(" AND ")}`,
    params
  );
  return result.rowCount ? publicControlDraft(result.rows[0]) : null;
}

export async function discardReturnDraftForControl({
  draftId,
  actorOperatorId,
  receivingLocationIds = null,
  reason = ""
} = {}) {
  const cleanReason = cleanText(reason, "Discard reason", 1000);
  return withTransaction(async () => {
    const params = [String(draftId || "")];
    const yardClause = receivingLocationIds?.length
      ? `AND receiving_location_id = ANY($2::bigint[])`
      : "";
    if (receivingLocationIds?.length) params.push(receivingLocationIds.map(Number));
    const result = await query(
      `DELETE FROM return_drafts
        WHERE id::text = $1
          ${yardClause}
        RETURNING id, operator_id, receiving_location_id, payload`,
      params
    );
    if (!result.rowCount) throw httpError(404, "Return draft was not found.");
    const draft = result.rows[0];
    await writeAudit({
      actorOperatorId,
      source: "returns",
      action: "returns.draft.discard",
      details: {
        draftId: draft.id,
        ownerOperatorId: draft.operator_id,
        receivingLocationId: Number(draft.receiving_location_id),
        reason: cleanReason
      }
    });
    return { discarded: true, draftId: draft.id, reason: cleanReason };
  });
}

export async function saveReturnDraft({ operatorId, input = {} } = {}) {
  await pruneExpiredReturnDrafts();
  const receiving = yard(input.receivingLocationId);
  const suppliedId = cleanText(input.draftId || input.id || "", "Draft ID", 80);
  if (suppliedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedId)) {
    throw httpError(400, "Draft ID is invalid.");
  }
  const id = suppliedId || crypto.randomUUID();
  const requestedType = String(input.draftType || input.type || "").toLowerCase();
  const type = ["stock", "pallet", "combined"].includes(requestedType)
    ? requestedType
    : input.orderId && Number(input.palletQuantity) > 0
      ? "combined"
      : input.orderId
        ? "stock"
        : "pallet";
  if (!["stock", "pallet", "combined"].includes(type)) throw httpError(400, "Select a valid return draft type.");
  const draftLines = Array.isArray(input.lines)
    ? input.lines.map((line, index) => ({
        ...line,
        photos: normalizePhotos(line?.photos, `Draft return line ${index + 1}`, { operatorId })
      }))
    : [];
  const draftPhotos = normalizePhotos(input.photos || input.stockPhotos, "Draft stock return", { operatorId });
  const draftPalletPhotos = normalizePhotos(input.palletPhotos, "Draft PALLET return", { operatorId });
  return withTransaction(async () => {
    const existing = await query(
      `SELECT *
         FROM return_drafts
        WHERE id = $1
          AND operator_id = $2
          AND expires_at > now()
        FOR UPDATE`,
      [id, operatorId]
    );
    if (existing.rowCount && Number(existing.rows[0].receiving_location_id) !== receiving.locationId) {
      throw httpError(409, "The receiving yard is locked. Discard this draft and start again to change yards.");
    }
    const payload = {
      ...input,
      lines: draftLines,
      photos: draftPhotos,
      palletPhotos: draftPalletPhotos,
      draftId: id,
      idempotencyKey: input.idempotencyKey || existing.rows[0]?.payload?.idempotencyKey || crypto.randomUUID(),
      receivingLocationId: receiving.locationId
    };
    const result = await query(
      `INSERT INTO return_drafts (
         id, operator_id, receiving_location_id, draft_type, payload, expires_at
       ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, now() + interval '7 days')
       ON CONFLICT (id) DO UPDATE SET
         draft_type = EXCLUDED.draft_type,
         payload = EXCLUDED.payload,
         updated_at = now(),
         expires_at = now() + interval '7 days'
       WHERE return_drafts.operator_id = EXCLUDED.operator_id
         AND return_drafts.receiving_location_id = EXCLUDED.receiving_location_id
       RETURNING *`,
      [id, operatorId, receiving.locationId, type, JSON.stringify(payload)]
    );
    if (!result.rowCount) throw httpError(409, "This draft belongs to another operator or receiving yard.");
    await writeAudit({
      actorOperatorId: operatorId,
      source: "returns",
      action: existing.rowCount ? "returns.draft.update" : "returns.draft.create",
      details: {
        draftId: id,
        ownerOperatorId: operatorId,
        receivingLocationId: receiving.locationId,
        draftType: type
      }
    });
    return publicDraft(result.rows[0]);
  });
}

export async function deleteReturnDraft({ draftId, operatorId, admin = false } = {}) {
  return withTransaction(async () => {
    const result = await query(
      `DELETE FROM return_drafts
        WHERE id = $1::uuid
          AND ($2::boolean = true OR operator_id = $3)
        RETURNING id, operator_id, receiving_location_id, draft_type`,
      [draftId, Boolean(admin), operatorId]
    ).catch((error) => {
      if (error.code === "22P02") return { rowCount: 0, rows: [] };
      throw error;
    });
    if (result.rowCount) {
      await writeAudit({
        actorOperatorId: operatorId,
        source: "returns",
        action: "returns.draft.delete",
        details: {
          draftId: result.rows[0].id,
          ownerOperatorId: result.rows[0].operator_id,
          receivingLocationId: Number(result.rows[0].receiving_location_id),
          draftType: result.rows[0].draft_type
        }
      });
    }
    return { deleted: result.rowCount > 0, id: result.rows[0]?.id || null };
  });
}

async function nextReference(sequence, prefix) {
  const result = await query(`SELECT nextval('${sequence}') AS value`);
  return `${prefix}-${String(result.rows[0].value).padStart(6, "0")}`;
}

async function existingBatchByIdempotency(idempotencyKey) {
  const result = await query(
    `SELECT b.id
       FROM return_batches b
      WHERE b.idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey]
  );
  if (!result.rows[0]?.id) return null;
  return listReturnRecords({ batchId: result.rows[0].id, limit: 10 });
}

function matchedInputLine(input, contextLines) {
  const sourceLineId = positiveId(
    input.sourceLineId ?? input.lineId ?? input.salesOrderLineId,
    "Sales Order line"
  );
  const line = contextLines.find((candidate) => Number(candidate.sourceLineId) === sourceLineId);
  if (!line) throw httpError(400, `Sales Order line ${sourceLineId} is not eligible for this return.`);
  return line;
}

function reasonForInput(input, stockReturnType, reasons) {
  const requestedId = stockReturnType === "normal"
    ? NORMAL_REASON_ID
    : positiveId(input.reasonId ?? input.reason?.id, "quality reason");
  if (stockReturnType === "quality" && !QUALITY_REASON_IDS.has(requestedId)) {
    throw httpError(400, "Quality returns require a NetSuite R1-R5 reason.");
  }
  const reason = reasons.find((option) => Number(option.id) === requestedId);
  if (!reason) throw httpError(409, "The selected NetSuite return reason is no longer active.");
  return reason;
}

function validateStockLines(inputLines, lookup, stockReturnType, reasons, { operatorId } = {}) {
  if (!Array.isArray(inputLines) || !inputLines.length) throw httpError(400, "Add at least one stock return line.");
  const validated = inputLines.map((input, index) => {
    const line = matchedInputLine(input, lookup.lines);
    positiveId(line.netSuiteOrderLine, "NetSuite Sales Order line number");
    if (line.returnPolicy.effective === "NOT_RETURNABLE") {
      throw httpError(409, `${line.itemName} is not returnable.`);
    }
    const canonical = canonicalReturnQuantity(input, line);
    const reason = reasonForInput(input, stockReturnType, reasons);
    const photos = normalizePhotos(input.photos, `Return line ${index + 1}`, { operatorId });
    if (stockReturnType === "quality" && !photos.length) {
      throw httpError(400, `Quality return line ${index + 1} requires at least one live-camera photo.`);
    }
    return {
      input,
      line,
      canonical,
      reason,
      photos,
      note: cleanText(input.note, "Return note", 500),
      approvalStatus: line.returnPolicy.effective === "APPROVAL_REQUIRED" ? "pending" : "not_required"
    };
  });
  const totals = new Map();
  for (const item of validated) {
    const key = String(item.line.sourceLineId);
    totals.set(key, (totals.get(key) || 0) + item.canonical.salesQuantity);
  }
  for (const item of validated) {
    const total = totals.get(String(item.line.sourceLineId));
    if (total - Number(item.line.remainingReturnable || 0) > QUANTITY_EPSILON) {
      throw httpError(
        409,
        `${item.line.itemName} exceeds the remaining returnable quantity of ${item.line.remainingReturnable} ${item.line.salesUom}.`,
        { code: "RETURN_QUANTITY_EXCEEDED", sourceLineId: item.line.sourceLineId }
      );
    }
  }
  return validated;
}

async function insertPhotos({ recordId, lineId = null, kind, photos }) {
  for (let index = 0; index < photos.length; index += 1) {
    await query(
      `INSERT INTO return_photos (
         return_record_id, return_line_id, photo_kind, photo_reference, position
       ) VALUES ($1, $2, $3, $4, $5)`,
      [recordId, lineId, kind, photos[index], index + 1]
    );
  }
}

async function insertStockReturn({
  batch,
  operatorId,
  lookup,
  stockReturnType,
  validatedLines,
  photos,
  submittedAt,
  automation,
  note = ""
}) {
  const reference = await nextReference("stock_return_reference_seq", "SR");
  const businessStatus = deriveStockReturnStatus(validatedLines.map((line) => ({
    approvalStatus: line.approvalStatus
  })));
  const potentialEstimate = validatedLines
    .reduce((total, line) => total + (line.canonical.salesQuantity * Number(line.line.rate || 0)), 0);
  const syncStatus = !automation
    ? "disabled"
    : validatedLines.some((line) => line.approvalStatus === "pending")
      ? "waiting_approval"
      : "pending";
  const externalId = `MBBS-${reference}`;
  const result = await query(
    `INSERT INTO return_records (
       record_reference, batch_id, record_type, stock_return_type, status,
       operator_id, source_sales_order_id, source_sales_order_ref,
       source_order_snapshot, customer_id, customer_code, customer_name,
       customer_phone, customer_address, customer_snapshot,
       ordering_location_id, ordering_location_name,
       receiving_location_id, receiving_location_name, cross_yard,
       vehicle_plate, note, balance_snapshot, estimated_credit, external_id,
       netsuite_sync_status, submitted_at
     ) VALUES (
       $1, $2, 'stock', $3, $4, $5, $6, $7,
       $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb,
       $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24, $25, $26
     )
     RETURNING *`,
    [
      reference,
      batch.id,
      stockReturnType,
      businessStatus,
      operatorId,
      lookup.order.id,
      lookup.order.tranid,
      JSON.stringify(lookup.order),
      lookup.customer.id,
      lookup.customer.code,
      lookup.customer.name,
      lookup.customer.phone,
      lookup.customer.address,
      JSON.stringify(lookup.customer),
      lookup.order.orderingLocationId,
      lookup.order.orderingLocationName,
      batch.receivingLocationId,
      batch.receivingYardCode,
      lookup.crossYard,
      batch.vehiclePlate,
      note || null,
      JSON.stringify({
        lookedUpAt: lookup.lookedUpAt,
        lines: validatedLines.map((item) => ({
          sourceLineId: item.line.sourceLineId,
          fulfilled: item.line.fulfilled,
          netsuiteReturned: item.line.netsuiteReturned,
          localReserved: item.line.localReserved,
          available: item.line.available
        }))
      }),
      Math.round(potentialEstimate * 100) / 100,
      externalId,
      syncStatus,
      submittedAt
    ]
  );
  const record = result.rows[0];
  for (const item of validatedLines) {
    const estimate = item.canonical.salesQuantity * Number(item.line.rate || 0);
    const lineResult = await query(
      `INSERT INTO return_record_lines (
         return_record_id, source_sales_order_line_id, netsuite_order_line_id,
         source_local_line_id,
         item_id, item_name, item_description, item_type, sales_uom,
         sales_order_quantity, fulfilled_quantity, netsuite_returned_quantity,
         local_reserved_quantity, returned_sales_quantity,
         returned_pallets, returned_layers, returned_sections, returned_pieces,
         to_plt, to_lyr, to_sec, to_pcs, entry_mode,
         return_policy_default, return_policy_override, return_policy_effective,
         approval_status, reason_id, reason_code, reason_label, note, rate,
         estimated_credit, source_line_snapshot, netsuite_line_snapshot
       ) VALUES (
         $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22,
         $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34::jsonb, $35::jsonb
       )
       RETURNING id`,
      [
        record.id,
        item.line.sourceLineId,
        item.line.netSuiteOrderLine,
        item.line.itemId,
        item.line.itemName,
        item.line.description,
        item.line.itemType,
        item.line.salesUom || "Each",
        item.line.salesQuantity,
        item.line.fulfilled,
        item.line.netsuiteReturned,
        item.line.localReserved,
        item.canonical.salesQuantity,
        item.canonical.pallets,
        item.canonical.layers,
        item.canonical.sections,
        item.canonical.pieces,
        item.line.toPlt,
        item.line.toLyr,
        item.line.toSec,
        item.line.toPcs,
        item.canonical.entryMode,
        item.line.returnPolicy.default,
        item.line.returnPolicy.override,
        item.line.returnPolicy.effective,
        item.approvalStatus,
        item.reason.id,
        item.reason.code,
        item.reason.label,
        item.note,
        item.line.rate,
        Math.round(estimate * 100) / 100,
        JSON.stringify(item.line),
        JSON.stringify({
          lookedUpAt: lookup.lookedUpAt,
          returnTransactions: item.line.netsuiteReturnTransactions
        })
      ]
    );
    if (item.photos.length) {
      await insertPhotos({
        recordId: record.id,
        lineId: lineResult.rows[0].id,
        kind: "quality_line",
        photos: item.photos
      });
    }
  }
  if (photos.length) await insertPhotos({ recordId: record.id, kind: "stock", photos });
  return record;
}

async function insertPalletReturn({
  batch,
  operatorId,
  customer,
  order = null,
  palletBalance,
  palletQuantity,
  photos,
  submittedAt,
  automation,
  note = ""
}) {
  const reference = await nextReference("pallet_return_reference_seq", "PR");
  const externalId = `MBBS-${reference}`;
  const financialSnapshot = {
    ...palletBalance,
    rate: 40,
    salesUom: "Each",
    reason: { id: 10, code: "GD", label: "GD - Good Condition" }
  };
  const result = await query(
    `INSERT INTO return_records (
       record_reference, batch_id, record_type, status, operator_id,
       source_sales_order_id, source_sales_order_ref, source_order_snapshot,
       customer_id, customer_code, customer_name, customer_phone,
       customer_address, customer_snapshot, ordering_location_id,
       ordering_location_name, receiving_location_id, receiving_location_name,
       cross_yard, vehicle_plate, note, pallet_quantity, balance_snapshot,
       estimated_credit, external_id, netsuite_sync_status, submitted_at
     ) VALUES (
       $1, $2, 'pallet', 'accepted', $3, $4, $5, $6::jsonb,
       $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
       $17, $18, $19, $20, $21::jsonb, $22, $23, $24, $25
     )
     RETURNING *`,
    [
      reference,
      batch.id,
      operatorId,
      order?.id || null,
      order?.tranid || null,
      JSON.stringify(order || {}),
      customer.id,
      customer.code,
      customer.name,
      customer.phone,
      customer.address,
      JSON.stringify(customer),
      order?.orderingLocationId || null,
      order?.orderingLocationName || null,
      batch.receivingLocationId,
      batch.receivingYardCode,
      Boolean(order && Number(order.orderingLocationId) !== batch.receivingLocationId),
      batch.vehiclePlate,
      note || null,
      palletQuantity,
      JSON.stringify(financialSnapshot),
      palletQuantity * 40,
      externalId,
      automation ? "pending" : "disabled",
      submittedAt
    ]
  );
  await insertPhotos({ recordId: result.rows[0].id, kind: "pallet", photos });
  return result.rows[0];
}

export async function submitReturnBatch({
  operatorId,
  input = {},
  autoSync = true
} = {}) {
  const explicitRequestKey = cleanText(
    input.idempotencyKey || input.clientRequestId || "",
    "Idempotency key",
    180
  );
  if (explicitRequestKey) {
    const earlyReplay = await existingBatchByIdempotency(
      normalizedIdempotencyKey({ idempotencyKey: explicitRequestKey }, operatorId)
    );
    if (earlyReplay) {
      const records = earlyReplay.records || [];
      return {
        idempotentReplay: true,
        batchReference: records[0]?.batchReference || "",
        stockReturn: records.find((record) => record.recordType === "stock") || null,
        palletReturn: records.find((record) => record.recordType === "pallet") || null,
        records
      };
    }
  }
  const draftId = cleanText(input.draftId || "", "Draft ID", 80);
  let draftState = null;
  if (draftId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draftId)) {
      throw httpError(400, "Draft ID is invalid.");
    }
    const draftResult = await query(
      `SELECT *
         FROM return_drafts
        WHERE id = $1::uuid
          AND operator_id = $2
          AND expires_at > now()`,
      [draftId, operatorId]
    );
    if (!draftResult.rowCount) throw httpError(404, "This active return draft does not belong to the signed-in operator.");
    draftState = draftResult.rows[0];
    const draftKey = cleanText(draftState.payload?.idempotencyKey, "Draft idempotency key", 180, { required: true });
    const requestKey = explicitRequestKey;
    if (requestKey && requestKey !== draftKey) {
      throw httpError(409, "This draft has a different submission key. Reload the draft and try again.");
    }
    if (input.receivingLocationId
        && Number(input.receivingLocationId) !== Number(draftState.receiving_location_id)) {
      throw httpError(409, "The receiving yard is locked to the saved draft.");
    }
    input = {
      ...input,
      draftId,
      idempotencyKey: draftKey,
      receivingLocationId: Number(draftState.receiving_location_id)
    };
  }
  const receiving = yard(input.receivingLocationId);
  const idempotencyKey = normalizedIdempotencyKey(input, operatorId);
  const prior = await existingBatchByIdempotency(idempotencyKey);
  if (prior) {
    const records = prior.records || [];
    return {
      idempotentReplay: true,
      batchReference: records[0]?.batchReference || "",
      stockReturn: records.find((record) => record.recordType === "stock") || null,
      palletReturn: records.find((record) => record.recordType === "pallet") || null,
      records
    };
  }
  const vehiclePlate = cleanVehiclePlate(input.vehiclePlate);
  const hasStock = Array.isArray(input.lines) && input.lines.length > 0;
  const palletQuantity = quantity(input.palletQuantity || 0, "PALLET quantity", { whole: true });
  const hasPallet = palletQuantity > 0;
  if (!hasStock && !hasPallet) throw httpError(400, "Add stock or PALLET quantities before confirming the return.");

  let lookup = null;
  let customer = null;
  let palletBalance = null;
  let stockReturnType = null;
  let validatedLines = [];
  if (hasStock || input.orderId || input.orderCode || input.salesOrderNumber || input.code) {
    lookup = await lookupReturnSalesOrder({
      code: input.orderCode || input.salesOrderNumber || input.code || input.orderId,
      receivingLocationId: receiving.locationId,
      includeStockReturns: hasStock,
      includeNetSuiteOrderLines: hasStock,
      includePalletBalance: hasPallet,
      enforceYardRestriction: hasStock,
      forcePalletBalance: hasPallet
    });
    if (!lookup.crossYardAllowed) {
      throw httpError(409, `This return must be processed at ${lookup.defaultReturnLocation.yardCode || lookup.defaultReturnLocation.name}.`, {
        code: "CROSS_YARD_RETURN_BLOCKED",
        requiredReturnLocation: lookup.defaultReturnLocation
      });
    }
    customer = lookup.customer;
    palletBalance = lookup.palletBalance;
    if (hasStock) {
      const reasonsResult = await getReturnReasons();
      const reasons = [reasonsResult.normalReason, ...reasonsResult.qualityReasons].filter(Boolean);
      stockReturnType = normalizedStockReturnType(input.stockReturnType || input.type);
      validatedLines = validateStockLines(input.lines, lookup, stockReturnType, reasons, { operatorId });
    }
  } else {
    customer = await fetchReturnCustomerFromNetSuite(input.customerId, { force: true });
    if (!customer) throw httpError(404, "Active NetSuite customer was not found.");
    palletBalance = await customerPalletBalance(customer, null, { force: true });
  }

  if (input.customerId && Number(input.customerId) !== Number(customer.id)) {
    throw httpError(409, "The selected customer does not match the Sales Order customer.");
  }
  if (hasPallet && palletQuantity - Number(palletBalance.available || 0) > QUANTITY_EPSILON) {
    throw httpError(409, `Maximum returnable PALLET quantity is ${palletBalance.available}.`, {
      code: "PALLET_QUOTA_EXCEEDED",
      available: palletBalance.available
    });
  }
  const stockPhotos = normalizePhotos(input.photos || input.stockPhotos, "Stock return", { operatorId });
  const palletPhotos = normalizePhotos(input.palletPhotos, "PALLET return", { operatorId });
  const returnNote = cleanText(input.note, "Return note", 1000);
  if (hasStock && stockReturnType === "normal" && !stockPhotos.length) {
    throw httpError(400, "Normal Stock Return requires at least one live-camera photo.");
  }
  if (hasPallet && !palletPhotos.length) {
    throw httpError(400, "PALLET Return requires at least one live-camera photo.");
  }
  await verifyReturnPhotos([
    ...stockPhotos,
    ...palletPhotos,
    ...validatedLines.flatMap((line) => line.photos)
  ], operatorId);

  const submittedAt = new Date();
  const transactionResult = await withTransaction(async () => {
    if (draftState) {
      const lockedDraft = await query(
        `SELECT *
           FROM return_drafts
          WHERE id = $1::uuid
            AND operator_id = $2
            AND expires_at > now()
          FOR UPDATE`,
        [draftId, operatorId]
      );
      if (!lockedDraft.rowCount) throw httpError(409, "The return draft changed or expired before submission.");
      const lockedKey = cleanText(
        lockedDraft.rows[0].payload?.idempotencyKey,
        "Draft idempotency key",
        180,
        { required: true }
      );
      if (Number(lockedDraft.rows[0].receiving_location_id) !== receiving.locationId
          || normalizedIdempotencyKey({ idempotencyKey: lockedKey }, operatorId) !== idempotencyKey) {
        throw httpError(409, "The return draft changed before submission. Reload it and try again.");
      }
    }
    const lockKeys = [
      ...(lookup ? [`stock-return:${lookup.order.id}`] : []),
      ...(hasPallet ? [`pallet-return:${customer.id}`] : [])
    ].sort();
    for (const lockKey of lockKeys) {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    }
    if (lookup && hasStock) {
      const latestReserved = await localStockReserved(
        validatedLines.map((line) => line.line.sourceLineId),
        lookup.observedStockExternalIds || [],
        lookup.observedStockTransactionIds || []
      );
      for (const validated of validatedLines) {
        const current = latestReserved.get(String(validated.line.sourceLineId)) || 0;
        const allowed = Math.max(validated.line.fulfilled - validated.line.netsuiteReturned - current, 0);
        const total = validatedLines
          .filter((candidate) => candidate.line.sourceLineId === validated.line.sourceLineId)
          .reduce((sum, candidate) => sum + candidate.canonical.salesQuantity, 0);
        if (total - allowed > QUANTITY_EPSILON) {
          throw httpError(409, `${validated.line.itemName} was reserved by another return. Refresh and try again.`, {
            code: "RETURN_QUANTITY_CHANGED"
          });
        }
        validated.line.localReserved = current;
        validated.line.available = allowed;
        validated.line.remainingReturnable = allowed;
      }
    }
    if (hasPallet) {
      const currentLocal = await localPalletReserved(
        customer.id,
        palletBalance.externalIds || [],
        palletBalance.transactionIds || []
      );
      const currentAvailable = Math.max(palletBalance.fulfilled - palletBalance.netsuiteReturned - currentLocal, 0);
      if (palletQuantity - currentAvailable > QUANTITY_EPSILON) {
        throw httpError(409, `Maximum returnable PALLET quantity is now ${currentAvailable}.`, {
          code: "PALLET_QUOTA_CHANGED",
          available: currentAvailable
        });
      }
      palletBalance = { ...palletBalance, localReserved: currentLocal, available: currentAvailable };
    }
    const existing = await query(
      "SELECT id FROM return_batches WHERE idempotency_key = $1 FOR UPDATE",
      [idempotencyKey]
    );
    if (existing.rowCount) return { replayBatchId: existing.rows[0].id };

    const batchReference = await nextReference("return_batch_reference_seq", "RB");
    const settings = await getReturnYardSettings(receiving.locationId);
    const batchResult = await query(
      `INSERT INTO return_batches (
         batch_reference, idempotency_key, operator_id, receiving_location_id,
         receiving_yard_code, vehicle_plate, note, lookup_method, submitted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        batchReference,
        idempotencyKey,
        operatorId,
        receiving.locationId,
        receiving.yardCode,
        vehiclePlate,
        returnNote || null,
        lookup ? "sales_order" : "customer",
        submittedAt
      ]
    );
    const batch = {
      id: batchResult.rows[0].id,
      batchReference,
      receivingLocationId: receiving.locationId,
      receivingYardCode: receiving.yardCode,
      vehiclePlate
    };
    const stockRecord = hasStock ? await insertStockReturn({
      batch,
      operatorId,
      lookup,
      stockReturnType,
      validatedLines,
      photos: stockPhotos,
      submittedAt,
      automation: settings.autoCreateStockRa,
      note: returnNote
    }) : null;
    const palletRecord = hasPallet ? await insertPalletReturn({
      batch,
      operatorId,
      customer,
      order: lookup?.order || null,
      palletBalance,
      palletQuantity,
      photos: palletPhotos,
      submittedAt,
      automation: settings.autoCreatePalletCreditMemo,
      note: returnNote
    }) : null;
    if (draftState) {
      await query(
        "DELETE FROM return_drafts WHERE id = $1::uuid AND operator_id = $2",
        [draftId, operatorId]
      );
    }
    await writeAudit({
      actorOperatorId: operatorId,
      source: "returns",
      action: "returns.batch.submit",
      orderId: lookup?.order?.id || null,
      details: {
        batchReference,
        stockReturnReference: stockRecord?.record_reference || null,
        palletReturnReference: palletRecord?.record_reference || null,
        receivingLocationId: receiving.locationId,
        vehiclePlate,
        draftId: draftState?.id || null,
        idempotencyKey
      }
    });
    return { batch, stockRecord, palletRecord };
  });

  if (transactionResult.replayBatchId) {
    const replay = await listReturnRecords({ batchId: transactionResult.replayBatchId, limit: 10 });
    return {
      idempotentReplay: true,
      batchReference: replay.records[0]?.batchReference || "",
      stockReturn: replay.records.find((record) => record.recordType === "stock") || null,
      palletReturn: replay.records.find((record) => record.recordType === "pallet") || null,
      records: replay.records
    };
  }

  const result = {
    batchReference: transactionResult.batch.batchReference,
    stockReturn: transactionResult.stockRecord
      ? await getReturnRecordDetail(transactionResult.stockRecord.id)
      : null,
    palletReturn: transactionResult.palletRecord
      ? await getReturnRecordDetail(transactionResult.palletRecord.id)
      : null
  };
  result.records = [result.stockReturn, result.palletReturn].filter(Boolean);

  if (autoSync) {
    for (const record of result.records) {
      if (record.netSuiteSyncStatus !== "pending") continue;
      try {
        const synced = await syncReturnRecord({ recordId: record.id, actorOperatorId: operatorId });
        if (record.recordType === "stock") result.stockReturn = synced;
        else result.palletReturn = synced;
      } catch {
        const failed = await getReturnRecordDetail(record.id);
        if (record.recordType === "stock") result.stockReturn = failed;
        else result.palletReturn = failed;
      }
    }
    result.records = [result.stockReturn, result.palletReturn].filter(Boolean);
  }
  return result;
}

function publicReturnRecord(row = {}) {
  return {
    id: Number(row.id),
    reference: row.record_reference,
    recordReference: row.record_reference,
    batchId: Number(row.batch_id),
    batchReference: row.batch_reference || "",
    recordType: row.record_type,
    stockReturnType: row.stock_return_type || null,
    status: row.status,
    operatorId: row.operator_id,
    operatorName: row.operator_name || "",
    sourceSalesOrderId: row.source_sales_order_id === null ? null : Number(row.source_sales_order_id),
    sourceSalesOrderRef: row.source_sales_order_ref || "",
    customerId: Number(row.customer_id),
    customerCode: row.customer_code || "",
    customerName: row.customer_name || "",
    customerPhone: row.customer_phone || "",
    customerAddress: row.customer_address || "",
    orderingLocationId: row.ordering_location_id === null ? null : Number(row.ordering_location_id),
    orderingLocationName: row.ordering_location_name || "",
    receivingLocationId: Number(row.receiving_location_id),
    receivingLocationName: row.receiving_location_name || "",
    crossYard: Boolean(row.cross_yard),
    vehiclePlate: row.vehicle_plate || "",
    note: row.note || "",
    palletQuantity: row.pallet_quantity === null ? null : Number(row.pallet_quantity),
    balanceSnapshot: row.balance_snapshot || {},
    estimatedCredit: row.estimated_credit === null ? null : Number(row.estimated_credit),
    actualCredit: row.actual_credit === null ? null : Number(row.actual_credit),
    currency: row.currency || "",
    externalId: row.external_id,
    netSuiteStage: row.netsuite_stage,
    netSuiteTransactionId: row.netsuite_transaction_id === null ? null : Number(row.netsuite_transaction_id),
    netSuiteTransactionRef: row.netsuite_transaction_ref || "",
    netSuiteTransactionStatus: row.netsuite_transaction_status || "",
    netSuiteSyncStatus: row.netsuite_sync_status,
    netSuiteSyncAttempts: Number(row.netsuite_sync_attempts || 0),
    netSuiteSyncError: row.netsuite_sync_error || "",
    netSuiteLastSyncedAt: row.netsuite_last_synced_at || null,
    submittedAt: row.submitted_at,
    voidedAt: row.voided_at || null,
    voidReason: row.void_reason || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listFilterClauses(filters, params) {
  const clauses = ["1 = 1"];
  if (filters.recordType) {
    params.push(String(filters.recordType));
    clauses.push(`r.record_type = $${params.length}`);
  }
  if (filters.stockReturnType) {
    params.push(String(filters.stockReturnType));
    clauses.push(`r.stock_return_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(String(filters.status));
    clauses.push(`r.status = $${params.length}`);
  }
  if (filters.netSuiteSyncStatus) {
    const statuses = Array.isArray(filters.netSuiteSyncStatus)
      ? filters.netSuiteSyncStatus
      : [filters.netSuiteSyncStatus];
    params.push(statuses.map(String));
    clauses.push(`r.netsuite_sync_status = ANY($${params.length}::text[])`);
  }
  if (filters.receivingLocationId) {
    params.push(positiveId(filters.receivingLocationId, "receiving yard"));
    clauses.push(`r.receiving_location_id = $${params.length}`);
  }
  if (filters.orderingLocationIds?.length) {
    params.push(filters.orderingLocationIds.map(Number));
    // A customer-direct PALLET return has no authoritative SO ordering yard;
    // by business rule it belongs to its actual receiving yard for Sales scope.
    clauses.push(`COALESCE(r.ordering_location_id, r.receiving_location_id) = ANY($${params.length}::bigint[])`);
  }
  if (filters.receivingLocationIds?.length) {
    params.push(filters.receivingLocationIds.map(Number));
    clauses.push(`r.receiving_location_id = ANY($${params.length}::bigint[])`);
  }
  if (filters.operatorId) {
    params.push(filters.operatorId);
    clauses.push(`r.operator_id = $${params.length}`);
  }
  if (filters.batchId) {
    params.push(positiveId(filters.batchId, "return batch ID"));
    clauses.push(`r.batch_id = $${params.length}`);
  }
  if (filters.from) {
    params.push(String(filters.from).slice(0, 10));
    clauses.push(`r.submitted_at >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(String(filters.to).slice(0, 10));
    clauses.push(`r.submitted_at < ($${params.length}::date + interval '1 day')`);
  }
  const search = cleanText(filters.search, "Search", 120);
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(
      r.record_reference ILIKE $${params.length}
      OR b.batch_reference ILIKE $${params.length}
      OR r.source_sales_order_ref ILIKE $${params.length}
      OR r.customer_code ILIKE $${params.length}
      OR r.customer_name ILIKE $${params.length}
      OR r.vehicle_plate ILIKE $${params.length}
      OR r.netsuite_transaction_ref ILIKE $${params.length}
    )`);
  }
  return clauses;
}

export async function listReturnRecords(filters = {}) {
  const params = [];
  const clauses = listFilterClauses(filters, params);
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
  const offset = Math.max(0, Number(filters.offset) || 0);
  const count = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE r.status = 'pending_approval')::int AS pending_approval,
            COUNT(*) FILTER (WHERE r.status = 'partially_pending')::int AS partially_pending,
            COUNT(*) FILTER (WHERE r.status = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE r.netsuite_sync_status = 'failed')::int AS sync_failed
       FROM return_records r
       INNER JOIN return_batches b ON b.id = r.batch_id
      WHERE ${clauses.join(" AND ")}`,
    params
  );
  const rowsParams = [...params, limit, offset];
  const result = await query(
    `SELECT r.*, b.batch_reference, op.display_name AS operator_name
       FROM return_records r
       INNER JOIN return_batches b ON b.id = r.batch_id
       LEFT JOIN operators op ON op.id = r.operator_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY r.submitted_at DESC, r.id DESC
      LIMIT $${rowsParams.length - 1} OFFSET $${rowsParams.length}`,
    rowsParams
  );
  const totals = count.rows[0] || {};
  return {
    records: result.rows.map(publicReturnRecord),
    counts: {
      total: Number(totals.total || 0),
      pendingApproval: Number(totals.pending_approval || 0),
      partiallyPending: Number(totals.partially_pending || 0),
      accepted: Number(totals.accepted || 0),
      syncFailed: Number(totals.sync_failed || 0)
    },
    limit,
    offset
  };
}

function publicReturnLine(row = {}) {
  return {
    id: Number(row.id),
    sourceSalesOrderLineId: Number(row.source_sales_order_line_id),
    netSuiteOrderLine: Number(row.netsuite_order_line_id),
    itemId: Number(row.item_id),
    itemName: row.item_name,
    description: row.item_description || "",
    itemType: row.item_type || "",
    salesUom: row.sales_uom,
    salesOrderQuantity: Number(row.sales_order_quantity || 0),
    fulfilledQuantity: Number(row.fulfilled_quantity || 0),
    netSuiteReturnedQuantity: Number(row.netsuite_returned_quantity || 0),
    localReservedQuantity: Number(row.local_reserved_quantity || 0),
    returnedSalesQuantity: Number(row.returned_sales_quantity || 0),
    pallets: Number(row.returned_pallets || 0),
    layers: Number(row.returned_layers || 0),
    sections: Number(row.returned_sections || 0),
    pieces: Number(row.returned_pieces || 0),
    toPlt: row.to_plt === null ? null : Number(row.to_plt),
    toLyr: row.to_lyr === null ? null : Number(row.to_lyr),
    toSec: row.to_sec === null ? null : Number(row.to_sec),
    toPcs: row.to_pcs === null ? null : Number(row.to_pcs),
    entryMode: row.entry_mode,
    returnPolicyDefault: row.return_policy_default,
    returnPolicyOverride: row.return_policy_override,
    returnPolicyEffective: row.return_policy_effective,
    approvalStatus: row.approval_status,
    approvalNote: row.approval_note || "",
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    reasonId: Number(row.reason_id),
    reasonCode: row.reason_code,
    reasonLabel: row.reason_label,
    note: row.note || "",
    rate: row.rate === null ? null : Number(row.rate),
    estimatedCredit: row.estimated_credit === null ? null : Number(row.estimated_credit),
    sourceLineSnapshot: row.source_line_snapshot || {}
  };
}

export async function getReturnRecordDetail(recordId, {
  orderingLocationIds = null,
  receivingLocationIds = null,
  operatorId = null
} = {}) {
  const params = [positiveId(recordId, "return record ID")];
  const clauses = ["r.id = $1"];
  if (orderingLocationIds?.length) {
    params.push(orderingLocationIds.map(Number));
    clauses.push(`COALESCE(r.ordering_location_id, r.receiving_location_id) = ANY($${params.length}::bigint[])`);
  }
  if (receivingLocationIds?.length) {
    params.push(receivingLocationIds.map(Number));
    clauses.push(`r.receiving_location_id = ANY($${params.length}::bigint[])`);
  }
  if (operatorId) {
    params.push(String(operatorId));
    clauses.push(`r.operator_id = $${params.length}`);
  }
  const recordResult = await query(
    `SELECT r.*, b.batch_reference, op.display_name AS operator_name
       FROM return_records r
       INNER JOIN return_batches b ON b.id = r.batch_id
       LEFT JOIN operators op ON op.id = r.operator_id
      WHERE ${clauses.join(" AND ")}`,
    params
  );
  if (!recordResult.rowCount) return null;
  const [linesResult, photosResult, syncResult] = await Promise.all([
    query("SELECT * FROM return_record_lines WHERE return_record_id = $1 ORDER BY id", [recordId]),
    query("SELECT * FROM return_photos WHERE return_record_id = $1 ORDER BY return_line_id NULLS FIRST, position", [recordId]),
    query("SELECT * FROM return_sync_events WHERE return_record_id = $1 ORDER BY created_at DESC, id DESC", [recordId])
  ]);
  const photosByLine = new Map();
  const headerPhotos = [];
  for (const photo of photosResult.rows) {
    const normalized = {
      id: Number(photo.id),
      kind: photo.photo_kind,
      reference: photo.photo_reference,
      position: Number(photo.position),
      metadata: photo.metadata || {}
    };
    if (photo.return_line_id === null) headerPhotos.push(normalized);
    else {
      const key = String(photo.return_line_id);
      photosByLine.set(key, [...(photosByLine.get(key) || []), normalized]);
    }
  }
  return {
    ...publicReturnRecord(recordResult.rows[0]),
    sourceOrderSnapshot: recordResult.rows[0].source_order_snapshot || {},
    customerSnapshot: recordResult.rows[0].customer_snapshot || {},
    netSuiteSnapshot: recordResult.rows[0].netsuite_snapshot || {},
    lines: linesResult.rows.map((row) => ({
      ...publicReturnLine(row),
      photos: photosByLine.get(String(row.id)) || []
    })),
    photos: headerPhotos,
    syncEvents: syncResult.rows.map((row) => ({
      id: Number(row.id),
      eventType: row.event_type,
      status: row.status,
      error: row.error || "",
      actorOperatorId: row.actor_operator_id || null,
      createdAt: row.created_at
    }))
  };
}

async function recordForSync(recordId) {
  const detail = await getReturnRecordDetail(recordId);
  if (!detail) throw httpError(404, "Return record was not found.");
  const approvalLines = detail.lines;
  const memo = [
    detail.recordReference,
    detail.batchReference,
    detail.sourceSalesOrderRef ? `SO ${detail.sourceSalesOrderRef}` : "",
    `yard ${detail.receivingLocationName || detail.receivingLocationId}`,
    `plate ${detail.vehiclePlate}`,
    detail.note ? `note ${detail.note}` : ""
  ].filter(Boolean).join(" | ");
  return {
    ...detail,
    externalId: detail.externalId,
    submittedDate: dateOnly(detail.submittedAt),
    memo,
    sourceSalesOrderId: detail.sourceSalesOrderId,
    customerId: detail.customerId,
    receivingLocationId: detail.receivingLocationId,
    netsuiteTransactionId: detail.netSuiteTransactionId,
    netsuiteStage: detail.netSuiteStage,
    palletQuantity: detail.palletQuantity,
    hasPendingApproval: approvalLines.some((line) => line.approvalStatus === "pending"),
    acceptedLineCount: approvalLines.filter((line) => ["not_required", "approved"].includes(line.approvalStatus)).length,
    lines: approvalLines
      .filter((line) => ["not_required", "approved"].includes(line.approvalStatus))
      .map((line) => ({
        sourceSalesOrderLineId: line.sourceSalesOrderLineId,
        netSuiteOrderLine: line.netSuiteOrderLine,
        itemId: line.itemId,
        returnedSalesQuantity: line.returnedSalesQuantity,
        rate: line.rate,
        reasonId: line.reasonId
      }))
  };
}

async function writeSyncEvent({
  recordId,
  eventType,
  status,
  request = {},
  response = {},
  error = "",
  actorOperatorId = null
}) {
  await query(
    `INSERT INTO return_sync_events (
       return_record_id, event_type, status, request_snapshot,
       response_snapshot, error, actor_operator_id
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
    [recordId, eventType, status, JSON.stringify(request), JSON.stringify(response), error || null, actorOperatorId]
  );
}

export async function syncReturnRecord({ recordId, actorOperatorId = null, force = false } = {}) {
  const id = positiveId(recordId, "return record ID");
  const outcome = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-sync:${id}`]);
    const detail = await recordForSync(id);
    const eventType = detail.recordType === "stock"
      ? "return_authorization_upsert"
      : "pallet_credit_memo_upsert";
    const block = async (syncStatus, message) => {
      const error = httpError(409, message);
      await query(
        `UPDATE return_records
            SET netsuite_sync_status = CASE
                  WHEN netsuite_stage = 'local' THEN $2
                  ELSE netsuite_sync_status
                END,
                netsuite_sync_error = $3,
                netsuite_last_synced_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [detail.id, syncStatus, message]
      );
      await writeSyncEvent({
        recordId: detail.id,
        eventType,
        status: "blocked",
        request: { externalId: detail.externalId },
        error: message,
        actorOperatorId
      });
      return { error };
    };

    if (detail.netSuiteSyncStatus === "succeeded" || detail.netSuiteSyncStatus === "manual_linked") {
      return { recordId: detail.id };
    }
    if (detail.status === "voided" || detail.status === "rejected") {
      return block("cancelled", "This return has no accepted quantity to synchronize.");
    }
    if (detail.recordType === "stock" && detail.hasPendingApproval) {
      return block("waiting_approval", "Finish every approval decision before creating the Return Authorization.");
    }
    if (detail.recordType === "stock" && !detail.acceptedLineCount) {
      return block("cancelled", "This return has no accepted line for a Return Authorization.");
    }
    const settings = await getReturnYardSettings(detail.receivingLocationId);
    const enabled = detail.recordType === "stock"
      ? settings.autoCreateStockRa
      : settings.autoCreatePalletCreditMemo;
    if (!enabled && !force) {
      return block("disabled", "NetSuite automation is disabled for this receiving yard.");
    }

    await query(
      `UPDATE return_records
          SET netsuite_sync_status = 'pending',
              netsuite_sync_attempts = netsuite_sync_attempts + 1,
              netsuite_sync_error = NULL,
              updated_at = now()
        WHERE id = $1`,
      [detail.id]
    );
    try {
      if (detail.recordType === "pallet") {
        const palletBalance = detail.balanceSnapshot || {};
        detail.palletItemId = positiveId(
          palletBalance.item?.id || palletBalance.item?.itemId,
          "PALLET item ID"
        );
      }
      const response = detail.recordType === "stock"
        ? await upsertReturnAuthorizationInNetSuite(detail)
        : await upsertPalletCreditMemoInNetSuite(detail);
      const transactionType = detail.recordType === "stock" ? "return_authorization" : "credit_memo";
      const recovered = response.recovered
        ? response
        : await findReturnTransactionByExternalId(detail.externalId, transactionType).catch(() => null);
      const transactionId = Number(response.id || recovered?.id || detail.netSuiteTransactionId);
      if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
        throw new Error(`NetSuite ${transactionType === "credit_memo" ? "Credit Memo" : "Return Authorization"} was created but its internal ID could not be confirmed.`);
      }
      const rawCreditValue = transactionType === "credit_memo"
        ? Number(recovered?.foreigntotal ?? response.foreignTotal ?? response.total)
        : NaN;
      const creditValue = Number.isFinite(rawCreditValue) ? Math.abs(rawCreditValue) : NaN;
      await query(
        `UPDATE return_records
            SET netsuite_stage = $2,
                netsuite_transaction_id = $3,
                netsuite_transaction_ref = $4,
                netsuite_transaction_status = $5,
                netsuite_sync_status = 'succeeded',
                netsuite_sync_error = NULL,
                netsuite_last_synced_at = now(),
                netsuite_snapshot = $6::jsonb,
                actual_credit = COALESCE($7, actual_credit),
                updated_at = now()
          WHERE id = $1`,
        [
          detail.id,
          transactionType,
          transactionId,
          recovered?.tranid || response.tranid || "",
          recovered?.status_text || recovered?.status || "",
          JSON.stringify(recovered || response),
          Number.isFinite(creditValue) ? creditValue : null
        ]
      );
      await writeSyncEvent({
        recordId: detail.id,
        eventType,
        status: "succeeded",
        request: {
          externalId: detail.externalId,
          sourceSalesOrderId: detail.sourceSalesOrderId,
          receivingLocationId: detail.receivingLocationId
        },
        response: recovered || response,
        actorOperatorId
      });
      await writeAudit({
        actorOperatorId,
        source: "returns",
        action: `returns.netsuite.${transactionType}.linked`,
        orderId: detail.sourceSalesOrderId,
        details: { returnRecordId: detail.id, recordReference: detail.recordReference, transactionId }
      });
      return { recordId: detail.id };
    } catch (error) {
      await query(
        `UPDATE return_records
            SET netsuite_sync_status = 'failed',
                netsuite_sync_error = $2,
                netsuite_last_synced_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [detail.id, String(error.message || error).slice(0, 4000)]
      );
      await writeSyncEvent({
        recordId: detail.id,
        eventType,
        status: "failed",
        request: { externalId: detail.externalId },
        error: error.message,
        actorOperatorId
      });
      return { error };
    }
  });
  if (outcome.error) throw outcome.error;
  return getReturnRecordDetail(outcome.recordId);
}

export async function decideReturnLine({
  recordId,
  lineId,
  decision,
  note = "",
  actorOperatorId,
  allowedReceivingLocationIds = null
} = {}) {
  const normalizedDecision = String(decision || "").toLowerCase();
  if (!["approved", "rejected"].includes(normalizedDecision)) throw httpError(400, "Select Approve or Reject.");
  const cleanNote = cleanText(note, "Decision note", 1000, { required: normalizedDecision === "rejected" });
  const result = await withTransaction(async () => {
    const params = [
      positiveId(recordId, "return record ID"),
      positiveId(lineId, "return line ID")
    ];
    const yardClause = allowedReceivingLocationIds?.length
      ? `AND r.receiving_location_id = ANY($3::bigint[])`
      : "";
    if (allowedReceivingLocationIds?.length) params.push(allowedReceivingLocationIds.map(Number));
    const locked = await query(
      `SELECT l.*, r.status AS record_status, r.receiving_location_id
         FROM return_record_lines l
         INNER JOIN return_records r ON r.id = l.return_record_id
        WHERE r.id = $1
          AND l.id = $2
          ${yardClause}
        FOR UPDATE OF l, r`,
      params
    );
    const line = locked.rows[0];
    if (!line) throw httpError(404, "Return line was not found.");
    if (line.record_status === "voided") throw httpError(409, "A voided return cannot be approved or rejected.");
    if (line.approval_status !== "pending") throw httpError(409, "This return line already has a final decision.");
    await query(
      `UPDATE return_record_lines
          SET approval_status = $2,
              approval_note = $3,
              decided_by = $4,
              decided_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [line.id, normalizedDecision, cleanNote || null, actorOperatorId]
    );
    const statuses = await query(
      "SELECT approval_status FROM return_record_lines WHERE return_record_id = $1 ORDER BY id",
      [recordId]
    );
    const status = deriveStockReturnStatus(statuses.rows);
    const settings = await getReturnYardSettings(line.receiving_location_id);
    const hasPending = statuses.rows.some((row) => row.approval_status === "pending");
    const hasAccepted = statuses.rows.some((row) => ["not_required", "approved"].includes(row.approval_status));
    const syncStatus = !settings.autoCreateStockRa
      ? "disabled"
      : hasPending
        ? "waiting_approval"
        : hasAccepted
          ? "pending"
          : "cancelled";
    await query(
      `UPDATE return_records
          SET status = $2,
              netsuite_sync_status = CASE
                WHEN netsuite_stage <> 'local' THEN netsuite_sync_status
                ELSE $3
              END,
              estimated_credit = (
                SELECT COALESCE(SUM(estimated_credit), 0)
                  FROM return_record_lines
                 WHERE return_record_id = $1
                   AND approval_status <> 'rejected'
              ),
              updated_at = now()
        WHERE id = $1`,
      [recordId, status, syncStatus]
    );
    await writeAudit({
      actorOperatorId,
      source: "returns",
      action: `returns.line.${normalizedDecision}`,
      orderId: null,
      lineId: line.id,
      details: { returnRecordId: Number(recordId), note: cleanNote }
    });
    return { shouldSync: syncStatus === "pending", receivingLocationId: Number(line.receiving_location_id) };
  });
  if (result.shouldSync) {
    try {
      return await syncReturnRecord({ recordId, actorOperatorId });
    } catch {
      return getReturnRecordDetail(recordId);
    }
  }
  return getReturnRecordDetail(recordId);
}

export async function voidReturnRecord({
  recordId,
  reason,
  actorOperatorId,
  allowedReceivingLocationIds = null
} = {}) {
  const cleanReason = cleanText(reason, "Void reason", 1000, { required: true });
  return withTransaction(async () => {
    const id = positiveId(recordId, "return record ID");
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-sync:${id}`]);
    const params = [id];
    const yardClause = allowedReceivingLocationIds?.length
      ? `AND receiving_location_id = ANY($2::bigint[])`
      : "";
    if (allowedReceivingLocationIds?.length) params.push(allowedReceivingLocationIds.map(Number));
    const locked = await query(
      `SELECT *
         FROM return_records
        WHERE id = $1
          ${yardClause}
        FOR UPDATE`,
      params
    );
    const record = locked.rows[0];
    if (!record) throw httpError(404, "Return record was not found.");
    if (record.status === "voided") return getReturnRecordDetail(record.id);
    if (record.netsuite_transaction_id && !/cancel|void/i.test(record.netsuite_transaction_status || "")) {
      throw httpError(
        409,
        `Cancel or void linked NetSuite transaction ${record.netsuite_transaction_ref || record.netsuite_transaction_id} before voiding this local return.`
      );
    }
    await query(
      `UPDATE return_records
          SET status = 'voided',
              voided_at = now(),
              voided_by = $2,
              void_reason = $3,
              estimated_credit = 0,
              netsuite_sync_status = CASE
                WHEN netsuite_sync_status IN ('disabled', 'waiting_approval', 'pending', 'failed')
                  THEN 'cancelled'
                ELSE netsuite_sync_status
              END,
              updated_at = now()
        WHERE id = $1`,
      [record.id, actorOperatorId, cleanReason]
    );
    await writeAudit({
      actorOperatorId,
      source: "returns",
      action: "returns.record.void",
      orderId: record.source_sales_order_id,
      details: { returnRecordId: record.id, recordReference: record.record_reference, reason: cleanReason }
    });
    return getReturnRecordDetail(record.id);
  });
}

function transactionItems(snapshot = {}) {
  const items = snapshot.item?.items || snapshot.items || [];
  return Array.isArray(items) ? items : [];
}

export async function linkReturnNetSuiteTransaction({
  recordId,
  transactionType,
  netsuiteId,
  netsuiteTranid = "",
  actorOperatorId
} = {}) {
  const type = String(transactionType || "").trim().toLowerCase().replaceAll("-", "_");
  const recordKey = positiveId(recordId, "return record ID");
  const id = positiveId(netsuiteId, "NetSuite transaction ID");
  const linkedRecordId = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-sync:${recordKey}`]);
    const detail = await getReturnRecordDetail(recordKey);
    if (!detail) throw httpError(404, "Return record was not found.");
    if (["voided", "rejected"].includes(detail.status)) {
      throw httpError(409, "A voided or rejected return cannot be linked.");
    }
    if (detail.recordType === "stock"
        && detail.lines.some((line) => line.approvalStatus === "pending")) {
      throw httpError(409, "Finish every approval decision before linking a Return Authorization.");
    }
    const expected = detail.recordType === "stock" ? "return_authorization" : "credit_memo";
    if (type !== expected) {
      throw httpError(400, `${detail.recordReference} must link to a ${expected.replaceAll("_", " ")}.`);
    }
    const reused = await query(
      `SELECT id, record_reference
         FROM return_records
        WHERE netsuite_transaction_id = $1
          AND id <> $2
        LIMIT 1`,
      [id, detail.id]
    );
    if (reused.rowCount) {
      throw httpError(409, `NetSuite transaction ${id} is already linked to ${reused.rows[0].record_reference}.`);
    }
    const snapshot = await fetchLinkedReturnTransaction({
      netsuiteTransactionId: id,
      netsuiteStage: type
    });
    if (!snapshot) throw httpError(404, "NetSuite transaction was not found.");
    const statusText = cleanText(
      snapshot.status?.refName || snapshot.status?.id || snapshot.status || "",
      "NetSuite status",
      180
    );
    if (/cancel|void|reject/i.test(statusText)) {
      throw httpError(409, "A cancelled, voided, or rejected NetSuite transaction cannot be linked.");
    }
    const entityId = Number(snapshot.entity?.id || snapshot.entity);
    if (!Number.isSafeInteger(entityId) || entityId <= 0) {
      throw httpError(409, "NetSuite transaction customer could not be verified.");
    }
    if (entityId !== detail.customerId) {
      throw httpError(409, "NetSuite transaction customer does not match this return.");
    }
    const sourceId = Number(snapshot.createdFrom?.id || snapshot.createdfrom?.id || snapshot.createdFrom);
    if (detail.recordType === "stock"
        && (!Number.isSafeInteger(sourceId) || sourceId <= 0 || sourceId !== detail.sourceSalesOrderId)) {
      throw httpError(409, "NetSuite Return Authorization source Sales Order could not be verified.");
    }
    const locationId = Number(snapshot.location?.id || snapshot.location);
    if (!Number.isSafeInteger(locationId) || locationId <= 0 || locationId !== detail.receivingLocationId) {
      throw httpError(409, "NetSuite transaction location could not be verified against the actual receiving yard.");
    }
    const items = transactionItems(snapshot);
    if (!items.length) {
      throw httpError(409, "NetSuite transaction item lines could not be verified. Expand its item subresource and try again.");
    }
    const required = detail.recordType === "pallet"
      ? [{
          itemId: Number(detail.balanceSnapshot?.item?.id || detail.balanceSnapshot?.item?.itemId),
          netSuiteOrderLine: null,
          returnedSalesQuantity: Number(detail.palletQuantity),
          itemName: "PALLET",
          reasonId: 10,
          rate: 40
        }]
      : detail.lines.filter((line) => ["not_required", "approved"].includes(line.approvalStatus));
    if (!required.length) throw httpError(409, "This return has no accepted quantity to link.");
    const available = new Map();
    for (const item of items) {
      const itemId = Number(item.item?.id || item.item);
      const orderLine = Number(item.orderLine || item.orderline) || null;
      const reasonId = Number(
        item.custcol_atlas_rc_so?.id
        || item.custcol_atlas_rc_so
        || item.custcolAtlasRcSo?.id
      );
      const itemRate = Number(item.rate);
      if (!Number.isSafeInteger(itemId) || itemId <= 0
          || !Number.isSafeInteger(reasonId) || reasonId <= 0
          || !Number.isFinite(itemRate)) {
        continue;
      }
      const key = `${itemId}|${orderLine || ""}|${reasonId}|${itemRate.toFixed(8)}`;
      const amount = Math.abs(Number(item.quantity || 0));
      available.set(key, (available.get(key) || 0) + amount);
    }
    const requiredByKey = new Map();
    for (const line of required) {
      if (line.rate === null || line.rate === undefined || !Number.isFinite(Number(line.rate))) {
        throw httpError(409, `${line.itemName} rate cannot be verified for manual linking.`);
      }
      const key = `${line.itemId}|${line.netSuiteOrderLine || ""}|${line.reasonId}|${Number(line.rate).toFixed(8)}`;
      requiredByKey.set(key, {
        quantity: (requiredByKey.get(key)?.quantity || 0) + Number(line.returnedSalesQuantity || 0),
        itemName: line.itemName
      });
    }
    for (const [key, needed] of requiredByKey) {
      if ((available.get(key) || 0) + QUANTITY_EPSILON < needed.quantity) {
        throw httpError(409, `NetSuite transaction does not contain enough ${needed.itemName}.`);
      }
    }
    const rawCreditValue = type === "credit_memo"
      ? Number(snapshot.total ?? snapshot.foreignTotal)
      : NaN;
    const creditValue = Number.isFinite(rawCreditValue) ? Math.abs(rawCreditValue) : NaN;
    const authoritativeTranid = cleanText(
      snapshot.tranId || snapshot.tranid || "",
      "NetSuite transaction number",
      80
    );
    const providedTranid = cleanText(
      netsuiteTranid || "",
      "NetSuite transaction number",
      80
    );
    if (providedTranid && authoritativeTranid
        && providedTranid.toUpperCase() !== authoritativeTranid.toUpperCase()) {
      throw httpError(409, `NetSuite transaction ${id} is ${authoritativeTranid}, not ${providedTranid}.`);
    }
    await query(
      `UPDATE return_records
          SET netsuite_stage = $2,
              netsuite_transaction_id = $3,
              netsuite_transaction_ref = $4,
              netsuite_transaction_status = COALESCE(NULLIF($5, ''), netsuite_transaction_status),
              netsuite_sync_status = 'manual_linked',
              netsuite_sync_error = NULL,
              netsuite_last_synced_at = now(),
              netsuite_snapshot = $6::jsonb,
              actual_credit = COALESCE($7, actual_credit),
              updated_at = now()
        WHERE id = $1`,
      [
        detail.id,
        type,
        id,
        authoritativeTranid || providedTranid,
        statusText,
        JSON.stringify(snapshot),
        Number.isFinite(creditValue) ? creditValue : null
      ]
    );
    await writeSyncEvent({
      recordId: detail.id,
      eventType: "manual_link",
      status: "succeeded",
      response: snapshot,
      actorOperatorId
    });
    await writeAudit({
      actorOperatorId,
      source: "returns",
      action: "returns.netsuite.manual_link",
      orderId: detail.sourceSalesOrderId,
      details: { returnRecordId: detail.id, transactionType: type, netsuiteId: id }
    });
    return detail.id;
  });
  return getReturnRecordDetail(linkedRecordId);
}

export async function processPendingReturnSyncs({ limit = 25 } = {}) {
  const pending = await query(
    `SELECT r.id
       FROM return_records r
       INNER JOIN return_yard_settings ys
         ON ys.location_id = r.receiving_location_id
      WHERE r.netsuite_sync_status = 'pending'
        AND r.status NOT IN ('voided', 'rejected')
        AND (
          (r.record_type = 'stock' AND ys.auto_create_stock_ra = true)
          OR
          (r.record_type = 'pallet' AND ys.auto_create_pallet_credit_memo = true)
        )
      ORDER BY r.updated_at, r.id
      LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit) || 25))]
  );
  const summary = { queued: pending.rowCount, succeeded: 0, failed: 0 };
  for (const row of pending.rows) {
    try {
      await syncReturnRecord({ recordId: row.id });
      summary.succeeded += 1;
    } catch {
      // syncReturnRecord persists a deterministic blocked/failed state while
      // holding the per-record advisory lock. Failed rows require admin retry.
      summary.failed += 1;
    }
  }
  return summary;
}

export async function reconcileReturnRecords({ limit = 50, actorOperatorId = null } = {}) {
  const records = await query(
    `SELECT id
       FROM return_records
      WHERE netsuite_transaction_id IS NOT NULL
        AND netsuite_sync_status IN ('succeeded', 'manual_linked')
      ORDER BY netsuite_last_synced_at NULLS FIRST, id
      LIMIT $1`,
    [Math.min(200, Math.max(1, Number(limit) || 50))]
  );
  const summary = { checked: 0, updated: 0, failed: 0, skipped: 0 };
  for (const row of records.rows) {
    summary.checked += 1;
    const outcome = await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-sync:${row.id}`]);
      const detail = await getReturnRecordDetail(row.id);
      if (!detail || detail.status === "voided") return { skipped: true };
      try {
        const snapshot = await fetchLinkedReturnTransaction({
          netsuiteTransactionId: detail.netSuiteTransactionId,
          netsuiteStage: detail.netSuiteStage
        });
        if (!snapshot) throw new Error("Linked NetSuite return transaction was not found.");
        const transactionStatus = cleanText(
          snapshot.status?.refName || snapshot.status?.id || snapshot.status || "",
          "NetSuite status",
          180
        );
        const creditMemos = detail.netSuiteStage === "return_authorization"
          ? await findCreditMemosFromReturnAuthorization(detail.netSuiteTransactionId)
          : [];
        const creditValues = (detail.netSuiteStage === "return_authorization"
          ? creditMemos
            .map((credit) => Number(credit.foreigntotal))
            .filter(Number.isFinite)
          : [Number(snapshot.total ?? snapshot.foreignTotal)].filter(Number.isFinite))
          .map(Math.abs);
        const actualCredit = creditValues.length
          ? creditValues.reduce((total, value) => total + value, 0)
          : null;
        const transactionRef = cleanText(
          snapshot.tranId || snapshot.tranid || detail.netSuiteTransactionRef,
          "NetSuite transaction number",
          80
        );
        const reconciliationSnapshot = detail.netSuiteStage === "return_authorization"
          ? {
              returnAuthorization: snapshot,
              returnAuthorizationId: detail.netSuiteTransactionId,
              creditMemos,
              creditMemoIds: creditMemos.map((credit) => Number(credit.id))
            }
          : { creditMemo: snapshot };
        await query(
          `UPDATE return_records
              SET netsuite_transaction_ref = COALESCE(NULLIF($2, ''), netsuite_transaction_ref),
                  netsuite_transaction_status = $3,
                  netsuite_sync_status = CASE
                    WHEN $3 ~* '(cancel|void|reject)' THEN 'cancelled'
                    ELSE netsuite_sync_status
                  END,
                  actual_credit = $4,
                  netsuite_snapshot = $5::jsonb,
                  netsuite_last_synced_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [
            detail.id,
            transactionRef,
            transactionStatus,
            actualCredit,
            JSON.stringify(reconciliationSnapshot)
          ]
        );
        await writeSyncEvent({
          recordId: detail.id,
          eventType: "reconcile",
          status: "succeeded",
          response: {
            transactionId: detail.netSuiteTransactionId,
            transactionStatus,
            creditMemoIds: creditMemos.map((credit) => Number(credit.id)),
            actualCredit
          },
          actorOperatorId
        });
        await writeAudit({
          actorOperatorId,
          actorType: actorOperatorId ? "operator" : "system",
          source: "returns",
          action: "returns.netsuite.reconcile",
          orderId: detail.sourceSalesOrderId,
          details: {
            returnRecordId: detail.id,
            recordReference: detail.recordReference,
            netSuiteStage: detail.netSuiteStage,
            transactionId: detail.netSuiteTransactionId,
            creditMemoIds: creditMemos.map((credit) => Number(credit.id)),
            actualCredit
          }
        });
        return { updated: true };
      } catch (error) {
        await query(
          `UPDATE return_records
              SET netsuite_last_synced_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [row.id]
        );
        await writeSyncEvent({
          recordId: row.id,
          eventType: "reconcile",
          status: "failed",
          error: error.message,
          actorOperatorId
        });
        return { error };
      }
    });
    if (outcome.skipped) summary.skipped += 1;
    else if (outcome.error) summary.failed += 1;
    else if (outcome.updated) summary.updated += 1;
  }
  return summary;
}
