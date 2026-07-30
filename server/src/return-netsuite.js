import {
  createOrUpdateCreditMemoInNetSuite,
  createOrUpdateReturnAuthorizationInNetSuite,
  fetchCreditMemoFromNetSuite,
  fetchCreditMemoMetadataFromNetSuite,
  fetchReturnAuthorizationFromNetSuite,
  fetchSalesOrderReturnLinesFromNetSuite,
  resolvePalletItemFromNetSuite,
  suiteql,
  suiteqlAll
} from "./netsuite.js";

export const CONFIRMED_RETURN_REASONS = Object.freeze([
  { id: 5, code: "R1", label: "R1 - Color Variation", kind: "quality" },
  { id: 6, code: "R2", label: "R2 - Efflorescence", kind: "quality" },
  { id: 7, code: "R3", label: "R3 - Chipping / Crack", kind: "quality" },
  { id: 8, code: "R4", label: "R4 - Surface", kind: "quality" },
  { id: 9, code: "R5", label: "R5 - Others", kind: "quality" },
  { id: 10, code: "GD", label: "GD - Good Condition", kind: "normal" }
]);

let reasonCache = {
  expiresAt: 0,
  options: CONFIRMED_RETURN_REASONS,
  source: "confirmed_fallback"
};
const REASON_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RETURN_CUSTOMER_CACHE_TTL_MS = 60 * 1000;
// Enquiries may reuse a recent full-history snapshot so operators do not wait
// on the same 10+ second NetSuite aggregate repeatedly. Submission always
// calls this lookup with force=true before reserving any quantity.
const PALLET_BALANCE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RETURN_LOOKUP_CACHE_ENTRIES = 250;

const returnCustomerCache = new Map();
const returnCustomerSearchCache = new Map();
const palletBalanceCache = new Map();
const palletBalanceInflight = new Map();

function cachedValue(cache, key) {
  const current = cache.get(key);
  if (!current || current.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh insertion order so the bounded maps behave like small LRU caches.
  cache.delete(key);
  cache.set(key, current);
  return current.value;
}

function storeCachedValue(cache, key, value, ttlMs) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > MAX_RETURN_LOOKUP_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return value;
}

function sqlText(value, { maxLength = 180 } = {}) {
  return String(value || "").trim().slice(0, maxLength).replaceAll("'", "''");
}

function positiveId(value, label = "NetSuite internal ID") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error(`A valid ${label} is required.`), { status: 400 });
  }
  return id;
}

function returnOrderFilter(value) {
  const text = String(value || "").trim().toUpperCase();
  if (/^[1-9]\d*$/.test(text)) return `t.id = ${Number(text)}`;
  if (!/^SO(?:A|B|M)\d+$/.test(text) || text.length > 64) {
    throw Object.assign(new Error("Enter a valid Sales Order number."), { status: 400 });
  }
  return `UPPER(t.tranid) = '${sqlText(text, { maxLength: 64 })}'`;
}

function number(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value) {
  return value === true || value === "T" || value === "true";
}

function sourceLineId(row) {
  return Number(row.line_id || row.line_unique_key || row.uniquekey);
}

function normalizeReturnOrderRows(rows = []) {
  if (!rows.length) return null;
  const first = rows[0];
  const order = {
    id: Number(first.id),
    netsuiteId: Number(first.id),
    tranid: first.tranid || "",
    transactionDate: first.trandate || null,
    status: first.status || "",
    statusText: first.status_text || "",
    orderingLocationId: Number(first.ordering_location_id) || null,
    orderingLocationName: first.ordering_location_name || "",
    customer: {
      id: Number(first.customer_id),
      internalId: Number(first.customer_id),
      code: first.customer_code || "",
      entityId: first.customer_code || "",
      name: first.customer_name || first.customer || "",
      companyName: first.customer_name || first.customer || "",
      phone: first.customer_phone || "",
      address: first.customer_address || ""
    }
  };
  order.lines = rows.map((row) => ({
    lineId: sourceLineId(row),
    sourceLineId: sourceLineId(row),
    suiteQlLineNumber: Number(row.suiteql_line_number),
    itemId: Number(row.item_id),
    itemName: row.item_name || "",
    description: row.item_description || "",
    itemType: row.item_type || "",
    itemTypeText: row.item_type_text || "",
    salesQuantity: number(row.sales_quantity),
    salesUom: row.sales_uom || "",
    fulfilledQuantity: number(row.fulfilled_quantity),
    rate: nullableNumber(row.rate),
    foreignAmount: nullableNumber(row.foreign_amount),
    locationId: Number(row.line_location_id) || null,
    locationName: row.line_location_name || "",
    toPlt: nullableNumber(row.to_plt),
    toLyr: nullableNumber(row.to_lyr),
    toSec: nullableNumber(row.to_sec),
    toPcs: nullableNumber(row.to_pcs),
    productType: row.product_type || "",
    inactive: bool(row.item_inactive),
    raw: row
  }));
  return order;
}

export async function fetchReturnSalesOrderFromNetSuite(code, {
  includeRestLineMapping = true
} = {}) {
  const rows = await suiteqlAll(`
    SELECT
      t.id,
      t.tranid,
      t.trandate,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.location AS ordering_location_id,
      BUILTIN.DF(t.location) AS ordering_location_name,
      t.entity AS customer_id,
      c.entityid AS customer_code,
      COALESCE(NULLIF(c.companyname, ''), BUILTIN.DF(t.entity)) AS customer_name,
      c.phone AS customer_phone,
      BUILTIN.DF(c.defaultshippingaddress) AS customer_address,
      tl.uniquekey AS line_id,
      tl.id AS suiteql_line_number,
      tl.item AS item_id,
      BUILTIN.DF(tl.item) AS item_name,
      tl.memo AS item_description,
      i.itemtype AS item_type,
      BUILTIN.DF(i.itemtype) AS item_type_text,
      ABS(NVL(tl.quantity, 0)) AS sales_quantity,
      ABS(NVL(tl.quantityshiprecv, 0)) AS fulfilled_quantity,
      BUILTIN.DF(tl.units) AS sales_uom,
      tl.rate,
      tl.foreignamount AS foreign_amount,
      tl.location AS line_location_id,
      BUILTIN.DF(tl.location) AS line_location_name,
      i.custitem_toplt AS to_plt,
      i.custitem_tolyr AS to_lyr,
      i.custitem_tosec AS to_sec,
      i.custitem_topcs AS to_pcs,
      i.isinactive AS item_inactive
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    INNER JOIN item i ON i.id = tl.item
    LEFT JOIN customer c ON c.id = t.entity
    WHERE ${returnOrderFilter(code)}
      AND t.type = 'SalesOrd'
      AND tl.item IS NOT NULL
      AND tl.mainline = 'F'
      AND (tl.taxline = 'F' OR tl.taxline IS NULL)
    ORDER BY tl.uniquekey
  `);
  const order = normalizeReturnOrderRows(rows);
  if (!order || !includeRestLineMapping) return order;
  return attachReturnSalesOrderRestLineMapping(order);
}

export async function attachReturnSalesOrderRestLineMapping(order) {
  if (!order?.id || !Array.isArray(order.lines)) {
    throw Object.assign(new Error("A complete NetSuite Sales Order is required for REST line mapping."), {
      status: 400
    });
  }
  const restItems = await fetchSalesOrderReturnLinesFromNetSuite(order.id);
  const unused = new Set(restItems.map((_, index) => index));
  for (const line of order.lines) {
    const exact = [...unused].filter((index) => {
      const item = restItems[index];
      const orderLine = Number(item.orderLine ?? item.orderline ?? item.line ?? item.lineNumber);
      const itemId = Number(item.item?.id ?? item.item);
      return orderLine === line.suiteQlLineNumber && itemId === line.itemId;
    });
    let matchedIndex = exact.length === 1 ? exact[0] : null;
    if (matchedIndex === null) {
      const candidates = [...unused].filter((index) => {
        const item = restItems[index];
        const itemId = Number(item.item?.id ?? item.item);
        const quantityMatches = Math.abs(number(item.quantity)) === Math.abs(number(line.salesQuantity));
        const locationId = Number(item.location?.id ?? item.location) || null;
        const locationMatches = !line.locationId || !locationId || line.locationId === locationId;
        return itemId === line.itemId && quantityMatches && locationMatches;
      });
      if (candidates.length !== 1) {
        throw Object.assign(
          new Error(`NetSuite REST orderLine could not be mapped unambiguously for ${line.itemName || line.itemId}.`),
          { status: 409, code: "NETSUITE_ORDER_LINE_AMBIGUOUS", sourceLineId: line.sourceLineId }
        );
      }
      [matchedIndex] = candidates;
    }
    const restItem = restItems[matchedIndex];
    const netSuiteOrderLine = Number(
      restItem.orderLine ?? restItem.orderline ?? restItem.line ?? restItem.lineNumber
    );
    if (!Number.isSafeInteger(netSuiteOrderLine) || netSuiteOrderLine <= 0) {
      throw Object.assign(
        new Error(`NetSuite REST orderLine is missing for ${line.itemName || line.itemId}.`),
        { status: 409, code: "NETSUITE_ORDER_LINE_MISSING", sourceLineId: line.sourceLineId }
      );
    }
    unused.delete(matchedIndex);
    line.netSuiteOrderLine = netSuiteOrderLine;
    line.netSuiteOrderLineSnapshot = restItem;
  }
  return order;
}

export async function fetchReturnCustomersFromNetSuite(search, { limit = 25 } = {}) {
  const term = String(search || "").trim();
  if (term.length < 2) {
    throw Object.assign(new Error("Enter at least two characters to search customers."), { status: 400 });
  }
  const safeTerm = sqlText(term, { maxLength: 100 });
  const safePhoneTerm = sqlText(term.replace(/[()\s+.-]/g, ""), { maxLength: 100 });
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 25));
  const cacheKey = `${term.toUpperCase()}|${safeLimit}`;
  const cached = cachedValue(returnCustomerSearchCache, cacheKey);
  if (cached) return cached;

  const internalId = /^[1-9]\d*$/.test(term) && Number.isSafeInteger(Number(term))
    ? Number(term)
    : null;
  const phoneSearch = /^[+()\d.\s-]+$/.test(term) && safePhoneTerm.length >= 7;
  const predicates = [
    `UPPER(c.entityid) LIKE UPPER('${safeTerm}%')`,
    `UPPER(COALESCE(c.companyname, '')) LIKE UPPER('${safeTerm}%')`
  ];
  if (internalId) predicates.unshift(`c.id = ${internalId}`);
  if (phoneSearch) {
    // Phone normalization is intentionally only evaluated for phone-shaped
    // input. Running this expression for every name lookup forced a full
    // customer scan and punctuation-only input previously became LIKE '%%'.
    predicates.push(`
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        COALESCE(c.phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')
      LIKE '%${safePhoneTerm}%'
    `);
  }
  const rows = await suiteqlAll(`
    SELECT
      c.id,
      c.entityid,
      c.companyname,
      c.phone,
      BUILTIN.DF(c.defaultshippingaddress) AS address,
      c.isinactive
    FROM customer c
    WHERE c.isinactive = 'F'
      AND (${predicates.join("\n        OR ")})
    ORDER BY
      CASE
        WHEN UPPER(c.entityid) = UPPER('${safeTerm}') THEN 0
        ${internalId ? `WHEN c.id = ${internalId} THEN 0` : ""}
        WHEN UPPER(c.entityid) LIKE UPPER('${safeTerm}%') THEN 1
        WHEN UPPER(COALESCE(c.companyname, '')) LIKE UPPER('${safeTerm}%') THEN 2
        ELSE 3
      END,
      c.entityid,
      c.id
    FETCH FIRST ${safeLimit} ROWS ONLY
  `);
  const customers = rows.map((row) => ({
    id: Number(row.id),
    internalId: Number(row.id),
    code: row.entityid || "",
    entityId: row.entityid || "",
    name: row.companyname || row.entityid || "",
    companyName: row.companyname || "",
    phone: row.phone || "",
    address: row.address || ""
  }));
  for (const customer of customers) {
    storeCachedValue(
      returnCustomerCache,
      String(customer.id),
      customer,
      RETURN_CUSTOMER_CACHE_TTL_MS
    );
  }
  return storeCachedValue(
    returnCustomerSearchCache,
    cacheKey,
    customers,
    RETURN_CUSTOMER_CACHE_TTL_MS
  );
}

export async function fetchActiveReturnCustomerDirectoryFromNetSuite() {
  const rows = await suiteqlAll(`
    SELECT
      c.id,
      c.entityid,
      c.companyname,
      c.phone,
      BUILTIN.DF(c.defaultshippingaddress) AS address,
      c.isinactive
    FROM customer c
    WHERE c.isinactive = 'F'
    ORDER BY c.id
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    internalId: Number(row.id),
    code: row.entityid || "",
    entityId: row.entityid || "",
    name: row.companyname || row.entityid || "",
    companyName: row.companyname || "",
    phone: row.phone || "",
    address: row.address || ""
  }));
}

export async function fetchReturnCustomerFromNetSuite(customerId, { force = false } = {}) {
  const id = positiveId(customerId, "NetSuite customer ID");
  if (!force) {
    const cached = cachedValue(returnCustomerCache, String(id));
    if (cached) return cached;
  }
  const result = await suiteql(`
    SELECT
      c.id,
      c.entityid,
      c.companyname,
      c.phone,
      BUILTIN.DF(c.defaultshippingaddress) AS address,
      c.isinactive
    FROM customer c
    WHERE c.id = ${id}
      AND c.isinactive = 'F'
  `);
  const row = result.items?.[0];
  const customer = row ? {
    id: Number(row.id),
    internalId: Number(row.id),
    code: row.entityid || "",
    entityId: row.entityid || "",
    name: row.companyname || row.entityid || "",
    companyName: row.companyname || "",
    phone: row.phone || "",
    address: row.address || ""
  } : null;
  if (customer) {
    storeCachedValue(
      returnCustomerCache,
      String(customer.id),
      customer,
      RETURN_CUSTOMER_CACHE_TTL_MS
    );
  }
  return customer;
}

export function summarizePalletActivityRows(rows = []) {
  const transactionCount = (row) => {
    if (row.transaction_count === null
        || row.transaction_count === undefined
        || row.transaction_count === "") return 1;
    return Math.max(0, Number(row.transaction_count) || 0);
  };
  const activeRows = rows.filter((row) => {
    const status = `${row.status || ""} ${row.status_text || ""}`.toUpperCase();
    return !status.includes("VOID") && !status.includes("CANCEL") && !status.includes("REJECT");
  });
  const fulfilledRows = activeRows.filter((row) => row.transaction_type === "ItemShip");
  const returnedRows = activeRows.filter((row) => row.transaction_type === "CustCred");
  return {
    fulfilled: fulfilledRows.reduce((sum, row) => sum + number(row.quantity), 0),
    netsuiteReturned: returnedRows.reduce((sum, row) => sum + number(row.quantity), 0),
    externalIds: returnedRows.map((row) => row.externalid).filter(Boolean),
    transactionIds: returnedRows
      .map((row) => Number(row.transaction_id))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
    fulfillmentTransactionCount: fulfilledRows.reduce(
      (sum, row) => sum + transactionCount(row),
      0
    ),
    creditMemoTransactionCount: returnedRows.reduce(
      (sum, row) => sum + transactionCount(row),
      0
    )
  };
}

export function palletActivityQuery(customerId, palletItemId) {
  const id = positiveId(customerId, "NetSuite customer ID");
  const itemId = positiveId(palletItemId, "NetSuite PALLET item ID");
  return `
    SELECT
      0 AS transaction_id,
      '' AS tranid,
      'ItemShip' AS transaction_type,
      '' AS status,
      '' AS status_text,
      '' AS externalid,
      NULL AS trandate,
      SUM(ABS(NVL(tl.quantity, 0))) AS quantity,
      COUNT(DISTINCT t.id) AS transaction_count
    FROM transaction t
    INNER JOIN customer c
      ON c.id = t.entity
     AND c.id = ${id}
    INNER JOIN transactionline tl
      ON tl.transaction = t.id
    WHERE t.type = 'ItemShip'
      AND tl.item = ${itemId}
      AND tl.mainline = 'F'
      AND (tl.taxline = 'F' OR tl.taxline IS NULL)
      AND UPPER(NVL(BUILTIN.DF(t.status), '')) NOT LIKE '%VOID%'
      AND UPPER(NVL(BUILTIN.DF(t.status), '')) NOT LIKE '%CANCEL%'
      AND UPPER(NVL(BUILTIN.DF(t.status), '')) NOT LIKE '%REJECT%'

    UNION ALL

    SELECT
      t.id AS transaction_id,
      t.tranid,
      'CustCred' AS transaction_type,
      t.status,
      BUILTIN.DF(t.status) AS status_text,
      t.externalid,
      t.trandate,
      SUM(ABS(NVL(tl.quantity, 0))) AS quantity,
      1 AS transaction_count
    FROM transaction t
    INNER JOIN customer c
      ON c.id = t.entity
     AND c.id = ${id}
    INNER JOIN transactionline tl
      ON tl.transaction = t.id
    WHERE t.type = 'CustCred'
      AND tl.item = ${itemId}
      AND tl.mainline = 'F'
      AND (tl.taxline = 'F' OR tl.taxline IS NULL)
      AND UPPER(NVL(BUILTIN.DF(t.status), '')) NOT LIKE '%VOID%'
      AND UPPER(NVL(BUILTIN.DF(t.status), '')) NOT LIKE '%CANCEL%'
      AND UPPER(NVL(BUILTIN.DF(t.status), '')) NOT LIKE '%REJECT%'
    GROUP BY
      t.id,
      t.tranid,
      t.status,
      BUILTIN.DF(t.status),
      t.externalid,
      t.trandate
    ORDER BY transaction_id
  `;
}

export async function fetchPalletBalanceFromNetSuite(customerId, { force = false } = {}) {
  const id = positiveId(customerId, "NetSuite customer ID");
  const cacheKey = String(id);
  if (!force) {
    const cached = cachedValue(palletBalanceCache, cacheKey);
    if (cached) return cached;
    const active = palletBalanceInflight.get(cacheKey);
    if (active) return active;
  }
  const lookup = (async () => {
    const pallet = await resolvePalletItemFromNetSuite();
    const rows = await suiteqlAll(palletActivityQuery(id, pallet.id));
    const summary = summarizePalletActivityRows(rows);
    const balance = {
      item: pallet,
      ...summary,
      source: "netsuite_itemship_creditmemo_transactions",
      lookedUpAt: new Date().toISOString()
    };
    storeCachedValue(palletBalanceCache, cacheKey, balance, PALLET_BALANCE_CACHE_TTL_MS);
    return balance;
  })();
  if (!force) palletBalanceInflight.set(cacheKey, lookup);
  try {
    return await lookup;
  } finally {
    if (palletBalanceInflight.get(cacheKey) === lookup) palletBalanceInflight.delete(cacheKey);
  }
}

export async function fetchStockReturnsFromNetSuite(salesOrderId) {
  const id = positiveId(salesOrderId, "NetSuite Sales Order ID");
  // NextTransactionLineLink keeps the exact originating SO line. Start with
  // the cheap direct SO link query. Only orders that actually have an RA need
  // the more expensive RA -> Credit Memo lookup; most orders therefore avoid
  // that second NetSuite query entirely.
  const directRows = await suiteqlAll(`
    SELECT
      source_tl.uniquekey AS source_line_id,
      next_t.id AS transaction_id,
      next_tl.id AS linked_line_id,
      next_t.tranid,
      next_t.type AS transaction_type,
      next_t.status,
      BUILTIN.DF(next_t.status) AS status_text,
      ABS(NVL(next_tl.quantity, 0)) AS quantity,
      next_tl.item AS item_id,
      next_t.externalid
    FROM NextTransactionLineLink source_link
    INNER JOIN transactionline source_tl
      ON source_tl.transaction = source_link.previousdoc
     AND source_tl.id = source_link.previousline
    INNER JOIN transaction next_t ON next_t.id = source_link.nextdoc
    INNER JOIN transactionline next_tl
      ON next_tl.transaction = source_link.nextdoc
     AND next_tl.id = source_link.nextline
    WHERE source_link.previousdoc = ${id}
      AND next_t.type IN ('RtnAuth', 'CustCred')
      AND next_tl.item IS NOT NULL
      AND next_tl.mainline = 'F'
      AND (next_tl.taxline = 'F' OR next_tl.taxline IS NULL)
    ORDER BY source_link.previousline, next_t.id, next_tl.id
  `);

  const returnAuthorizationParents = new Map();
  for (const row of directRows) {
    if (row.transaction_type !== "RtnAuth") continue;
    const key = `${row.transaction_id}|${row.linked_line_id}`;
    const parents = returnAuthorizationParents.get(key) || [];
    parents.push(row);
    returnAuthorizationParents.set(key, parents);
  }
  const returnAuthorizationIds = [...new Set(
    directRows
      .filter((row) => row.transaction_type === "RtnAuth")
      .map((row) => Number(row.transaction_id))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  )];
  let transformedCreditRows = [];
  if (returnAuthorizationIds.length) {
    const creditRows = await suiteqlAll(`
    SELECT
      credit_link.previousdoc AS parent_transaction_id,
      credit_link.previousline AS parent_line_id,
      credit_t.id AS transaction_id,
      credit_t.tranid,
      credit_t.type AS transaction_type,
      credit_t.status,
      BUILTIN.DF(credit_t.status) AS status_text,
      ABS(NVL(credit_tl.quantity, 0)) AS quantity,
      credit_tl.item AS item_id,
      credit_t.externalid
    FROM NextTransactionLineLink credit_link
    INNER JOIN transaction credit_t
      ON credit_t.id = credit_link.nextdoc
     AND credit_t.type = 'CustCred'
    INNER JOIN transactionline credit_tl
      ON credit_tl.transaction = credit_link.nextdoc
     AND credit_tl.id = credit_link.nextline
    WHERE credit_link.previousdoc IN (${returnAuthorizationIds.join(", ")})
      AND credit_tl.item IS NOT NULL
      AND credit_tl.mainline = 'F'
      AND (credit_tl.taxline = 'F' OR credit_tl.taxline IS NULL)
    ORDER BY credit_link.previousdoc, credit_link.previousline, credit_t.id, credit_tl.id
    `);
    transformedCreditRows = creditRows.flatMap((row) => {
      const parents = returnAuthorizationParents.get(
        `${row.parent_transaction_id}|${row.parent_line_id}`
      ) || [];
      return parents.map((parent) => ({
        ...row,
        source_line_id: parent.source_line_id,
        parent_tranid: parent.tranid,
        parent_status: parent.status,
        parent_status_text: parent.status_text,
        parent_externalid: parent.externalid
      }));
    });
  }

  const inactiveStatus = (row, { reject = false } = {}) => {
    const status = `${row.status || ""} ${row.status_text || ""}`.toUpperCase();
    return status.includes("CANCEL") || status.includes("VOID") || (reject && status.includes("REJECT"));
  };
  const byLine = new Map();
  const ensureLine = (row) => {
    const key = String(row.source_line_id || "");
    const current = byLine.get(key) || {
      sourceLineId: Number(row.source_line_id),
      netsuiteReturned: 0,
      transactions: []
    };
    byLine.set(key, current);
    return current;
  };
  const raGroups = new Map();

  for (const row of directRows) {
    const current = ensureLine(row);
    if (row.transaction_type === "CustCred") {
      if (inactiveStatus(row)) continue;
      const counted = number(row.quantity);
      current.netsuiteReturned += counted;
      current.transactions.push({
        id: Number(row.transaction_id),
        tranid: row.tranid || "",
        type: "credit_memo",
        status: row.status || "",
        statusText: row.status_text || "",
        quantity: counted,
        countedQuantity: counted,
        itemId: Number(row.item_id),
        externalId: row.externalid || ""
      });
      continue;
    }
    const groupKey = `${row.source_line_id}|${row.transaction_id}`;
    const group = raGroups.get(groupKey) || {
      line: current,
      sourceLineId: Number(row.source_line_id),
      itemId: Number(row.item_id),
      id: Number(row.transaction_id),
      tranid: row.tranid || "",
      status: row.status || "",
      statusText: row.status_text || "",
      externalId: row.externalid || "",
      active: !inactiveStatus(row, { reject: true }),
      authorizedQuantity: 0,
      creditedQuantity: 0,
      credits: new Map()
    };
    group.authorizedQuantity += number(row.quantity);
    raGroups.set(groupKey, group);
  }

  for (const row of transformedCreditRows) {
    if (inactiveStatus(row)) continue;
    const current = ensureLine(row);
    const groupKey = `${row.source_line_id}|${row.parent_transaction_id}`;
    const parentStatusRow = {
      status: row.parent_status,
      status_text: row.parent_status_text
    };
    const group = raGroups.get(groupKey) || {
      line: current,
      sourceLineId: Number(row.source_line_id),
      itemId: Number(row.item_id),
      id: Number(row.parent_transaction_id),
      tranid: row.parent_tranid || "",
      status: row.parent_status || "",
      statusText: row.parent_status_text || "",
      externalId: row.parent_externalid || "",
      active: !inactiveStatus(parentStatusRow, { reject: true }),
      authorizedQuantity: 0,
      creditedQuantity: 0,
      credits: new Map()
    };
    const creditId = Number(row.transaction_id);
    const credit = group.credits.get(creditId) || {
      id: creditId,
      tranid: row.tranid || "",
      status: row.status || "",
      statusText: row.status_text || "",
      quantity: 0,
      itemId: Number(row.item_id),
      externalId: row.externalid || ""
    };
    const creditQuantity = number(row.quantity);
    credit.quantity += creditQuantity;
    group.creditedQuantity += creditQuantity;
    group.credits.set(creditId, credit);
    raGroups.set(groupKey, group);
  }

  for (const group of raGroups.values()) {
    const counted = group.active
      ? Math.max(group.authorizedQuantity, group.creditedQuantity)
      : group.creditedQuantity;
    group.line.netsuiteReturned += counted;
    group.line.transactions.push({
      id: group.id,
      tranid: group.tranid,
      type: "return_authorization",
      status: group.status,
      statusText: group.statusText,
      quantity: group.authorizedQuantity,
      creditedQuantity: group.creditedQuantity,
      countedQuantity: counted,
      itemId: group.itemId,
      externalId: group.externalId,
      active: group.active,
      linkedCreditMemos: [...group.credits.values()]
    });
  }

  for (const current of byLine.values()) {
    current.netsuiteReturned = Math.round(current.netsuiteReturned * 1e8) / 1e8;
    current.transactions.sort((left, right) => Number(left.id) - Number(right.id));
  }
  return byLine;
}

function recursivelyFindReasonOptions(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) recursivelyFindReasonOptions(item, found);
    return found;
  }
  const id = Number(value.id ?? value.value ?? value.internalId);
  const label = String(value.label ?? value.name ?? value.title ?? "").trim();
  if (Number.isInteger(id) && id >= 5 && id <= 10 && /^(R[1-5]|GD)\s*-/i.test(label)) {
    found.push({ id, label });
  }
  for (const child of Object.values(value)) recursivelyFindReasonOptions(child, found);
  return found;
}

export async function fetchReturnReasonsFromNetSuite({ force = false } = {}) {
  if (!force && reasonCache.expiresAt > Date.now()) return reasonCache;
  try {
    const metadata = await fetchCreditMemoMetadataFromNetSuite();
    const discovered = recursivelyFindReasonOptions(metadata)
      .filter((option, index, all) => all.findIndex((candidate) => candidate.id === option.id) === index)
      .sort((a, b) => a.id - b.id);
    if (discovered.length === 6 && discovered.every((option, index) => option.id === index + 5)) {
      const options = discovered.map((option) => ({
        id: option.id,
        code: option.id === 10 ? "GD" : `R${option.id - 4}`,
        label: option.label,
        kind: option.id === 10 ? "normal" : "quality"
      }));
      reasonCache = { options, source: "netsuite_metadata", expiresAt: Date.now() + REASON_CACHE_TTL_MS };
      return reasonCache;
    }
  } catch {
    // Confirmed IDs/labels are a deliberate availability fallback. Submission
    // still snapshots both ID and label for later reconciliation.
  }
  reasonCache = {
    options: CONFIRMED_RETURN_REASONS,
    source: "confirmed_fallback",
    expiresAt: Date.now() + Math.min(REASON_CACHE_TTL_MS, 15 * 60 * 1000)
  };
  return reasonCache;
}

export async function findReturnTransactionByExternalId(externalId, transactionType) {
  const type = transactionType === "credit_memo" ? "CustCred" : "RtnAuth";
  const value = sqlText(externalId, { maxLength: 180 });
  if (!value) return null;
  const result = await suiteql(`
    SELECT t.id, t.tranid, t.type, t.status, BUILTIN.DF(t.status) AS status_text,
           t.foreigntotal, t.externalid, t.trandate
      FROM transaction t
     WHERE t.type = '${type}'
       AND t.externalid = '${value}'
     ORDER BY t.id DESC
     FETCH FIRST 2 ROWS ONLY
  `);
  return result.items?.[0] || null;
}

export async function findCreditMemosFromReturnAuthorization(returnAuthorizationId) {
  const id = positiveId(returnAuthorizationId, "NetSuite Return Authorization ID");
  const rows = await suiteqlAll(`
    SELECT DISTINCT
      cm.id,
      cm.tranid,
      cm.status,
      BUILTIN.DF(cm.status) AS status_text,
      cm.foreigntotal,
      cm.externalid,
      cm.trandate
    FROM NextTransactionLineLink link
    INNER JOIN transaction cm
      ON cm.id = link.nextdoc
     AND cm.type = 'CustCred'
    WHERE link.previousdoc = ${id}
      AND UPPER(BUILTIN.DF(cm.status)) NOT LIKE '%VOID%'
      AND UPPER(BUILTIN.DF(cm.status)) NOT LIKE '%CANCEL%'
      AND UPPER(BUILTIN.DF(cm.status)) NOT LIKE '%REJECT%'
    ORDER BY cm.id
  `);
  return rows;
}

export async function findCreditMemoFromReturnAuthorization(returnAuthorizationId) {
  const rows = await findCreditMemosFromReturnAuthorization(returnAuthorizationId);
  return rows.at(-1) || null;
}

export function buildReturnAuthorizationPayload(record) {
  const items = (record.lines || []).map((line) => {
    if (line.rate === null || line.rate === undefined || line.rate === "") {
      throw Object.assign(new Error("A NetSuite Sales Order rate is required for every automated return line."), {
        status: 409,
        code: "NETSUITE_RETURN_RATE_MISSING"
      });
    }
    const rate = Number(line.rate);
    if (!Number.isFinite(rate)) {
      throw Object.assign(new Error("A valid NetSuite Sales Order rate is required for every automated return line."), {
        status: 409,
        code: "NETSUITE_RETURN_RATE_INVALID"
      });
    }
    return {
      orderLine: Number(line.netSuiteOrderLine),
      item: { id: String(line.itemId) },
      quantity: Number(line.returnedSalesQuantity),
      rate,
      custcol_atlas_rc_so: { id: String(line.reasonId) }
    };
  });
  return {
    externalId: record.externalId,
    tranDate: record.submittedDate,
    location: { id: String(record.receivingLocationId) },
    memo: record.memo,
    item: { items }
  };
}

export function buildPalletCreditMemoPayload(record) {
  return {
    externalId: record.externalId,
    tranDate: record.submittedDate,
    entity: { id: String(record.customerId) },
    location: { id: String(record.receivingLocationId) },
    memo: record.memo,
    item: {
      items: [{
        item: { id: String(record.palletItemId) },
        quantity: Number(record.palletQuantity),
        rate: 40,
        custcol_atlas_rc_so: { id: "10" }
      }]
    }
  };
}

export async function upsertReturnAuthorizationInNetSuite(record) {
  const orderLines = (record.lines || []).map((line) => Number(line.netSuiteOrderLine));
  if (new Set(orderLines).size !== orderLines.length) {
    throw Object.assign(
      new Error("NetSuite automation cannot safely create split reason rows on the same Sales Order line. Create the Return Authorization manually and link it."),
      { status: 409, code: "NETSUITE_SPLIT_REASON_REQUIRES_MANUAL_RA" }
    );
  }
  const recovered = record.netsuiteTransactionId
    ? null
    : await findReturnTransactionByExternalId(record.externalId, "return_authorization");
  if (recovered) return { recovered: true, ...recovered };
  return createOrUpdateReturnAuthorizationInNetSuite({
    salesOrderId: record.sourceSalesOrderId,
    returnAuthorizationId: record.netsuiteTransactionId,
    payload: buildReturnAuthorizationPayload(record)
  });
}

export async function upsertPalletCreditMemoInNetSuite(record) {
  const recovered = record.netsuiteTransactionId
    ? null
    : await findReturnTransactionByExternalId(record.externalId, "credit_memo");
  if (recovered) return { recovered: true, ...recovered };
  return createOrUpdateCreditMemoInNetSuite({
    creditMemoId: record.netsuiteTransactionId,
    payload: buildPalletCreditMemoPayload(record)
  });
}

export async function fetchLinkedReturnTransaction(record) {
  if (!record?.netsuiteTransactionId) return null;
  return record.netsuiteStage === "credit_memo"
    ? fetchCreditMemoFromNetSuite(record.netsuiteTransactionId)
    : fetchReturnAuthorizationFromNetSuite(record.netsuiteTransactionId);
}
