/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { findLinkedSpecialPurchaseOrder, createLinkedSpecialPurchaseOrder, finalizeLinkedSpecialPurchaseOrder } from '../../../src/special-stock-native-po-adapter.js';
import { assertSpecialNativePurchaseReady, createSpecialNativePurchase, findSpecialStockOrdersWithNativeLinkFromNetSuite, findSpecialLinkedPurchaseOrderInNetSuite,
  createSpecialLinkedPurchaseOrderInNetSuite, finalizeSpecialLinkedPurchaseOrderInNetSuite } from '../../../src/netsuite.js';

function fixture({ key = 9001, quantity = 500, rate = 5, linked = false } = {}) {
  const input = { salesOrderId: 101, salesOrderLines: [{ caseLineId: 1, itemId: 2055, remoteLineId: key,
    quantity, rate: 17, description: 'SCM reviewed', uom: 'PC' }], purchaseOrderLines: [{ caseLineId: 1 }],
    payload: { entity: { id: '331' }, location: { id: '1' }, memo: 'MBBS Special Item purchase | MBBS-SPECIAL-PO:62',
      item: { items: [{ item: { id: '2055' }, quantity, units: '865', rate, description: 'SCM reviewed', location: { id: '1' } }] } } };
  const so = { id: '101', orderStatus: { id: 'B' }, item: { items: [
    { line: 3, lineUniqueKey: String(key), item: { id: '2055' }, quantity, units: '865', rate: 17,
      description: 'SCM reviewed', ...(linked ? { createPo: { id: 'SpecOrd' }, createdPo: { id: '202' } } : {}) },
    { line: 8, lineUniqueKey: String(key + 1), item: { id: '1784' }, quantity: 11, units: '246', rate: 40, description: 'PALLET' }
  ] } };
  const po = { id: '202', tranId: 'PO202', orderStatus: { id: 'B' }, createdFrom: { id: '101' },
    entity: { id: '331' }, location: { id: '1' }, memo: 'Vendor note', item: { items: input.payload.item.items.map((line, index) => ({ ...structuredClone(line), line: index + 5 })) } };
  const writes = [];
  const boundary = { queryAll: async () => [{ previousline: 3, nextline: 5, linktype: 'SpecOrd' }], rest: async (path, options = {}) => {
    if (options.method === 'PATCH') {
      writes.push({ path, body: options.body });
      if (path === '/record/v1/salesOrder/101') {
        for (const patch of options.body.item.items) {
          const line = so.item.items.find(l => l.line === patch.line);
          Object.assign(line, patch, { createdPo: { id: '202' } });
        }
      } else if (path === '/record/v1/purchaseOrder/202') {
        if (options.body.memo !== undefined) po.memo = options.body.memo;
        for (const patch of options.body.item?.items || []) {
          if(patch.line) Object.assign(po.item.items.find(l => l.line === patch.line), patch);
          else po.item.items.push({...structuredClone(patch),line:Math.max(...po.item.items.map(l=>l.line))+1});
        }
      }
      else throw Error('Unexpected write path');
    } else assert.equal(options.method || 'GET', 'GET', 'No standalone PO POST is allowed');
    return { data: structuredClone(path.includes('/salesOrder/') ? so : po) };
  } };
  boundary.createNative=async request=>{
    assert.equal(request.entityId,101);assert.equal(request.vendorId,331);assert.equal(request.caseId,62);
    return boundary.rest('/record/v1/salesOrder/101',{method:'PATCH',body:{item:{items:request.lines.map(l=>({line:so.item.items.find(row=>Number(row.lineUniqueKey)===l.remoteLineId).line,createPo:{id:'SpecOrd'},poVendor:{id:String(request.vendorId)},poRate:l.purchaseRate}))}}});
  };
  return { input, so, po, writes, boundary };
}

test('native PO matching ignores independent vendor discount rows and preserves them', async () => {
  const f=fixture({linked:true});
  const discount={line:99,item:{id:'10716'},rate:-37,quantity:null,description:'Vendor discount'};
  const subtotal={line:100,item:{id:'-2'},quantity:null},otherDiscount={line:101,item:{id:'2022'},quantity:null,rate:-10};
  f.po.item.items.push(discount,subtotal,otherDiscount);
  const query=f.boundary.queryAll;
  f.boundary.queryAll=async sql=>/FROM item WHERE/.test(sql)?[{id:2022,itemtype:'Discount'}]:query(sql);
  assert.equal((await findLinkedSpecialPurchaseOrder(f.input,f.boundary)).id,202);
  await finalizeLinkedSpecialPurchaseOrder({...f.input,purchaseOrderId:202},f.boundary);
  assert.deepEqual(f.po.item.items.slice(-3),[discount,subtotal,otherDiscount]);
});

test('property: native PO creation preserves every SO commercial value and uses the exact reviewed line', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1e7 }), fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 1000 }), async (key, quantity, rate) => {
    const f = fixture({ key, quantity, rate });
    const before = structuredClone(f.so.item.items);
    assert.equal(await findLinkedSpecialPurchaseOrder(f.input, f.boundary), null);
    const created = await createLinkedSpecialPurchaseOrder(f.input, f.boundary);
    assert.equal(created.id, 202); assert.equal(created.nativeLink, true);
    assert.deepEqual(f.writes[0], { path: '/record/v1/salesOrder/101', body: { item: { items: [{ line: 3, createPo: { id: 'SpecOrd' }, poVendor: { id: '331' }, poRate: rate }] } } });
    assert.equal(f.writes.length, 1);
    for (let n = 0; n < before.length; n++) for (const field of ['item', 'quantity', 'units', 'rate', 'description']) assert.deepEqual(f.so.item.items[n][field], before[n][field]);
    assert.deepEqual(f.so.item.items[1], before[1]);
    await finalizeLinkedSpecialPurchaseOrder({ ...f.input, purchaseOrderId: 202 }, f.boundary);
    assert.equal(f.po.memo, 'Vendor note | MBBS-SPECIAL-PO:62');
    await finalizeLinkedSpecialPurchaseOrder({ ...f.input, purchaseOrderId: 202 }, f.boundary);
    assert.equal(f.writes.length, 2, 'Finalization is idempotent');
    assert.equal((await createLinkedSpecialPurchaseOrder(f.input, f.boundary)).id, 202);
    assert.equal(f.writes.length, 2, 'An existing native link never creates another PO');
  }), { seed: 26092032, numRuns: 40 });
});

test('lost native-create acknowledgement recovers through the SO without a marker or another write', async () => {
  const f = fixture();
  const rest = f.boundary.rest;
  f.boundary.rest = async (path, options = {}) => {
    const r = await rest(path, options);
    if (options.method === 'PATCH') throw Error('Connection lost after creation');
    return r;
  };
  await assert.rejects(createLinkedSpecialPurchaseOrder(f.input, f.boundary), /Connection lost/);
  assert.equal((await findLinkedSpecialPurchaseOrder(f.input, f.boundary)).id, 202);
  assert.equal(f.writes.length, 1);
  assert.equal(f.po.memo, 'Vendor note');
});

test('native creation rejects changed SO identity, description, sales price, quantity, units and existing partial links before writing', async () => {
  for (const patch of [{ lineUniqueKey: '888' }, { item: { id: '1784' } }, { description: 'Changed' }, { rate: 18 },
    { quantity: 501 }, { units: '866' }, { isClosed: true }, { quantityFulfilled: 1 }, { createPo: { id: 'DropShip' } }]) {
    const f = fixture(); Object.assign(f.so.item.items[0], patch);
    await assert.rejects(createLinkedSpecialPurchaseOrder(f.input, f.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ linked: true });
  f.input.salesOrderLines.push({ ...f.input.salesOrderLines[0], caseLineId: 2, remoteLineId: 9003 });
  f.input.purchaseOrderLines.push({ caseLineId: 2 });
  f.input.payload.item.items.push(structuredClone(f.input.payload.item.items[0]));
  f.so.item.items.push({ ...f.so.item.items[0], line: 4, lineUniqueKey: '9003', createdPo: undefined });
  await assert.rejects(createLinkedSpecialPurchaseOrder(f.input, f.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
  assert.equal(f.writes.length, 0);
});

test('a recovered native PO must match the reviewed vendor, source, yard and exact commercial lines', async () => {
  for (const [target, patch] of [['header', { entity: { id: '332' } }], ['header', { location: { id: '2' } }],
    ['header', { createdFrom: { id: '102' } }], ['header', { memo: 'MBBS-SPECIAL-PO:99' }],
    ['line', { item: { id: '1784' } }], ['line', { isClosed: true }], ['line', { quantityReceived: 1 }], ['line', { quantityBilled: 1 }]]) {
    const f = fixture({ linked: true }); Object.assign(target === 'header' ? f.po : f.po.item.items[0], patch);
    await assert.rejects(findLinkedSpecialPurchaseOrder(f.input, f.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ linked: true }); f.po.item.items.push(structuredClone(f.po.item.items[0]));
  await assert.rejects(findLinkedSpecialPurchaseOrder(f.input, f.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
});

for (const ignored of [false, true]) test(`an absent native link after a successful ${ignored ? 'ignored' : 'pending'} response is uncertain and never falls back to PO POST`, async () => {
  const f = fixture(); const rest = f.boundary.rest;
  f.boundary.rest = async (path, options = {}) => {
    const r = await rest(path, options);
    delete f.so.item.items[0].createdPo;
    if (ignored) delete f.so.item.items[0].createPo;
    return r;
  };
  await assert.rejects(createLinkedSpecialPurchaseOrder(f.input, f.boundary), { code: 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN' });
  assert.equal(f.writes.length, 1);
});


test('existing native PO differences are updated after the SO review without another creation', async () => {
  const f = fixture({ linked: true });
  Object.assign(f.po.item.items[0], { quantity: 99, units: '873', rate: 4, description: 'Previous' });
  assert.equal((await findLinkedSpecialPurchaseOrder(f.input, f.boundary)).id, 202);
  await finalizeLinkedSpecialPurchaseOrder({ ...f.input, purchaseOrderId: 202 }, f.boundary);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].path, '/record/v1/purchaseOrder/202');
  assert.deepEqual(f.writes[0].body.item.items, [{ line: 5, quantity: 500, units: '865', rate: 5, description: 'SCM reviewed' }]);
  assert.equal(f.so.item.items[0].quantity, 500);
  assert.equal(f.so.item.items[0].rate, 17);
  assert.equal(f.po.item.items[0].rate, 5);
});

test('production NetSuite facade uses native recovery and serialized writes while retaining the no-SO path', async () => {
  const f = fixture(); let mutations = 0;
  const boundary = { ...f.boundary, mutate: async run => { mutations++; return run(); } };
  assert.equal(await findSpecialLinkedPurchaseOrderInNetSuite(f.input, boundary), null);
  assert.equal((await createSpecialLinkedPurchaseOrderInNetSuite(f.input.payload, f.input, boundary)).id, 202);
  assert.equal((await finalizeSpecialLinkedPurchaseOrderInNetSuite({ ...f.input, purchaseOrderId: 202 }, boundary)).id, 202);
  assert.equal(mutations, 2);
  const rows = await findSpecialStockOrdersWithNativeLinkFromNetSuite({ orderKind: 'purchase_order', salesOrderId: 101 },
    { findMarkers: async () => [{ id: 202 }], rest: f.boundary.rest });
  assert.equal(rows[0].nativeLink, true);
  assert.deepEqual(await findSpecialStockOrdersWithNativeLinkFromNetSuite({ orderKind: 'sales_order' }, { findMarkers: async () => [] }), []);
  let standalone = 0;
  assert.deepEqual(await createSpecialLinkedPurchaseOrderInNetSuite(f.input.payload, { salesOrderId: null },
    { createStandalone: async payload => { standalone++; assert.equal(payload, f.input.payload); return { id: 203 }; } }), { id: 203 });
  assert.equal(standalone, 1);
  assert.equal(await findLinkedSpecialPurchaseOrder({ ...f.input, salesOrderId: null }, f.boundary), null);
});

test('a pending native creation or another unreviewed creation flag never triggers a second order', async () => {
  for (const index of [0, 1]) {
    const f = fixture(); f.so.item.items[index].createPo = { id: 'SpecOrd' };
    await assert.rejects(createLinkedSpecialPurchaseOrder(f.input, f.boundary), { code: 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN' });
    assert.equal(f.writes.length, 0);
  }
});

test('native linkage refuses malformed, duplicate, foreign or unverifiable line identities and detects post-write corruption', async () => {
  const cases = [
    f => { f.input.salesOrderId = -1; },
    f => { f.so.orderStatus.id = 'D'; },
    f => { f.so.item.items = []; },
    f => { f.so.item.items.push(structuredClone(f.so.item.items[0])); },
    f => { f.input.payload.item.items = []; },
    f => { f.input.salesOrderLines = []; },
    f => { f.input.salesOrderLines.push(structuredClone(f.input.salesOrderLines[0])); },
    f => { f.input.purchaseOrderLines.push({ caseLineId: 1 }); f.input.payload.item.items.push(structuredClone(f.input.payload.item.items[0])); },
    f => { f.input.payload.memo = ''; },
    f => { f.boundary.queryAll = async () => [{ previousline: 99, nextline: 5, linktype: 'SpecOrd' }]; }
  ];
  for (const corrupt of cases) {
    const f = fixture({ linked: true }); corrupt(f);
    await assert.rejects(finalizeLinkedSpecialPurchaseOrder({ ...f.input, purchaseOrderId: 202 }, f.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
    assert.equal(f.writes.length, 0);
  }
  const wrong = fixture({ linked: true });
  await assert.rejects(finalizeLinkedSpecialPurchaseOrder({ ...wrong.input, purchaseOrderId: 203 }, wrong.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
  for (const change of ['sales-price', 'purchase-price', 'ancillary-price']) {
    const f = fixture(); const rest = f.boundary.rest;
    f.boundary.rest = async (path, options = {}) => {
      const r = await rest(path, options);
      if (options.method === 'PATCH') (change === 'purchase-price' ? f.po : f.so).item.items[change === 'ancillary-price' ? 1 : 0].rate = 999;
      return r;
    };
    if (change !== 'purchase-price') await assert.rejects(createLinkedSpecialPurchaseOrder(f.input, f.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
    else {
      await createLinkedSpecialPurchaseOrder(f.input, f.boundary);
      await assert.rejects(finalizeLinkedSpecialPurchaseOrder({ ...f.input, purchaseOrderId: 202 }, f.boundary), { code: 'SPECIAL_NATIVE_PO_CONFLICT' });
    }
  }
});


test('native PO appends exactly one vendor summary, keeps gross costs, and recovers a lost finalization acknowledgement', async () => {
  const f=fixture({linked:true});
  f.input.payload.item.items.push({item:{id:'4981'},quantity:1,rate:-30,description:'Vendor discount | MBBS-SPECIAL-PO:62',location:{id:'1'}});
  const query=f.boundary.queryAll;
  f.boundary.queryAll=async sql=>/FROM item WHERE/.test(sql)?[{id:4981,itemtype:'NonInvtPart',subtype:'Purchase',isinactive:'F',isfulfillable:'F'}]:query(sql);
  assert.equal((await findLinkedSpecialPurchaseOrder(f.input,f.boundary)).id,202);
  const rest=f.boundary.rest;let lost=true;
  f.boundary.rest=async (path,options={})=>{const r=await rest(path,options);if(options.method==='PATCH'&&lost){lost=false;throw Error('Lost summary acknowledgement');}return r;};
  await assert.rejects(finalizeLinkedSpecialPurchaseOrder({...f.input,purchaseOrderId:202},f.boundary),/Lost summary acknowledgement/);
  await finalizeLinkedSpecialPurchaseOrder({...f.input,purchaseOrderId:202},f.boundary);
  assert.equal(f.writes.length,1);
  assert.deepEqual(f.po.item.items.map(l=>[l.item.id,l.quantity,l.rate]),[['2055',500,5],['4981',1,-30]]);
  f.po.item.items.push({...f.po.item.items.at(-1),line:100});
  await assert.rejects(finalizeLinkedSpecialPurchaseOrder({...f.input,purchaseOrderId:202},f.boundary),{code:'SPECIAL_NATIVE_PO_CONFLICT'});
  assert.equal(f.writes.length,1);
});


test('native PO creation uses the guarded script action and never PATCHes the ignored REST flag',async()=>{
  const f=fixture();let calls=0;
  f.boundary.createNative=async request=>{calls++;assert.equal(request.lines[0].purchaseRate,5);assert.equal(request.lines[0].salesRate,17);assert.equal(request.lines[0].remoteLineId,9001);f.so.item.items[0].createdPo={id:'202'};};
  assert.equal((await createLinkedSpecialPurchaseOrder(f.input,f.boundary)).id,202);
  assert.equal(calls,1);assert.equal(f.writes.length,0);
});


test('native RESTlet capability and response identity are required',async()=>{
  await assertSpecialNativePurchaseReady({restlet:async input=>{assert.equal(input.action,'health');return {ok:true,capabilities:{createSpecialPurchaseOrder:true}};}});
  await assert.rejects(assertSpecialNativePurchaseReady({restlet:async()=>({ok:true,capabilities:{}})}),{code:'SPECIAL_NATIVE_PO_SETUP_REQUIRED'});
  const request={entityId:101};
  assert.equal((await createSpecialNativePurchase(request,{restlet:async input=>{assert.equal(input.action,'createSpecialPurchaseOrder');return {ok:true,action:input.action,entityId:101,purchaseOrderId:202};}})).purchaseOrderId,202);
  for(const patch of [{ok:false},{action:'wrong'},{entityId:102},{purchaseOrderId:0},{purchaseOrderId:1.5}]) await assert.rejects(createSpecialNativePurchase(request,{restlet:async()=>({ok:true,action:'createSpecialPurchaseOrder',entityId:101,purchaseOrderId:202,...patch})}),{code:'SPECIAL_REMOTE_OUTCOME_UNCERTAIN'});
});

test('malformed summaries and unavailable purchase discount items block before any native write',async()=>{
  for(const patch of [{quantity:2},{rate:1},{rate:-1.001},{rate:NaN},{description:'Foreign review'}]){
    const f=fixture();f.input.payload.item.items.push({item:{id:'4981'},quantity:1,rate:-10,description:'Vendor discount | MBBS-SPECIAL-PO:62',...patch});
    await assert.rejects(createLinkedSpecialPurchaseOrder(f.input,f.boundary),{code:'SPECIAL_NATIVE_PO_CONFLICT'});assert.equal(f.writes.length,0);
  }
  for(const metadata of [[],[{id:4981,itemtype:'NonInvtPart',subtype:'Purchase',isinactive:'T',isfulfillable:'F'}],[{id:4981,itemtype:'NonInvtPart',subtype:'Sale',isinactive:'F',isfulfillable:'F'}]]){
    const f=fixture();f.input.payload.item.items.push({item:{id:'4981'},quantity:1,rate:-10,description:'Vendor discount | MBBS-SPECIAL-PO:62'});
    f.boundary.queryAll=async()=>metadata;
    await assert.rejects(createLinkedSpecialPurchaseOrder(f.input,f.boundary),{code:'SPECIAL_NATIVE_PO_CONFLICT'});assert.equal(f.writes.length,0);
  }
});
