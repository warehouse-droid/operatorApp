// @ts-check
import { returnRestockingRow } from './return-accounting.js';

/** @param {Record<string, any>} intent */
export function buildReturnCreditMemoPayload(intent) {
  return {
    externalId: intent.externalId, tranDate: intent.submittedDate,
    entity: { id: String(intent.customerId) }, location: { id: String(intent.receivingLocationId) },
    memo: intent.memo,
    ...(Number(intent.version) >= 4 && intent.sourceSalesOrderRef ? { otherRefNum: intent.sourceSalesOrderRef } : {}),
    item: { items: intent.lines.flatMap((/** @type {Record<string, any>} */ line, /** @type {number} */ index) => {
      const fee = returnRestockingRow(intent, line, index);
      return [{
      item: { id: String(line.itemId) }, quantity: line.returnedSalesQuantity, rate: line.rate,
      ...(Number(intent.version) >= 4 && line.kind === 'stock' ? { price: { id: '-1' } } : {}),
      location: { id: String(line.locationId || intent.receivingLocationId) },
      ...(line.salesUomId ? { units: String(line.salesUomId) } : {}),
      custcol_atlas_rc_so: { id: String(line.reasonId) },
      // New CMs let NetSuite source its item description. Source rows remain
      // in the immutable app intent; older submissions keep their audit text.
      ...(line.kind === "stock" && !(Number(intent.version) >= 5) ? { description: `Return from SO ${intent.sourceSalesOrderId}; source line ${line.sourceSalesOrderLineId}; reason ${line.reasonId}; row ${index + 1}` } : {})
    }, ...(fee ? [fee] : [])]; }) }
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
  if (Number(intent.version) >= 4) { verifyRequestedFields(intent, snapshot); }
  if (snapshot.createdFrom || snapshot.createdfrom) { throw mismatch("standalone Credit Memo has an unexpected source transaction."); }
  if (!String(snapshot.tranId ?? snapshot.tranid ?? "").trim()) { throw mismatch("Credit Memo number is missing."); }
  if (!allowInactive && /cancel|void|reject/i.test(String(snapshot.status?.refName ?? snapshot.status ?? ""))) {
    throw mismatch("the transaction is inactive.");
  }
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot */
function verifyRequestedFields(intent, snapshot) {
  if (String(snapshot.memo || '') !== intent.memo) { throw mismatch('operator memo does not match.'); }
  const reference = String(snapshot.otherRefNum ?? snapshot.otherrefnum ?? '');
  if (intent.sourceSalesOrderRef && reference !== intent.sourceSalesOrderRef) { throw mismatch('Sales Order reference does not match.'); }
}

/** @param {Record<string, any>} intent @param {Record<string, any>} line */
function locationKey(intent, line) {
  if (Number(intent.version) >= 4) { return ref(line.location); }
  if (line.location && ref(line.location) !== intent.receivingLocationId) { throw mismatch('item receiving yard does not match.'); }
  return '';
}

/** @param {Record<string, any>} line @param {boolean} fee */
function quantityKey(line, fee) {
  if (!fee) { return exact(line.quantity); }
  if (line.quantity !== null && line.quantity !== undefined) { throw mismatch('Restocking Fee must be a discount row.'); }
  return '';
}

/** @param {any} value */
function finiteAmount(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

/** @param {Record<string, any>} line @param {number} itemId */
function isDiscountAdjustment(line, itemId) {
  return Number.isSafeInteger(itemId) && itemId > 0 && finiteAmount(line.rate)
    && Number(line.rate) <= 0 && Number(line.amount) <= 0;
}

/** @param {Record<string, any>} line @param {Set<number>} materialIds */
function isAccountingAdjustment(line, materialIds) {
  const itemId = ref(line.item);
  if (materialIds.has(itemId) || (line.quantity !== null && line.quantity !== undefined) || !finiteAmount(line.amount)) { return false; }
  const type = line.itemType?.id ?? line.itemType;
  if (type === "Subtotal") { return itemId === -2 && Number(line.amount) >= 0; }
  return type === "Discount" && isDiscountAdjustment(line, itemId);
}

/** @param {Record<string, any>} intent @param {Record<string, any>} snapshot @param {{allowInactive?: boolean, allowAccountingAdjustments?: boolean}} [options] */
export function verifyReturnCreditMemoSnapshot(intent, snapshot, { allowInactive = false, allowAccountingAdjustments = false } = {}) {
  verifyHeader(intent, snapshot, allowInactive);
  const payload = buildReturnCreditMemoPayload(intent).item.items;
  const materialIds = new Set(payload.map((/** @type {Record<string, any>} */ line) => ref(line.item)));
  const rows = snapshot.item?.items;
  // Accounting may add a subtotal/restocking discount after a CM was verified.
  // The caller must establish that history; creation and manual links stay exact.
  const actual = allowAccountingAdjustments === true && Array.isArray(rows)
    ? rows.filter((/** @type {Record<string, any>} */ line) => !isAccountingAdjustment(line, materialIds)) : rows;
  if (!Array.isArray(actual) || !intent.lines.length || actual.length !== payload.length) {
    throw mismatch("item rows were added, removed or merged.");
  }
  const stockItems = new Set(intent.lines.filter((/** @type {Record<string, any>} */ line) => line.kind === "stock")
    .map((/** @type {Record<string, any>} */ line) => line.itemId));
  const unitItems = new Set(intent.lines.filter((/** @type {Record<string, any>} */ line) => line.salesUomId)
    .map((/** @type {Record<string, any>} */ line) => line.itemId));
  const key = (/** @type {Record<string, any>} */ line) => {
    const item = ref(line.item);
    const fee = item === intent.restockingFee?.itemId;
    return [item, !(Number(intent.version) >= 5) && (stockItems.has(item) || fee) ? line.description : "", quantityKey(line, fee), exact(line.rate),
      ref(line.custcol_atlas_rc_so ?? line.custcolAtlasRcSo), unitItems.has(item) ? ref(line.units) : "",
      locationKey(intent, line)].join("|");
  };
  const expected = payload.map(key);
  const observed = actual.map(key);
  if (!(Number(intent.version) >= 4)) { expected.sort(); observed.sort(); }
  if (expected.some((/** @type {string} */ value, /** @type {number} */ index) => value !== observed[index])) {
    throw mismatch("source lines, items, units, quantities, rates or reasons do not match.");
  }
  return snapshot;
}
