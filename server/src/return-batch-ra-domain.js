// @ts-check

/** @param {string} message @param {string} [code] */
function invalid(message, code = "RETURN_BATCH_INTENT_INVALID") {
  return Object.assign(new Error(message), { code, status: 409 });
}

/** @param {any} value */
function reference(value) { return Number(value?.id ?? value); }

/** @param {any} value @param {string} label */
function id(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {throw invalid(`A valid ${label} is required.`);}
  return number;
}

/** @param {any} value @param {string} label @param {boolean} [zero] */
function amount(value, label, zero = false) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
      || (zero ? Number(value) < 0 : Number(value) <= 0)) {throw invalid(`Invalid ${label}.`);}
  return Number(value);
}

/** @param {Record<string, any>} record @param {Record<string, any>} first */
function sameBatchIdentity(record, first) {
  return record.batchReference === first.batchReference && record.submittedDate === first.submittedDate
    && !(record.sourceSalesOrderId && first.sourceSalesOrderId
      && Number(record.sourceSalesOrderId) !== Number(first.sourceSalesOrderId));
}

/** @param {Record<string, any>[]} records */
function matchingRecords(records) {
  const first = records[0];
  if (!first || records.length > 2) {throw invalid("A return batch must contain stock, PALLET, or both.");}
  const kinds = new Set();
  for (const record of records) {
    if (!["stock", "pallet"].includes(record.recordType) || kinds.has(record.recordType)) {
      throw invalid("A return batch can contain only one stock and one PALLET record.");
    }
    kinds.add(record.recordType);
    for (const key of ["batchId", "customerId", "receivingLocationId"]) {
      if (id(record[key], key) !== id(first[key], key)) {throw invalid(`Return batch ${key} does not match.`);}
    }
    if (!sameBatchIdentity(record, first)) {
      throw invalid("Return batch identity does not match.");
    }
    if (["voided", "rejected"].includes(record.status) || record.hasPendingApproval) {
      throw invalid("Finish the return decisions before creating its Return Authorization.");
    }
  }
  if (!/^RB-\d+$/.test(first.batchReference)) {throw invalid("A return batch reference is required.");}
  return first;
}

/** @param {Record<string, any>} line */
function stockLine(line) {
  return { kind: "stock", sourceSalesOrderLineId: id(line.sourceSalesOrderLineId, "source line"),
    netSuiteOrderLine: id(line.netSuiteOrderLine, "NetSuite order line"), itemId: id(line.itemId, "item"),
    returnedSalesQuantity: amount(line.returnedSalesQuantity, "stock quantity"), rate: amount(line.rate, "stock rate", true),
    reasonId: id(line.reasonId, "return reason"), salesUomId: line.salesUomId ? id(line.salesUomId, "sales units") : null };
}

/** @param {Record<string, any>[]} records */
export function buildReturnBatchIntent(records) {
  const initial = matchingRecords(records);
  const stock = records.find(record => record.recordType === "stock");
  const pallet = records.find(record => record.recordType === "pallet");
  const first = stock || initial;
  const lines = stock ? stock.lines.map(stockLine) : [];
  if (stock && !lines.length) {throw invalid("A stock return needs accepted stock lines.");}
  if (pallet) {
    const itemId = id(pallet.palletItemId, "PALLET item");
    const quantity = amount(pallet.palletQuantity, "PALLET quantity");
    if (!Number.isInteger(quantity) || lines.some((/** @type {Record<string, any>} */ line) => line.itemId === itemId)) {
      throw invalid("PALLET quantity must be whole and separate from stock.");
    }
    lines.push({ kind: "pallet", itemId, returnedSalesQuantity: quantity, rate: 40, reasonId: 10, salesUomId: null });
  }
  return { version: 3, batchId: Number(first.batchId), batchReference: first.batchReference,
    recordIds: records.map(record => id(record.id, "return record")).sort((a, b) => a - b),
    externalId: `MBBS-${first.batchReference}`, customerId: Number(first.customerId),
    receivingLocationId: Number(first.receivingLocationId),
    sourceSalesOrderId: stock ? id(stock.sourceSalesOrderId, "Sales Order") : null,
    submittedDate: first.submittedDate,
    memo: [records.map(record => record.recordReference).join(" + "), first.batchReference,
      stock?.sourceSalesOrderRef ? `SO ${stock.sourceSalesOrderRef}` : "", `yard ${first.receivingLocationId}`,
      `plate ${first.vehiclePlate}`, first.note || ""].filter(Boolean).join(" | "), lines };
}

/** @param {Record<string, any>} intent */
export function buildReturnBatchPayload(intent) {
  const seen = new Set();
  const items = intent.lines.map((/** @type {Record<string, any>} */ line, /** @type {number} */ index) => {
    const linked = line.kind === "stock" && !seen.has(line.netSuiteOrderLine);
    const split = line.kind === "stock" && !linked;
    if (linked) {seen.add(line.netSuiteOrderLine);}
    return {
      ...(linked ? { orderLine: line.netSuiteOrderLine } : {}),
      ...(split ? { description: `Return from SO ${intent.sourceSalesOrderId}; source line ${line.sourceSalesOrderLineId}; reason ${line.reasonId}; row ${index + 1}` } : {}),
      item: { id: String(line.itemId) }, quantity: line.returnedSalesQuantity, rate: line.rate,
      location: { id: String(intent.receivingLocationId) },
      ...(line.salesUomId ? { units: { id: String(line.salesUomId) } } : {}),
      custcol_atlas_rc_so: { id: String(line.reasonId) }
    };
  });
  return { externalId: intent.externalId, tranDate: intent.submittedDate,
    ...(intent.sourceSalesOrderId ? {} : { entity: { id: String(intent.customerId) } }),
    location: { id: String(intent.receivingLocationId) }, memo: intent.memo, item: { items } };
}

/** @param {string} message */
function mismatch(message) { return invalid(`Return Authorization verification failed: ${message}`, "RETURN_RA_VERIFICATION_FAILED"); }

/** @param {any} value */
function exact(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) {
    throw mismatch("quantity or rate is missing.");
  }
  return Number(value).toFixed(8);
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot */
function verifyTransactionIdentity(intent, snapshot) {
  const actualId = Number(snapshot.id);
  if (!Number.isSafeInteger(actualId) || actualId <= 0
      || (intent.netSuiteTransactionId && actualId !== Number(intent.netSuiteTransactionId))) {throw mismatch("internal ID does not match.");}
  if (String(snapshot.externalId ?? snapshot.externalid ?? "") !== intent.externalId
      || reference(snapshot.entity) !== intent.customerId || reference(snapshot.location) !== intent.receivingLocationId) {
    throw mismatch("external ID, customer or receiving yard does not match.");
  }
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot @param {boolean} allowInactive */
function verifyHeader(intent, snapshot, allowInactive) {
  verifyTransactionIdentity(intent, snapshot);
  if (intent.sourceSalesOrderId && reference(snapshot.createdFrom ?? snapshot.createdfrom) !== intent.sourceSalesOrderId) {
    throw mismatch("source Sales Order does not match.");
  }
  if (!String(snapshot.tranId ?? snapshot.tranid ?? "").trim()) {throw mismatch("RMA number is missing.");}
  if (!allowInactive && /cancel|void|reject/i.test(String(snapshot.status?.refName ?? snapshot.status ?? ""))) {
    throw mismatch("the transaction is inactive.");
  }
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot @param {{allowInactive?: boolean}} [options] */
export function verifyReturnBatchSnapshot(intent, snapshot, { allowInactive = false } = {}) {
  verifyHeader(intent, snapshot, allowInactive);
  const actual = snapshot.item?.items;
  if (!Array.isArray(actual) || actual.length !== intent.lines.length) {throw mismatch("item rows were added, removed or merged.");}
  const palletIds = new Set(intent.lines.filter((/** @type {Record<string, any>} */ line) => line.kind === "pallet")
    .map((/** @type {Record<string, any>} */ line) => line.itemId));
  const unitIds = new Set(intent.lines.filter((/** @type {Record<string, any>} */ line) => line.salesUomId)
    .map((/** @type {Record<string, any>} */ line) => line.itemId));
  const payload = buildReturnBatchPayload(intent);
  const splitDescriptions = new Set(payload.item.items.map((/** @type {Record<string, any>} */ line) => line.description).filter(Boolean));
  const key = (/** @type {Record<string, any>} */ line) => {
    if (line.location && reference(line.location) !== intent.receivingLocationId) {throw mismatch("item receiving yard does not match.");}
    const item = reference(line.item);
    const source = splitDescriptions.has(line.description) ? line.description : Number(line.orderLine ?? line.orderline);
    return [item, palletIds.has(item) ? "" : source, exact(line.quantity), exact(line.rate),
      reference(line.custcol_atlas_rc_so ?? line.custcolAtlasRcSo), unitIds.has(item) ? reference(line.units) : ""].join("|");
  };
  const expected = payload.item.items.map(key).sort();
  const observed = actual.map(key).sort();
  if (expected.some((/** @type {string} */ value, /** @type {number} */ index) => value !== observed[index])) {
    throw mismatch("source lines, items, units, quantities, rates or reasons do not match.");
  }
  return snapshot;
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot @param {Record<string, any>[]} links */
export function hydrateReturnBatchSourceLinks(intent, snapshot, links) {
  const sourceLines = new Map(intent.lines.filter((/** @type {Record<string, any>} */ line) => line.kind === "stock")
    .map((/** @type {Record<string, any>} */ line) => [line.sourceSalesOrderLineId, line]));
  const byRow = new Map();
  const units = new Map();
  for (const link of links) {
    const source = sourceLines.get(Number(link.source_line_id));
    if (!source || byRow.has(Number(link.return_line_id))) {throw mismatch("native Sales Order line link is unexpected or ambiguous.");}
    if (!Number(link.source_units_id)) {throw mismatch("source sales units are missing.");}
    byRow.set(Number(link.return_line_id), { source, units: Number(link.source_units_id) });
    units.set(source.sourceSalesOrderLineId, Number(link.source_units_id));
  }
  const payload = buildReturnBatchPayload(intent);
  const splitRows = new Map(payload.item.items.map((/** @type {Record<string, any>} */ line, /** @type {number} */ index) => [line.description, intent.lines[index]]));
  const items = (snapshot.item?.items || []).map((/** @type {Record<string, any>} */ row) => {
    const native = byRow.get(Number(row.line));
    const split = row.description ? splitRows.get(row.description) : null;
    const expectedUnits = native?.units || units.get(split?.sourceSalesOrderLineId);
    if (expectedUnits && reference(row.units) !== expectedUnits) {throw mismatch("item units differ from the source Sales Order.");}
    return native ? { ...row, orderLine: native.source.netSuiteOrderLine } : row;
  });
  return { ...snapshot, item: { ...snapshot.item, items } };
}
