// @ts-check

/** @param {string} message @returns {never} */
function invalid(message) {
  throw Object.assign(new Error(`${message} Refresh the PO before receiving.`), {
    code: "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED", status: 409
  });
}

/** @param {unknown} value */
function counter(value) {
  const number = Number(value);
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "" || !Number.isFinite(number) || number < 0) {
    invalid("NetSuite did not return a valid PO receipt counter.");
  }
  return number;
}

/**
 * Refresh only receipt availability. Stored identities and explicit selected
 * quantities retain their direct-posting semantics; open unselected rows must
 * stay in the durable payload so NetSuite cannot receive them by default.
 * @param {Record<string,any>[]} available @param {Record<string,any>[]} items
 */
export function refreshPoReceiptAvailability(available, items) {
  if (!Array.isArray(items) || !items.length) invalid("NetSuite returned no PO item sublist.");
  const known = new Set(available.map(line => Number(line.orderLine)));
  const current = new Map();
  for (const row of items) {
    const type = row.itemType?.id ?? row.itemType;
    if (type && !["InvtPart", "NonInvtPart"].includes(type)) continue;
    const id = Number(row.line), itemId = Number(row.item?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || current.has(id) || !Number.isSafeInteger(itemId) || itemId <= 0) {
      invalid("NetSuite returned an ambiguous PO line identity.");
    }
    const orderedQuantity = counter(row.quantity), completedQuantity = counter(row.quantityReceived);
    const remainingQuantity = row.isClosed === true ? 0 : Number(Math.max(orderedQuantity - completedQuantity, 0).toFixed(6));
    if (remainingQuantity > 0 && !known.has(id)) invalid("NetSuite has an open PO line missing from the local order.");
    current.set(id, { itemId, orderedQuantity, completedQuantity, remainingQuantity });
  }
  return available.flatMap(line => {
    const live = current.get(Number(line.orderLine));
    if (!live) return [];
    if (live.itemId !== Number(line.itemId)) invalid("The PO item no longer matches its stored line.");
    return [{ ...line, ...live }];
  });
}
