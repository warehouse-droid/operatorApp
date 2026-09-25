// @ts-check
import { isDeepStrictEqual } from 'node:util';

const EPSILON = 0.000001;
const PHYSICAL_TYPES = new Set(['InvtPart', 'NonInvtPart']);
/** @param {string} message */
export function operatorKitError(message) {
  return Object.assign(new Error(`${message} Refresh the order before posting; kit components must form complete kits.`), {
    code: 'OPERATOR_NETSUITE_POSTING_KIT_INVALID', status: 409, postingNotAttempted: true
  });
}
/** @param {unknown} value */
function id(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) { throw operatorKitError('A kit source identity is missing or invalid.'); }
  return number;
}
/** @param {unknown} value */
function quantity(value) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number) || number < 0) {
    throw operatorKitError('A kit quantity is missing or invalid.');
  }
  return number;
}
/** @param {unknown} value */
const falseFlag = value => value === false || value === 'F';
/** @param {any} row */
const parentLine = row => row.kitmemberof === undefined || row.kitmemberof === null || row.kitmemberof === ''
  ? null : id(row.kitmemberof);
/** @param {any} row */
const rowQuantity = row => quantity(Math.abs(Number(row.quantity)));
/** @param {any} row */
const rowCompleted = row => quantity(Math.abs(Number(row.quantityshiprecv ?? 0)));
/** @param {any[]} values @param {(value: any) => any} key */
function uniqueIndex(values, key) {
  const result = new Map();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) { throw operatorKitError('NetSuite returned duplicate kit source identities.'); }
    result.set(identity, value);
  }
  return result;
}
/** @param {any} row @param {any} item */
function availableLine(row, item) {
  if (!item || id(item.item?.id) !== id(row.item) || String(id(item.lineUniqueKey)) !== String(id(row.uniquekey))) {
    throw operatorKitError('A source line does not match the current NetSuite REST sublist.');
  }
  const location = id(item.location?.id);
  if (location !== id(row.location)) { throw operatorKitError('The source inventory location changed.'); }
  const orderedQuantity = quantity(item.quantity);
  const completedQuantity = Math.max(quantity(item.quantityFulfilled ?? 0), rowCompleted(row));
  return { orderLine: id(row.id), sourceLineKey: String(id(row.uniquekey)), itemId: id(row.item), location,
    orderedQuantity, completedQuantity, remainingQuantity: item.isClosed === true ? 0 : Math.max(0, orderedQuantity - completedQuantity) };
}
/** @param {any} row */
function supportedMember(row) {
  if (!PHYSICAL_TYPES.has(row.itemtype)) { throw operatorKitError('Nested kits and this member item type are unsupported.'); }
  if (row.itemtype === 'InvtPart' && ![row.usebins, row.islotitem, row.isserialitem].every(falseFlag)) {
    throw operatorKitError('Kit members requiring bin, lot or serial inventory details are unsupported.');
  }
}
/** @param {any} parent @param {any} row @param {any} member */
function kitMember(parent, row, member) {
  supportedMember(row);
  const quantityPerKit = quantity(member.quantity);
  if (quantityPerKit <= 0 || member.dropShipMember === true) { throw operatorKitError('A kit member has an unsupported quantity or drop-ship allocation.'); }
  if (id(row.location) !== parent.location) { throw operatorKitError('All kit components must use the parent inventory location.'); }
  if (Math.abs(rowQuantity(row) - parent.orderedQuantity * quantityPerKit) > EPSILON) {
    throw operatorKitError('The current kit definition no longer matches the sales order component quantities.');
  }
  return { sourceLineKey: String(id(row.uniquekey)), orderLine: id(row.id), itemId: id(row.item),
    location: parent.location, orderedQuantity: rowQuantity(row), quantityPerKit };
}
/** @param {any} parent @param {any[]} rows @param {any} definition */
function kitGroup(parent, rows, definition) {
  if (definition?.isFulfillable !== true || !Array.isArray(definition.member?.items) || !definition.member.items.length) {
    throw operatorKitError('NetSuite did not return a fulfillable kit with its member definition.');
  }
  const byItem = uniqueIndex(rows, row => id(row.item));
  const definitions = uniqueIndex(definition.member.items, member => id(member.item?.id));
  if (byItem.size !== definitions.size) { throw operatorKitError('Kit membership changed or component lines are missing.'); }
  const members = [...definitions].map(([itemId, member]) => {
    const row = byItem.get(itemId);
    if (!row) { throw operatorKitError('A kit definition member has no exact sales order component line.'); }
    return kitMember(parent, row, member);
  }).sort((a, b) => a.orderLine - b.orderLine);
  return { parent: { orderLine: parent.orderLine, sourceLineKey: parent.sourceLineKey, itemId: parent.itemId,
    location: parent.location, orderedQuantity: parent.orderedQuantity }, members };
}

/** Resolve only exact, single-level kit relationships; names are never identities.
 * @param {{sourceItems: any[], sourceRows: any[], kitDefinitions: any[]}} evidence */
export function normalizeOperatorKitSource({ sourceItems, sourceRows, kitDefinitions }) {
  const rest = uniqueIndex(sourceItems, item => id(item.line));
  const rows = uniqueIndex(sourceRows, row => id(row.id));
  for (const orderLine of rest.keys()) {
    if (!rows.has(orderLine)) { throw operatorKitError('A REST source line is missing its stable SuiteQL identity.'); }
  }
  uniqueIndex(sourceRows, row => id(row.uniquekey));
  const definitions = uniqueIndex(kitDefinitions, item => id(item.id));
  const parents = sourceRows.filter(row => !parentLine(row) && (PHYSICAL_TYPES.has(row.itemtype) || row.itemtype === 'Kit'));
  const availableLines = parents.map(row => availableLine(row, rest.get(id(row.id)))).sort((a, b) => a.orderLine - b.orderLine);
  for (const row of sourceRows.filter(entry => parentLine(entry))) {
    if (rows.get(parentLine(row))?.itemtype !== 'Kit' || rest.has(id(row.id)) || row.itemtype === 'Kit') {
      throw operatorKitError('The kit hierarchy is missing, nested or ambiguous.');
    }
  }
  const kitGroups = parents.filter(row => row.itemtype === 'Kit').map(row => {
    const parent = /** @type {any} */ (availableLines.find(line => line.orderLine === id(row.id)));
    if (Math.abs(rowQuantity(row) - parent.orderedQuantity) > EPSILON) { throw operatorKitError('The source reads disagree about the kit parent quantity.'); }
    const children = sourceRows.filter(child => parentLine(child) === id(row.id));
    const group = kitGroup(parent, children, definitions.get(id(row.item)));
    // Component progress can reveal an earlier fulfillment even if the parent read lags.
    for (const member of group.members) {
      const remaining = Math.max(0, member.orderedQuantity - rowCompleted(rows.get(member.orderLine))) / member.quantityPerKit;
      parent.remainingQuantity = Math.min(parent.remainingQuantity, remaining);
    }
    return group;
  }).sort((a, b) => a.parent.orderLine - b.parent.orderLine);
  if (!kitGroups.length) { throw operatorKitError('The expected kit is no longer present on the sales order.'); }
  return { availableLines, kitGroups };
}

/** @param {any} selected @param {any} source */
function assertPhysicalIdentity(selected, source) {
  if (!source || id(selected.itemId) !== source.itemId || id(selected.location) !== source.location || quantity(selected.quantity) <= 0) {
    throw operatorKitError('A selected component item, quantity or location does not match its source.');
  }
}
/** @param {any} group @param {Map<string, any>} selected @param {any} available */
function selectedKit(group, selected, available) {
  const physicalLines = /** @type {any[]} */ (group.members.map((/** @type {any} */ member) => {
    const line = selected.get(member.sourceLineKey);
    assertPhysicalIdentity(line || {}, member);
    return { ...line };
  }));
  const counts = physicalLines.map((line, index) => line.quantity / group.members[index].quantityPerKit);
  const count = Math.round(/** @type {number} */ (counts[0]));
  if (count <= 0 || counts.some(value => Math.abs(value - count) > EPSILON)) {
    throw operatorKitError('The selected components do not represent the same whole-kit count.');
  }
  if (count > available.remainingQuantity + EPSILON) { throw operatorKitError('The kit quantity exceeds the remaining NetSuite quantity.'); }
  return { orderLine: group.parent.orderLine, sourceLineKey: group.parent.sourceLineKey, quantity: count,
    location: group.parent.location, localOrderKey: physicalLines[0].localOrderKey, localLineId: `kit:${group.parent.sourceLineKey}`,
    kit: { version: 1, definition: group, physicalLines } };
}

/** @param {{availableLines: any[], kitGroups: any[]}} source @param {any[]} physicalLines */
export function mapOperatorKitSelections(source, physicalLines) {
  const selected = uniqueIndex(physicalLines, line => String(id(line.sourceLineKey)));
  const memberKeys = new Set(source.kitGroups.flatMap(group => group.members.map((/** @type {any} */ member) => member.sourceLineKey)));
  const parentKeys = new Set(source.kitGroups.map(group => group.parent.sourceLineKey));
  const ordinary = physicalLines.filter(line => !memberKeys.has(String(line.sourceLineKey))).map(line => {
    if (parentKeys.has(String(line.sourceLineKey))) { throw operatorKitError('Confirm physical kit components rather than the kit parent.'); }
    const available = source.availableLines.find(entry => entry.sourceLineKey === String(line.sourceLineKey));
    assertPhysicalIdentity(line, available);
    if (line.quantity > available.remainingQuantity + EPSILON) { throw operatorKitError('The selected quantity exceeds the remaining source quantity.'); }
    return { ...line, orderLine: available.orderLine };
  });
  const kits = source.kitGroups.filter(group => group.members.some((/** @type {any} */ member) => selected.has(member.sourceLineKey)))
    .map(group => selectedKit(group, selected, source.availableLines.find(line => line.orderLine === group.parent.orderLine)));
  return [...ordinary, ...kits].sort((a, b) => a.orderLine - b.orderLine);
}

/** @param {any} step */
export function operatorStepHasKits(step) {
  return (step.lineSnapshot || []).some((/** @type {any} */ line) => line.kit);
}

/** @param {any} snapshot @param {any} item @param {any} source @param {any} available */
function assertCurrentSnapshot(snapshot, item, source, available) {
  if (snapshot.sourceLineKey !== available.sourceLineKey) { throw operatorKitError('A source line identity changed before posting.'); }
  if (snapshot.itemId && snapshot.itemId !== available.itemId) { throw operatorKitError('A selected item changed before posting.'); }
  if (!snapshot.kit) { return; }
  const group = source.kitGroups.find((/** @type {any} */ entry) => entry.parent.orderLine === item.orderLine);
  if (!isDeepStrictEqual(group, snapshot.kit.definition)) { throw operatorKitError('The kit definition or component mapping changed before posting.'); }
  const remapped = mapOperatorKitSelections(source, snapshot.kit.physicalLines);
  if (remapped.length !== 1 || remapped[0].orderLine !== item.orderLine || remapped[0].quantity !== snapshot.quantity) {
    throw operatorKitError('The saved physical components no longer match the kit quantity.');
  }
}

/** Revalidate only selected parents (also used for an individual location part).
 * @param {any} step @param {{availableLines: any[], kitGroups: any[]}} source */
export function assertOperatorKitStepCurrent(step, source) {
  for (const item of (step.payload.item.items || []).filter((/** @type {any} */ line) => line.itemReceive !== false && line.quantity > 0)) {
    const snapshots = (step.lineSnapshot || []).filter((/** @type {any} */ line) => line.orderLine === item.orderLine);
    const available = source.availableLines.find(line => line.orderLine === item.orderLine);
    if (!available || item.location !== available.location || item.quantity > available.remainingQuantity + EPSILON) {
      throw operatorKitError('The source location or remaining quantity changed before posting.');
    }
    for (const snapshot of snapshots) {
      assertCurrentSnapshot(snapshot, item, source, available);
    }
  }
}
