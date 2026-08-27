// @ts-check

/** @param {string} message */
function mismatch(message) {
  return Object.assign(new Error(message), {
    status: 409,
    code: "OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH",
    ambiguous: true
  });
}

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** @param {unknown} value */
function numberValue(value) {
  if (value && typeof value === "object" && Object.hasOwn(value, "value")) {
    return Number(/** @type {{value?: unknown}} */ (value).value);
  }
  return Number(value);
}

/** @param {Record<string, any>} record */
function recordItems(record) {
  if (Array.isArray(record?.item?.items)) {return record.item.items;}
  if (Array.isArray(record?.items)) {return record.items;}
  return [];
}

/** @param {Record<string, any>} item */
function receivedItem(item) {
  return item?.itemReceive !== false
    && item?.itemreceive !== false
    && Number(item?.quantity) > 0;
}

/** @param {Record<string, any>} record */
function recordSourceId(record) {
  return positiveInteger(
    record.createdFromId
      ?? record.createdfrom
      ?? record.createdFrom?.id
      ?? record.createdFrom?.value
  );
}

/** @param {Record<string, any>} record */
function recordExternalId(record) {
  return String(record.externalId ?? record.externalid ?? "").trim();
}

/** @param {Record<string, any>} record */
function recordTransactionType(record) {
  const value = String(record.transactionType ?? record.transaction_type ?? record.type ?? "")
    .trim()
    .toUpperCase();
  if (["IF", "ITEMSHIP", "ITEMFULFILLMENT"].includes(value)) {return "IF";}
  if (["IR", "ITEMRCPT", "ITEMRECEIPT"].includes(value)) {return "IR";}
  return value;
}

/** @param {Record<string, any>} step @param {Record<string, any>} record */
function assertRecordIdentity(step, record) {
  const id = positiveInteger(record?.id);
  if (!id) {throw mismatch("NetSuite returned a posting record without a valid internal ID.");}
  if (recordExternalId(record) !== String(step?.externalId || "")) {
    throw mismatch("The recovered NetSuite transaction has a different external ID.");
  }
  if (recordSourceId(record) !== Number(step?.sourceNetSuiteId)) {
    throw mismatch("The recovered NetSuite transaction belongs to a different source order.");
  }
  if (recordTransactionType(record) !== String(step?.transactionType || "")) {
    throw mismatch("The recovered NetSuite transaction has a different transaction type.");
  }
  return id;
}

/** @param {Record<string, any>[]} items @param {string} subject */
function itemsByUniqueLine(items, subject) {
  /** @type {Map<number, Record<string, any>>} */
  const indexed = new Map();
  for (const item of items) {
    const orderLine = Number(item.orderLine ?? item.orderline);
    if (!Number.isSafeInteger(orderLine) || indexed.has(orderLine)) {
      throw mismatch(`The ${subject} NetSuite transaction has ambiguous line identities.`);
    }
    indexed.set(orderLine, item);
  }
  return indexed;
}

/** @param {number} orderLine @param {Record<string, any>} expected @param {Record<string, any> | undefined} actual */
function assertMatchingLine(orderLine, expected, actual) {
  if (!actual || Math.abs(Number(actual.quantity) - Number(expected.quantity)) > 0.000001) {
    throw mismatch(`The recovered NetSuite quantity for line ${orderLine} does not match.`);
  }
  if (expected.location === null || expected.location === undefined) {return;}
  const actualLocation = actual.location === undefined || actual.location === null
    ? null
    : numberValue(actual.location);
  if (actualLocation !== Number(expected.location)) {
    throw mismatch(`The recovered NetSuite location for line ${orderLine} does not match.`);
  }
}

/**
 * A recovered record is acceptable only when it proves the same source,
 * transaction type, external identity, and exact positive line quantities.
 *
 * @param {Record<string, any>} step
 * @param {Record<string, any>} record
 */
export function verifyOperatorNetSuitePostingRecord(step, record) {
  const id = assertRecordIdentity(step, record);
  const expectedItems = /** @type {Record<string, any>[]} */ (step?.payload?.item?.items || []).filter(receivedItem);
  const actualItems = recordItems(record).filter(receivedItem);
  if (!expectedItems.length || !actualItems.length) {
    throw mismatch("The recovered NetSuite transaction has no verifiable positive lines.");
  }
  const expectedByLine = itemsByUniqueLine(expectedItems, "expected");
  const actualByLine = itemsByUniqueLine(actualItems, "recovered");
  if (expectedByLine.size !== actualByLine.size) {
    throw mismatch("The recovered NetSuite transaction contains an unexpected positive line.");
  }
  for (const [orderLine, expected] of expectedByLine) {
    assertMatchingLine(orderLine, expected, actualByLine.get(orderLine));
  }
  return {
    id,
    transactionRef: String(record.tranId ?? record.tranid ?? record.transactionRef ?? id)
  };
}
