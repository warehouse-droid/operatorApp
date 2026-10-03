import { isDeepStrictEqual } from 'node:util';
import { regularError } from './regular-stock-domain.js';
import { STOCK_REQUEST_YARDS } from './stock-request-domain.js';
const conflict = message => regularError(message, 'REGULAR_SO_MISMATCH');
const stockTypes = new Set(['InvtPart', 'Assembly', 'Kit']);
const nonStockTypes = new Set(['NonInvtPart', 'OthCharge', 'Service', 'Discount', 'Subtotal', 'Markup']);
const id = value => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw conflict('NetSuite returned an invalid record identity.');
  return result;
};

function kitParent(row) {
  if (row.kit_member_of == null || row.kit_member_of === '' || Number(row.kit_member_of) === 0) return null;
  return id(row.kit_member_of);
}

function visibleRows(rows, remoteLines) {
  const entries = rows.map(row => ({row, parent:kitParent(row)}));
  if (new Set(rows.map(row => id(row.rest_line_id))).size !== rows.length
      || new Set(rows.map(row => id(row.line_id))).size !== rows.length) throw conflict('The SO has duplicate line identities.');
  const visible = entries.filter(entry => entry.parent === null).map(entry => entry.row);
  const parents = new Map(visible.map(row => [Number(row.rest_line_id), row]));
  for (const {row, parent} of entries.filter(entry => entry.parent !== null)) {
    if (parents.get(parent)?.item_type !== 'Kit' || row.item_type === 'Kit'
        || (!stockTypes.has(row.item_type) && !nonStockTypes.has(row.item_type))
        || remoteLines.some(line => Number(line.line) === Number(row.rest_line_id))) {
      throw conflict('The SO kit component identities are incomplete or inconsistent.');
    }
  }
  if (remoteLines.length !== visible.length) throw conflict('A complete SO line snapshot is required.');
  return visible;
}

function componentSnapshot(row, local, parent) {
  const quantity = row.quantity == null ? NaN : Math.abs(Number(row.quantity));
  const backorder = row.backordered_quantity == null || row.backordered_quantity === '' ? null : Number(row.backordered_quantity);
  const fulfilled = Number(row.fulfilled_quantity), billed = Number(row.billed_quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000
      || (backorder !== null && (!Number.isFinite(backorder) || backorder < 0 || backorder > quantity))
      || !Number.isFinite(fulfilled) || fulfilled < 0 || !Number.isFinite(billed) || billed < 0
      || ![true,false,'T','F'].includes(row.line_closed)
      || Number(row.location_id) !== Number(parent.location_id)) {
    throw conflict('The SO kit component quantities or locations are inconsistent.');
  }
  return {remoteLineId:id(row.line_id), restLineId:id(row.rest_line_id), itemId:id(row.item_id), itemType:row.item_type,
    quantity, backorderedQuantity:backorder, uom:row.stock_unit || null, locationId:local(row.location_id),
    remoteLocationId:Number(row.location_id), fulfilledQuantity:fulfilled, billedQuantity:billed,
    closed:[true,'T'].includes(row.line_closed)};
}

export function regularStockKitComponentsMatch(original, current, {ignoreLocation = false} = {}) {
  const components = line => (line.kitComponents || []).map(component => ignoreLocation
    ? {...component, locationId:null, remoteLocationId:null} : component);
  return isDeepStrictEqual(components(original), components(current));
}

export async function readRegularSalesOrder(reference, { queryAll, rest, resolveYards }) {
  const ref = String(reference || '').trim();
  if (!ref || ref.length > 80 || /[\u0000-\u001f]/u.test(ref)) throw conflict('Enter a valid SO number.');
  const literal = ref.replaceAll("'", "''");
  const rows = await queryAll(`SELECT t.id,t.tranid,main_tl.location AS order_location_id,t.entity AS customer_id,t.status,
    tl.uniquekey AS line_id,tl.id AS rest_line_id,tl.kitmemberof AS kit_member_of,tl.item AS item_id,BUILTIN.DF(tl.item) AS item_name,
    tl.quantity,tl.quantitybackordered AS backordered_quantity,BUILTIN.DF(i.stockunit) AS stock_unit,i.itemtype AS item_type,tl.location AS location_id,
    NVL(tl.quantityshiprecv,0) AS fulfilled_quantity,NVL(tl.quantitybilled,0) AS billed_quantity,tl.isclosed AS line_closed
    FROM transaction t JOIN transactionline tl ON tl.transaction=t.id LEFT JOIN item i ON i.id=tl.item
    JOIN transactionline main_tl ON main_tl.transaction=t.id AND main_tl.mainline='T'
    WHERE t.type='SalesOrd' AND UPPER(t.tranid)=UPPER('${literal}') AND tl.mainline='F' AND tl.taxline='F'
    ORDER BY tl.uniquekey`);
  if (!rows.length || new Set(rows.map(row => Number(row.id))).size !== 1) throw conflict('A unique SO with item lines was not found.');
  const orderId = id(rows[0].id);
  const record = (await rest(`/record/v1/salesOrder/${orderId}?expandSubResources=true`)).data;
  const remoteLines = record?.item?.items;
  if (!Array.isArray(remoteLines) || rows.length > 500) throw conflict('A complete SO line snapshot is required.');
  const visible = visibleRows(rows, remoteLines);
  const yards = await resolveYards(STOCK_REQUEST_YARDS.map(yard => ({ locationId: yard.locationId, code: yard.yardCode })));
  const local = value => Number(yards.find(yard => Number(yard.netsuiteLocationId) === Number(value))?.localLocationId || value);
  if (Number(record.location?.id) !== Number(rows[0].order_location_id) || Number(record.entity?.id) !== Number(rows[0].customer_id)) throw conflict('The SO changed while its header was read.');
  const lines = visible.map(row => {
    const matches = remoteLines.filter(line => Number(line.line) === Number(row.rest_line_id));
    if (matches.length !== 1 || Number(matches[0].item?.id) !== Number(row.item_id)
        || (matches[0].lineUniqueKey != null && Number(matches[0].lineUniqueKey) !== Number(row.line_id))) throw conflict('The SO line identities are inconsistent.');
    const line = matches[0];
    if(Number(line.location?.id||0)!==Number(row.location_id||0))throw conflict('The SO line location changed while it was read.');
    const itemType = Number(row.item_id) === -2 ? 'Subtotal' : row.item_type;
    if (!stockTypes.has(itemType) && !nonStockTypes.has(itemType)) throw conflict('NetSuite returned an unsupported SO item type. Review the item before linking this order.');
    const ancillary = nonStockTypes.has(itemType) || /^PALLET$/i.test(String(row.item_name));
    const kitComponents = itemType === 'Kit' ? rows.filter(component => kitParent(component) === Number(row.rest_line_id))
      .map(component => componentSnapshot(component, local, row)).sort((a,b) => a.restLineId-b.restLineId) : undefined;
    if (itemType === 'Kit' && !kitComponents.length) throw conflict('The SO kit component snapshot is missing.');
    return { remoteLineId: id(row.line_id), restLineId: Number(row.rest_line_id), itemId: Number(row.item_id) === -2 ? -2 : id(row.item_id), itemName: row.item_name, itemType,
      quantity: ancillary && row.quantity == null ? null : Math.abs(Number(row.quantity)),
      backorderedQuantity: row.backordered_quantity == null || row.backordered_quantity === '' ? null : Number(row.backordered_quantity),
      restQuantity: ancillary && line.quantity == null ? null : Number(line.quantity), uom: row.stock_unit,
      locationId: local(row.location_id || 0), remoteLocationId: Number(row.location_id || 0), ancillary,
      physicalPallet: /^PALLET$/i.test(String(row.item_name)), discount: row.item_type === 'Discount',
      ...(kitComponents ? {kitComponents} : {}),
      rate: line.rate ?? null, open: ['A','B'].includes(row.status) && Number(row.fulfilled_quantity) === 0 && Number(row.billed_quantity) === 0 && [false,'F'].includes(row.line_closed) };
  });
  if (new Set(lines.map(line => line.remoteLineId)).size !== lines.length) throw conflict('The SO has duplicate line identities.');
  return { id: orderId, ref: rows[0].tranid, customerId: id(rows[0].customer_id), locationId: local(rows[0].order_location_id),
    remoteLocationId: Number(rows[0].order_location_id), yards, lines };
}

export async function applyRegularSalesOrderLocation({ order, plan }, boundary) {
  const fresh = await readRegularSalesOrder(order.ref, boundary);
  if (fresh.lines.length !== order.lines.length || fresh.id !== order.id || fresh.customerId !== order.customerId || fresh.locationId !== order.locationId) throw conflict('The SO header changed after it was linked.');
  const target = Number(fresh.yards.find(yard => Number(yard.localLocationId) === Number(plan.sourceLocationId))?.netsuiteLocationId);
  if (!target) throw conflict('The approved source yard has no NetSuite mapping.');
  const selected = new Set([...plan.materialLineIds,
    ...fresh.lines.filter(line => line.ancillary).map(line => line.remoteLineId)]);
  const pending = [];
  for (const original of order.lines.filter(line => selected.has(line.remoteLineId))) {
    const line = fresh.lines.find(candidate => candidate.remoteLineId === original.remoteLineId);
    if (!line || !line.open || line.itemId !== original.itemId || line.quantity !== original.quantity || line.restQuantity !== original.restQuantity
        || !regularStockKitComponentsMatch(original, line, {ignoreLocation:true})
        || line.rate !== original.rate || ![original.remoteLocationId,target].includes(line.remoteLocationId)) throw conflict('A linked SO line changed or started fulfillment. Refresh and resolve it before retrying.');
    if (line.remoteLocationId !== target) pending.push({ line: line.restLineId, location: { id: String(target) } });
  }
  if (pending.length) await boundary.rest(`/record/v1/salesOrder/${id(order.id)}`, { method: 'PATCH', body: { item: { items: pending } } });
  const after = await readRegularSalesOrder(order.ref, boundary);
  if (after.lines.length !== order.lines.length || after.locationId !== order.locationId || after.customerId !== order.customerId || order.lines.some(original => {
    const line = after.lines.find(candidate => candidate.remoteLineId === original.remoteLineId);
    return !line || line.itemId !== original.itemId || line.quantity !== original.quantity || line.restQuantity !== original.restQuantity || line.uom !== original.uom || line.rate !== original.rate
      || !regularStockKitComponentsMatch(original, line, {ignoreLocation:selected.has(original.remoteLineId)}) || (selected.has(original.remoteLineId)&&!line.open)
      || line.remoteLocationId !== (selected.has(original.remoteLineId) ? target : original.remoteLocationId);
  })) throw conflict('SO location update needs verification. Retry to recover the existing change.');
  return after;
}
