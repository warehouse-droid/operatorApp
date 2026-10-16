// @ts-check

/** @param {Record<string, any>} intent */
export function buildReturnCreditMemoPayload(intent) {
  return {
    externalId: intent.externalId, tranDate: intent.submittedDate,
    entity: { id: String(intent.customerId) }, location: { id: String(intent.receivingLocationId) },
    memo: intent.memo,
    item: { items: intent.lines.map((/** @type {Record<string, any>} */ line, /** @type {number} */ index) => ({
      item: { id: String(line.itemId) }, quantity: line.returnedSalesQuantity, rate: line.rate,
      location: { id: String(intent.receivingLocationId) },
      ...(line.salesUomId ? { units: String(line.salesUomId) } : {}),
      custcol_atlas_rc_so: { id: String(line.reasonId) },
      // A standalone CM has no native SO transform link. Preserve each source
      // row explicitly, including split reasons, for readback and audit.
      ...(line.kind === "stock" ? { description: `Return from SO ${intent.sourceSalesOrderId}; source line ${line.sourceSalesOrderLineId}; reason ${line.reasonId}; row ${index + 1}` } : {})
    })) }
  };
}

/** @param {string} message */
function mismatch(message) {
  return Object.assign(new Error(`Credit Memo verification failed: ${message}`),
    { status: 409, code: "RETURN_CM_VERIFICATION_FAILED" });
}

/** @param {any} value */
function ref(value) { return Number(value?.id ?? value); }

/** @param {any} value */
function exact(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) {
    throw mismatch("quantity or rate is missing.");
  }
  return Number(value).toFixed(8);
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot */
function verifyIdentity(intent, snapshot) {
  const id = Number(snapshot.id);
  if (!Number.isSafeInteger(id) || id <= 0 || (intent.netSuiteTransactionId && id !== Number(intent.netSuiteTransactionId))) {
    throw mismatch("internal ID does not match.");
  }
  if (String(snapshot.externalId ?? snapshot.externalid ?? "") !== intent.externalId
      || ref(snapshot.entity) !== intent.customerId || ref(snapshot.location) !== intent.receivingLocationId) {
    throw mismatch("external ID, customer or receiving yard does not match.");
  }
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot @param {boolean} allowInactive */
function verifyHeader(intent, snapshot, allowInactive) {
  verifyIdentity(intent, snapshot);
  if (snapshot.createdFrom || snapshot.createdfrom) { throw mismatch("standalone Credit Memo has an unexpected source transaction."); }
  if (!String(snapshot.tranId ?? snapshot.tranid ?? "").trim()) { throw mismatch("Credit Memo number is missing."); }
  if (!allowInactive && /cancel|void|reject/i.test(String(snapshot.status?.refName ?? snapshot.status ?? ""))) {
    throw mismatch("the transaction is inactive.");
  }
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot @param {{allowInactive?: boolean}} [options] */
export function verifyReturnCreditMemoSnapshot(intent, snapshot, { allowInactive = false } = {}) {
  verifyHeader(intent, snapshot, allowInactive);
  const actual = snapshot.item?.items;
  if (!Array.isArray(actual) || !intent.lines.length || actual.length !== intent.lines.length) {
    throw mismatch("item rows were added, removed or merged.");
  }
  const stockItems = new Set(intent.lines.filter((/** @type {Record<string, any>} */ line) => line.kind === "stock")
    .map((/** @type {Record<string, any>} */ line) => line.itemId));
  const unitItems = new Set(intent.lines.filter((/** @type {Record<string, any>} */ line) => line.salesUomId)
    .map((/** @type {Record<string, any>} */ line) => line.itemId));
  const key = (/** @type {Record<string, any>} */ line) => {
    if (line.location && ref(line.location) !== intent.receivingLocationId) { throw mismatch("item receiving yard does not match."); }
    const item = ref(line.item);
    return [item, stockItems.has(item) ? line.description : "", exact(line.quantity), exact(line.rate),
      ref(line.custcol_atlas_rc_so ?? line.custcolAtlasRcSo), unitItems.has(item) ? ref(line.units) : ""].join("|");
  };
  const expected = buildReturnCreditMemoPayload(intent).item.items.map(key).sort();
  const observed = actual.map(key).sort();
  if (expected.some((/** @type {string} */ value, /** @type {number} */ index) => value !== observed[index])) {
    throw mismatch("source lines, items, units, quantities, rates or reasons do not match.");
  }
  return snapshot;
}
