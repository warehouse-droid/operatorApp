// Native Special Order linkage is created by NetSuite from the exact SO lines.
// No standalone PO POST belongs in this adapter, including after a timeout.
/**
 * @typedef {{id:string|number}|string|number|null|undefined} Ref
 * @typedef {{line:number,lineUniqueKey?:string,item:Ref,quantity:number|string,units:Ref,rate:number|string,description?:string,isClosed?:boolean,quantityFulfilled?:number,quantityReceived?:number,quantityBilled?:number,createPo?:{id:string},createdPo?:{id:string},poVendor?:{id:string},poRate?:number}} RemoteLine
 * @typedef {{id?:string,tranId?:string,orderStatus?:Ref,createdFrom?:Ref,entity?:Ref,location?:Ref,memo?:string,item?:{items:RemoteLine[]}}} RemoteRecord
 * @typedef {{item:Ref,quantity:number,units?:Ref,rate:number,description:string,location?:Ref}} PurchaseLine
 * @typedef {{salesOrderId:number|null,purchaseOrderId?:number,salesOrderLines:{caseLineId:number,ancillary?:boolean,remoteLineId:number,rate:number}[],purchaseOrderLines:{caseLineId:number}[],payload:{entity:{id:string},location:{id:string},memo:string,item:{items:PurchaseLine[]}}}} Input
 * @typedef {{rest:(path:string,options?:{method?:string,body?:{memo?:string,item?:{items:Partial<RemoteLine>[]}}})=>Promise<{data?:RemoteRecord}>,createNative?:(request:object)=>Promise<unknown>,queryAll:(sql:string)=>Promise<{previousline?:number|string,nextline?:number|string,linktype?:string,id?:number|string,itemtype?:string,subtype?:string,isinactive?:string,isfulfillable?:string}[]>}} Boundary
 * @typedef {{so:RemoteRecord,source:RemoteLine[],selected:{line:RemoteLine,item:PurchaseLine}[],purchaseOrderId:number|null}} Plan
 */

/** @param {string} message @param {string} code */
function conflict(message, code = 'SPECIAL_NATIVE_PO_CONFLICT') {
  return Object.assign(new Error(message), { status: 409, code });
}
/** @param {unknown} value */
function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw conflict('The exact SO/PO line identities are required.');
  return n;
}
/** @param {Ref} value */
const ref = value => String((typeof value === 'object' ? value?.id : value) ?? '');
/** @param {RemoteRecord|undefined} record @returns {RemoteLine[]} */
const lines = record => {
  const result = record?.item?.items;
  if (!Array.isArray(result) || !result.length || new Set(result.map(l => id(l.line))).size !== result.length) {
    throw conflict('The complete order lines must have distinct identities.');
  }
  return result;
};
/** @param {RemoteLine} line */
const commercial = line => JSON.stringify([id(line.line), ref(line.item), Number(line.quantity ?? 0),
  ref(line.units), String(line.rate ?? ''), String(line.description || '')]);
/** @param {RemoteLine[]} before @param {RemoteRecord} after */
function unchanged(before, after) {
  const next = lines(after);
  if (before.length !== next.length || before.some(line => !next.some(candidate => commercial(candidate) === commercial(line)))) {
    throw conflict('SO quantities, units, descriptions, sales prices or other lines changed during PO synchronization.');
  }
}
/** @param {Input} input */
function marker(input) {
  const match = String(input.payload.memo).match(/MBBS-SPECIAL-PO:\d+\b/);
  if (!match) throw conflict('The reviewed PO case marker is required.');
  return match[0];
}
/** @param {Input} input @param {Boundary} boundary @returns {Promise<Plan>} */
async function readSo(input, { rest }) {
  const so = (await rest(`/record/v1/salesOrder/${id(input.salesOrderId)}?expandSubResources=true`)).data;
  if (!so || ref(so.orderStatus) !== 'B') throw conflict('The SO must be approved and awaiting fulfillment.');
  const source = lines(so);
  const items = input.payload.item.items.filter(item=>ref(item.item)!=='4981');
  if (!items.length || items.length !== input.purchaseOrderLines.length) throw conflict('Every reviewed purchase line is required.');
  const selected = items.map((item, index) => {
    const expected = input.salesOrderLines.filter(l => l.caseLineId === input.purchaseOrderLines[index].caseLineId && !l.ancillary);
    if (expected.length !== 1) throw conflict('The corresponding reviewed SO line is ambiguous.');
    const matches = source.filter(l => Number(l.lineUniqueKey) === id(expected[0].remoteLineId));
    const line = matches[0];
    if (matches.length !== 1 || ref(line.item) !== '2055' || ref(item.item) !== '2055'
      || Number(line.quantity) !== Number(item.quantity) || ref(line.units) !== ref(item.units)
      || String(line.description || '') !== String(item.description) || Number(line.rate) !== Number(expected[0].rate)
      || line.isClosed === true || Number(line.quantityFulfilled || 0) > 0
      || (line.createPo && ref(line.createPo) !== 'SpecOrd')) {
      throw conflict('Correct and verify the SO quantity, UOM and description before creating its native PO.');
    }
    return { line, item };
  });
  if (new Set(selected.map(s => s.line.line)).size !== selected.length) throw conflict('A reviewed SO line cannot be used twice.');
  const linked = selected.filter(s => s.line.createdPo);
  if (linked.length && (linked.length !== selected.length || new Set(linked.map(s => ref(s.line.createdPo))).size !== 1)) {
    throw conflict('The reviewed SO lines are partly linked or point to different POs. Resolve the existing links first.');
  }
  if (source.some(line => line.createPo?.id && !line.createdPo?.id)) {
    throw conflict('A native PO creation is already pending on this SO. Wait for its link before saving the order again.', 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN');
  }
  return { so, source, selected, purchaseOrderId: linked.length ? id(linked[0].line.createdPo?.id) : null };
}
/** @param {Input} input @param {Plan} plan @param {Boundary} boundary */
async function readPo(input, plan, { rest, queryAll }) {
  const poId = id(plan.purchaseOrderId);
  const po = (await rest(`/record/v1/purchaseOrder/${poId}?expandSubResources=true`)).data;
  if (!po || ref(po.createdFrom) !== String(input.salesOrderId) || ref(po?.entity) !== ref(input.payload.entity)
    || ref(po?.location) !== ref(input.payload.location) || !['A', 'B'].includes(ref(po?.orderStatus))
    || (String(po.memo || '').match(/MBBS-SPECIAL-PO:\d+\b/g) || []).some(m => m !== marker(input))) {
    throw conflict('The linked PO belongs to another SO, vendor, yard or case, or is no longer open.');
  }
  const source = lines(po), nonMaterialIds = new Set(['10716','-2','4981']);
  const otherIds = [...new Set(source.map(line => ref(line.item)).filter(itemId => itemId !== '2055' && !nonMaterialIds.has(itemId)))];
  if (otherIds.length) {
    const types = await queryAll(`SELECT id,itemtype FROM item WHERE id IN (${otherIds.map(id).join(',')}) AND itemtype IN ('Discount','Subtotal')`);
    for (const row of types) if (['Discount','Subtotal'].includes(row.itemtype || '')) nonMaterialIds.add(String(row.id));
  }
  const actual = source.filter(line => !nonMaterialIds.has(ref(line.item)));
  const links = await queryAll(`SELECT previousline,nextline,linktype FROM NextTransactionLineLink
    WHERE previousdoc=${id(input.salesOrderId)} AND nextdoc=${poId} AND linktype='SpecOrd'`);
  if (actual.length !== plan.selected.length || links.length !== plan.selected.length) throw conflict('The native PO contains missing or unreviewed lines.');
  const mappings = plan.selected.map(({ line, item }) => {
    const linked = links.filter(l => Number(l.previousline) === Number(line.line) && l.linktype === 'SpecOrd');
    const matches = actual.filter(l => linked.length === 1 && Number(l.line) === Number(linked[0].nextline));
    const current = matches[0];
    if (matches.length !== 1 || ref(current.item) !== ref(item.item) || current.isClosed === true
      || Number(current.quantityReceived || 0) !== 0 || Number(current.quantityBilled || 0) !== 0) {
      throw conflict('PO updates require the exact open, unreceived and unbilled special-item line.');
    }
    return { current, item };
  });
  if (new Set(mappings.map(m => m.current.line)).size !== mappings.length) throw conflict('The native PO line mapping is ambiguous.');
  return { po, mappings };
}
/** @param {Input} input @param {Boundary} boundary */
async function reviewedDiscount(input, boundary) {
  const matches = input.payload.item.items.filter(line=>ref(line.item)==='4981');
  const line = matches[0];
  if (!line) return null;
  if (matches.length!==1 || line!==input.payload.item.items.at(-1) || line.quantity!==1 || !Number.isFinite(line.rate)
    || line.rate>0 || line.rate!==Number(line.rate.toFixed(2)) || line.description!==`Vendor discount | ${marker(input)}`) {
    throw conflict('The reviewed vendor discount must be one final, negative purchase discount.');
  }
  const rows = await boundary.queryAll('SELECT id,itemtype,subtype,isinactive,isfulfillable FROM item WHERE id=4981');
  if (rows.length!==1 || String(rows[0].id)!=='4981' || rows[0].itemtype!=='NonInvtPart' || rows[0].subtype!=='Purchase'
    || rows[0].isinactive!=='F' || rows[0].isfulfillable!=='F') throw conflict('The vendor discount purchase item is unavailable.');
  return line;
}
/** @param {RemoteRecord} po @param {PurchaseLine|null} expected */
function discountMissing(po, expected) {
  if (!expected) return false; // Retain independent discounts on legacy POs.
  const matches = lines(po).filter(line=>ref(line.item)==='4981');
  if (!matches.length) return true;
  const line=matches[0];
  if (matches.length!==1 || line!==lines(po).at(-1) || Number(line.quantity)!==1 || Number(line.rate)!==expected.rate
    || line.description!==expected.description) throw conflict('The PO vendor discount differs from the confirmed review.');
  return false;
}
/** @param {Input} input @param {Plan} plan @param {RemoteRecord} po */
function result(input, plan, po) {
  return { id: plan.purchaseOrderId, tranid: po.tranId, entity_id: id(input.payload.entity.id),
    location_id: id(input.payload.location.id), nativeLink: true };
}
/** @param {Input} input @param {Boundary} boundary */
export async function findLinkedSpecialPurchaseOrder(input, boundary) {
  if (!input.salesOrderId) return null;
  const plan = await readSo(input, boundary);
  if (!plan.purchaseOrderId) return null;
  return result(input, plan, (await readPo(input, plan, boundary)).po);
}
/** @param {Input} input @param {Boundary} boundary */
export async function createLinkedSpecialPurchaseOrder(input, boundary) {
  const plan = await readSo(input, boundary);
  if (plan.purchaseOrderId) return result(input, plan, (await readPo(input, plan, boundary)).po);
  await reviewedDiscount(input,boundary);
  if (!boundary.createNative) throw conflict('Update the NetSuite RESTlet to enable native Special Order PO creation.', 'SPECIAL_NATIVE_PO_SETUP_REQUIRED');
  await boundary.createNative({entityId:id(input.salesOrderId),caseId:id(marker(input).split(':')[1]),
    vendorId:id(input.payload.entity.id),locationId:id(input.payload.location.id),
    lines:plan.selected.map(({line,item})=>({remoteLineId:id(line.lineUniqueKey),quantity:Number(item.quantity),
      unitId:id(ref(item.units)),description:item.description,salesRate:Number(line.rate),purchaseRate:Number(item.rate)}))});
  const after = await readSo(input, boundary);
  unchanged(plan.source, after.so);
  if (!after.purchaseOrderId) throw conflict('The native PO is not visible yet. Recover its SO link; do not create another PO.', 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN');
  return result(input, after, (await readPo(input, after, boundary)).po);
}
/** @param {Input} input @param {Boundary} boundary */
export async function finalizeLinkedSpecialPurchaseOrder(input, boundary) {
  const plan = await readSo(input, boundary);
  if (plan.purchaseOrderId !== id(input.purchaseOrderId)) throw conflict('The SO does not point to the PO being finalized.');
  const { po, mappings } = await readPo(input, plan, boundary);
  const discount = await reviewedDiscount(input,boundary);
  const appendDiscount = discountMissing(po,discount);
  const pending = mappings.filter(({ current, item }) => Number(current.quantity) !== Number(item.quantity)
    || ref(current.units) !== ref(item.units) || Number(current.rate) !== Number(item.rate)
    || String(current.description || '') !== String(item.description));
  const caseMarker = marker(input);
  const memo = String(po.memo || '');
  const hasMarker = Array.from(memo.matchAll(/MBBS-SPECIAL-PO:\d+\b/g), m => m[0]).includes(caseMarker);
  if (pending.length || !hasMarker || appendDiscount) {
    await boundary.rest(`/record/v1/purchaseOrder/${id(plan.purchaseOrderId)}`, { method: 'PATCH', body: {
      ...(!hasMarker ? { memo: [memo, caseMarker].filter(Boolean).join(' | ') } : {}),
      ...(pending.length || appendDiscount ? { item: { items: [...pending.map(({ current, item }) => ({ line: id(current.line),
        quantity: Number(item.quantity), units: ref(item.units), rate: Number(item.rate), description: String(item.description) })),
        ...(appendDiscount && discount ? [discount] : [])] } } : {})
    } });
  }
  const after = await readSo(input, boundary);
  unchanged(plan.source, after.so);
  const verified = await readPo(input, after, boundary);
  if (discountMissing(verified.po,discount) || !String(verified.po.memo || '').includes(caseMarker) || verified.mappings.some(({ current, item }) =>
    Number(current.quantity) !== Number(item.quantity) || ref(current.units) !== ref(item.units)
    || Number(current.rate) !== Number(item.rate) || String(current.description || '') !== String(item.description))) {
    throw conflict('The PO did not retain the reviewed quantity, UOM, description, purchase cost or marker.');
  }
  return result(input, after, verified.po);
}
