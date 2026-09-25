// @ts-check

/** @param {Record<string, any>} policy @param {number} [version] */
export function confirmedReturnPolicy(policy, version = 2) {
  if (version < 2 || policy.effective !== "APPROVAL_REQUIRED") {return { ...policy };}
  return { ...policy, effective: "ALLOWED", requiresApproval: false };
}

/** @param {Record<string, any>} record */
export function palletAuthorizationLine(record) {
  return { itemId: record.palletItemId, returnedSalesQuantity: record.palletQuantity,
    rate: 40, reasonId: 10 };
}

/** @param {Record<string, any>} record */
export function buildPalletReturnAuthorizationPayload(record) {
  return {
    externalId: record.externalId,
    tranDate: record.submittedDate,
    entity: { id: String(record.customerId) },
    location: { id: String(record.receivingLocationId) },
    memo: record.memo,
    item: { items: [{ item: { id: String(record.palletItemId) },
      quantity: Number(record.palletQuantity), rate: 40, custcol_atlas_rc_so: { id: "10" } }] }
  };
}

/** @param {string} message */
function verificationError(message) {
  return Object.assign(new Error(`Return Authorization verification failed: ${message}`),
    { status: 409, code: "RETURN_RA_VERIFICATION_FAILED" });
}

/** @param {any} value */
function referenceId(value) { return Number(value?.id ?? value); }

/** @param {any} value */
function exactNumber(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) {
    throw verificationError("an item quantity or rate is missing.");
  }
  return Number(value).toFixed(8);
}

/** @param {Record<string, any>} line @param {boolean} stock */
function lineKey(line, stock) {
  return [referenceId(line.item), stock ? Number(line.orderLine ?? line.orderline) : "",
    exactNumber(line.quantity), exactNumber(line.rate),
    referenceId(line.custcol_atlas_rc_so ?? line.custcolAtlasRcSo)].join("|");
}

/** @param {Record<string, any>} record @param {Record<string, any>} snapshot */
function verifyTransactionIdentity(record, snapshot) {
  const id = Number(snapshot.id);
  if (!Number.isSafeInteger(id) || id <= 0) {throw verificationError("internal ID is missing.");}
  const expectedId = record.netsuiteTransactionId || record.netSuiteTransactionId;
  if (expectedId && id !== Number(expectedId)) {throw verificationError("internal ID does not match.");}
  if (String(snapshot.externalId ?? snapshot.externalid ?? "") !== record.externalId) {
    throw verificationError("external ID does not match.");
  }
}

/** @param {Record<string, any>} record @param {Record<string, any>} snapshot @param {boolean} allowInactive */
function verifyHeader(record, snapshot, allowInactive) {
  verifyTransactionIdentity(record, snapshot);
  if (referenceId(snapshot.entity) !== Number(record.customerId)
      || referenceId(snapshot.location) !== Number(record.receivingLocationId)) {
    throw verificationError("customer or receiving yard does not match.");
  }
  if (record.recordType === "stock"
      && referenceId(snapshot.createdFrom ?? snapshot.createdfrom) !== Number(record.sourceSalesOrderId)) {
    throw verificationError("source Sales Order does not match.");
  }
  if (!allowInactive && /cancel|void|reject/i.test(String(snapshot.status?.refName ?? snapshot.status ?? ""))) {
    throw verificationError("the transaction is inactive.");
  }
}

/** @param {Record<string, any>} record @param {Record<string, any>} snapshot @param {{allowInactive?: boolean}} [options] */
export function verifyReturnAuthorizationSnapshot(record, snapshot, { allowInactive = false } = {}) {
  verifyHeader(record, snapshot, allowInactive);
  const stock = record.recordType === "stock";
  const expectedLines = stock ? record.lines : [palletAuthorizationLine(record)];
  const actual = snapshot.item?.items;
  if (!Array.isArray(actual) || !expectedLines.length || actual.length !== expectedLines.length) {
    throw verificationError("item rows were added, removed or merged.");
  }
  /** @type {Record<string, any>[]} */
  const intent = expectedLines.map((/** @type {Record<string, any>} */ line) => ({
    item: line.itemId, orderLine: line.netSuiteOrderLine, quantity: line.returnedSalesQuantity,
    rate: line.rate, custcol_atlas_rc_so: line.reasonId, units: line.salesUomId
  }));
  const unitsRequired = new Set(intent.filter(line => line.units).map(line => lineKey(line, stock)));
  const keyWithUnits = (/** @type {Record<string, any>} */ line) => {
    const key = lineKey(line, stock);
    return `${key}|${unitsRequired.has(key) ? referenceId(line.units) : ""}`;
  };
  const expected = intent.map(keyWithUnits).sort();
  const observed = actual.map(keyWithUnits).sort();
  if (expected.some((/** @type {string} */ key, /** @type {number} */ index) => key !== observed[index])) {
    throw verificationError("source lines, items, units, quantities, rates or reasons do not match.");
  }
  return snapshot;
}

/** @param {Record<string, any>} record @param {Record<string, any>[]} credits @param {number[]} observedIds */
export function remainingPalletReservation(record, credits, observedIds) {
  const observed = new Set(observedIds.map(Number));
  const seen = new Map();
  for (const credit of credits) {
    if (Number(credit.returnAuthorizationId) !== Number(record.netSuiteTransactionId)
        || !observed.has(Number(credit.transactionId))) {continue;}
    const quantity = Number(credit.quantity);
    if (Number.isFinite(quantity) && quantity > 0) {
      seen.set(Number(credit.transactionId), Math.max(seen.get(Number(credit.transactionId)) || 0, quantity));
    }
  }
  const credited = [...seen.values()].reduce((total, quantity) => total + quantity, 0);
  return Math.max(0, Number(record.palletQuantity) - credited);
}
