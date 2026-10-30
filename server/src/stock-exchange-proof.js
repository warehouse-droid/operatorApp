import { inventoryError } from './inventory-workflow-domain.js';
import { completeExchangeLines } from './stock-exchange-netsuite.js';

export function exchangeLineSnapshot(line) {
  return { line: Number(line.line), item: String(line.item?.id), quantity: Number(line.adjustQtyBy),
    units: String(line.units), reason: String(line.custcol_atlas_rc_so?.id || ''), so: String(line.custcol_position || '') };
}
function same(left, right, includeLine = true) {
  return Object.keys(left).filter(key => includeLine || key !== 'line').every(key => left[key] === right[key]);
}
export function verifyExchangeTransfer(record, intent, destination) {
  if (!record || Number(record.location?.id) !== destination.sourceId
      || Number(record.transferLocation?.id) !== destination.destinationId
      || record.memo !== intent.memo || record.tranDate?.slice(0,7) !== intent.month)
    {throw inventoryError('Inventory Transfer locations, date or memo differ from this exchange month.', 409);}
  const lines = completeExchangeLines(record);
  const ids = lines.map(line => Number(line.line));
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length)
    {throw inventoryError('Inventory Transfer line identities are incomplete or duplicated.', 409);}
}
export function exchangeProof(record) {
  return { transferId: record ? Number(record.id) : null,
    before: record ? completeExchangeLines(record).map(exchangeLineSnapshot) : [] };
}
export function confirmedExchangeLines(record, intent, proof) {
  if (!proof) {return null;}
  if (proof.transferId ? Number(record.id) !== proof.transferId : record.externalId !== intent.externalId)
    {throw inventoryError('The exchange Inventory Transfer identity differs from its posting attempt.', 409);}
  const before = new Map(proof.before.map(line => [line.line, line]));
  const added = [];
  for (const line of completeExchangeLines(record).map(exchangeLineSnapshot)) {
    if (before.has(line.line)) {
      if (!same(before.get(line.line), line)) {throw inventoryError('An existing Inventory Transfer line changed during posting.', 409);}
      before.delete(line.line);
    } else {added.push(line);}
  }
  if (before.size) {throw inventoryError('An existing Inventory Transfer line is missing after posting.', 409);}
  if (!added.length) {return null;}
  const expected = intent.lines.map(exchangeLineSnapshot);
  if (added.length !== expected.length) {throw inventoryError('NetSuite has not confirmed the exact exchange lines.', 409);}
  const unmatched = [...added];
  for (const line of expected) {
    const index = unmatched.findIndex(candidate => same(line, candidate, false));
    if (index < 0) {throw inventoryError('The posted exchange quantity, unit, reason or SO Position differs.', 409);}
    unmatched.splice(index, 1);
  }
  return added;
}
