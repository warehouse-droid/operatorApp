/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildSpecialSalesOrderPayload } from '../../../src/special-stock-request-netsuite.js';
import { applySpecialAdjustmentPlan } from '../../../src/special-stock-adjustment-adapter.js';
import { createSpecialRestOrderBoundary, prepareSpecialRestAdjustmentPlan } from '../../../src/special-stock-rest-orders.js';
import { createSpecialDiscountSalesOrderInNetSuite, verifySpecialDiscountSalesOrderInNetSuite,
  prepareSpecialAdjustmentPlanInNetSuite, applySpecialAdjustmentPlanInNetSuite } from '../../../src/netsuite.js';

const payloadFor = materialLines => buildSpecialSalesOrderPayload({ discountMode: 'line', caseId: 9, netsuiteLocationId: 1, pickupMethodId: 2,
  draft: { customerId: 10, materialLines, ancillaryLines: [{ itemId: 1784, quantity: 2, unitId: 246, rate: 40, description: 'PALLET' }] } });
const material = (rate = 100, quantity = 1, discountPercent = 15) => ({ itemId: 2055, quantity, rate, discountPercent, unitId: 865, description: 'Reviewed material' });

test('REST payload calculates the approved numeric discount directly after each material', () => {
  const payload = payloadFor([material(100), material(200), material(0.01, 3, 50), material(5, 1, 0)]);
  assert.deepEqual(payload.item.items.map(line => [line.item.id, line.rate]),
    [['2055', 100], ['10716', -15], ['2055', 200], ['10716', -30], ['2055', 0.01], ['10716', -0.02], ['2055', 5], ['1784', 40]]);
  assert.ok(payload.item.items.every(line => line.price.id === '-1'));
  assert.equal(payload.externalId, 'MBBS-SPECIAL-SO:9');
  assert.ok(payload.item.items.filter(line => line.item.id === '10716').every(line => !('quantity' in line) && !('units' in line)));
});

test('property: discount amounts round half up in cents, stay bounded, and never include pallets', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 100000 }),
    fc.integer({ min: 1, max: 1000000 }), (quantity, rateCents, percentageUnits) => {
      const payload = payloadFor([material(rateCents / 100, quantity, percentageUnits / 10000)]);
      const cents = (BigInt(quantity * rateCents) * BigInt(percentageUnits) + 500000n) / 1000000n;
      const expected = cents === 0n ? 0 : -Number(cents) / 100;
      assert.equal(payload.item.items[1].rate, expected);
      assert.equal(payload.item.items[1].item.id, '10716');
      assert.deepEqual([payload.item.items[2].item.id, payload.item.items[2].quantity, payload.item.items[2].rate], ['1784', 2, 40]);
      assert.ok(payload.item.items[1].rate <= 0 && -payload.item.items[1].rate <= quantity * rateCents / 100);
    }), { seed: 20260927, numRuns: 250 });
});

export function restFixture() {
  const makeLine = (line, key, item, quantity, rate, description, extra = {}) => ({ line, lineUniqueKey: String(key),
    item: { id: String(item) }, quantity, units: item === 1784 ? '246' : '865', rate,
    amount: quantity * rate, description, location: { id: '1' }, taxCode: { id: '11' },
    price: { id: '-1' }, isClosed: false, ...extra });
  const makeRecord = (entity, lines) => ({ entity: { id: String(entity) }, location: { id: '1' }, currency: { id: '1' },
    exchangeRate: 1, memo: 'MBBS-SPECIAL-SO:9', statusCode: 'B', item: { items: lines } });
  const records = new Map([[11, makeRecord(10, [makeLine(1, 101, 2055, 50, 17, 'Reviewed material', { createdPo: { id: '12' } }),
    makeLine(2, 102, 1784, 11, 40, 'PALLET')])], [12, makeRecord(20, [makeLine(1, 201, 2055, 50, 5, 'Reviewed material')])]]);
  const writes = [], calls = []; let nextLine = 10, nextKey = 900, failAfterSave = false, failPo = false;
  const queryAll = async sql => {
    if (/FROM item WHERE id=10716/.test(sql)) return [{ id: 10716 }];
    const id = Number(/tl.transaction\s*=\s*(\d+)/.exec(sql)?.[1]);
    assert.ok(records.has(id), sql);
    return records.get(id).item.items.map(line => ({ uniquekey: line.lineUniqueKey, rest_line_id: line.line,
      item: line.item.id, status: records.get(id).statusCode, execution_quantity: line.executed || 0,
      billed_quantity: line.billed || 0, line_closed: line.isClosed ? 'T' : 'F', ratepercent: line.ratepercent ?? null }));
  };
  const rest = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    const id = Number(/\/(?:salesOrder|purchaseOrder)\/(\d+)/.exec(path)?.[1]);
    if (!options.method || options.method === 'GET') return { data: structuredClone(records.get(id)) };
    assert.ok(['PATCH', 'POST'].includes(options.method));
    assert.ok(options.body.item.items.every(line => line.rate === undefined || typeof line.rate === 'number'), 'REST rate must be numeric');
    if (id === 12 && failPo) { failPo = false; throw Error('PO unavailable'); }
    const created = options.method === 'POST', recordId = created ? 30 : id;
    const record = created ? makeRecord(10, []) : structuredClone(records.get(id));
    if (created) Object.assign(record, structuredClone(options.body), { item: { items: [] } });
    if (!created) for (const key of ['discountItem', 'discountRate']) {
      if (key in options.body) record[key] = structuredClone(options.body[key]);
    }
    let oldLines = record.item.items;
    if (path.includes('replace=item')) oldLines = oldLines.filter(line => options.body.item.items.some(change => change.line === line.line));
    for (const change of options.body.item.items) {
      const existing = oldLines.find(line => line.line === change.line);
      const target = existing || { line: ++nextLine, lineUniqueKey: String(++nextKey), isClosed: false };
      Object.assign(target, structuredClone(change));
      if (target.item.id === '10716') { target.quantity = null; target.units = null; target.description ||= ''; target.amount = target.rate; }
      else target.amount = Math.round(target.quantity * target.rate * 100) / 100;
      target.location ||= record.location;
      target.taxCode ||= { id: '11' };
      if (!existing) oldLines.push(target);
    }
    record.item.items = oldLines; record.tranId ||= 'TEST-SO-30';
    records.set(recordId, record); writes.push({ id: recordId, body: structuredClone(options.body), path });
    if (failAfterSave) { failAfterSave = false; throw Error('lost response after save'); }
    return { id: recordId };
  };
  const orders = [{ id: 11, kind: 'sales_order', lines: [{ remoteLineId: 101, itemId: 2055, quantity: 50, rate: 17,
    unitId: 865, description: 'Reviewed material', toQuantity: 50, toRate: 20, nativeDiscountPercent: null, toNativeDiscountPercent: 15 }] },
  { id: 12, kind: 'purchase_order', lines: [{ remoteLineId: 201, itemId: 2055, quantity: 50, rate: 5,
    unitId: 865, description: 'Reviewed material', toQuantity: 50 }] }];
  return { records, writes, calls, orders, rest, queryAll, boundary: createSpecialRestOrderBoundary({ rest, queryAll }),
    restlet: async () => { throw Error('RESTlet must not read or write orders'); },
    loseResponse() { failAfterSave = true; }, failPo() { failPo = true; } };
}

test('combined SO discount survives creation and later REST review without changing independent PO discounts', async () => {
  const f = restFixture();
  const payload = buildSpecialSalesOrderPayload({ caseId: 9, netsuiteLocationId: 1, pickupMethodId: 2,
    draft: { customerId: 10, salesRepId: 123, materialLines: [material(100, 2, 15), material(20, 1, 50)], ancillaryLines: [] } });
  await createSpecialDiscountSalesOrderInNetSuite(payload, f);
  await verifySpecialDiscountSalesOrderInNetSuite(30, payload, f);
  assert.equal(f.records.get(30).discountRate, -40);
  assert.equal(f.records.get(30).salesRep.id, '123');
  assert.equal(f.records.get(30).item.items.length, 2);
  f.records.get(30).discountRate = -41;
  await assert.rejects(() => verifySpecialDiscountSalesOrderInNetSuite(30, payload, f), { code: 'SPECIAL_SO_PRICE_CONFLICT' });
  Object.assign(f.records.get(11), { discountItem: { id: '10716' }, discountRate: -85 });
  Object.assign(f.orders[0], { discountMode: 'total' });
  Object.assign(f.orders[0].lines[0], { nativeDiscountPercent: 10, toQuantity: 60 });
  f.orders[1].lines[0].toQuantity = 60;
  const vendorDiscount = { line: 2, lineUniqueKey: '202', item: { id: '10716' }, rate: -37,
    quantity: null, units: null, amount: -37, description: 'Independent vendor discount', isClosed: false,
    location: { id: '1' }, taxCode: { id: '11' }, price: { id: '-1' } };
  f.records.get(12).item.items.push(vendorDiscount);
  const plan = await prepareSpecialRestAdjustmentPlan({ orders: f.orders }, f);
  await applySpecialAdjustmentPlan(plan, f.boundary);
  const count = f.writes.length;
  await applySpecialAdjustmentPlan(plan, f.boundary);
  assert.equal(f.writes.length, count);
  assert.equal(f.records.get(11).discountRate, -180);
  assert.deepEqual(f.records.get(11).item.items.map(l => l.lineUniqueKey), ['101', '102']);
  assert.equal(f.records.get(12).item.items[0].rate, 5);
  assert.equal(f.records.get(12).item.items[1].rate, -37);
  assert.equal(f.records.get(12).item.items[1].lineUniqueKey, '202');
});

test('REST moves the unlinked PALLET after the new discount while preserving native material and PO identities', async () => {
  const f = restFixture(), plan = await prepareSpecialRestAdjustmentPlan({ orders: f.orders }, f);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(plan.orders[0].target.lines.map(line => [line.itemId, line.remoteLineId, line.rate]),
    [[2055, 101, '20'], [10716, null, '-150'], [1784, null, '40']]);
  const result = await applySpecialAdjustmentPlan(plan, f.boundary);
  const lines = f.records.get(11).item.items;
  assert.deepEqual(lines.map(line => [line.item.id, line.quantity, line.rate]), [['2055', 50, 20], ['10716', null, -150], ['1784', 11, 40]]);
  assert.equal(lines[0].lineUniqueKey, '101'); assert.equal(lines[0].createdPo.id, '12');
  assert.equal(f.records.get(12).item.items[0].lineUniqueKey, '201'); assert.equal(f.records.get(12).item.items[0].rate, 5);
  assert.equal(result.verifiedOrders[0].lines[2].remoteLineId, Number(lines[2].lineUniqueKey));
  await applySpecialAdjustmentPlan(plan, f.boundary); assert.equal(f.writes.length, 1);
});

test('lost SO response and a later PO failure recover without duplicate discounts or repricing vendor costs', async () => {
  const f = restFixture(); f.orders.forEach(order => { order.lines[0].toQuantity = 60; });
  const plan = await prepareSpecialRestAdjustmentPlan({ orders: f.orders }, f); f.loseResponse();
  await assert.rejects(() => applySpecialAdjustmentPlan(plan, f.boundary), /lost response/);
  f.failPo(); await assert.rejects(() => applySpecialAdjustmentPlan(plan, f.boundary), /PO unavailable/);
  await applySpecialAdjustmentPlan(plan, f.boundary);
  assert.deepEqual(f.writes.map(write => write.id), [11, 12]);
  assert.equal(f.records.get(11).item.items[1].rate, -180);
  assert.equal(f.records.get(12).item.items[0].rate, 5);
});

test('REST does not recreate a later material to insert a discount between linked materials', async () => {
  const f = restFixture();
  f.records.get(11).item.items.splice(1, 0, { ...structuredClone(f.records.get(11).item.items[0]), line: 3, lineUniqueKey: '103' });
  await assert.rejects(() => prepareSpecialRestAdjustmentPlan({ orders: f.orders }, f), /insert.*discount|position|linked material/i);
  assert.deepEqual(f.writes, []);
});

test('PO REST lines without lineUniqueKey are matched through their SuiteQL line identity',async()=>{
  const f=restFixture(),queryAll=f.queryAll;
  f.queryAll=async sql=>{
    const rows=await queryAll(sql);return rows.map(row=>({...row,uniquekey:row.uniquekey || '201'}));
  };
  delete f.records.get(12).item.items[0].lineUniqueKey;
  f.orders[1].lines[0].toQuantity=60;
  const plan=await prepareSpecialRestAdjustmentPlan({orders:f.orders},f);
  await applySpecialAdjustmentPlan(plan,createSpecialRestOrderBoundary(f));
  assert.equal(f.records.get(12).item.items.length,1);
  assert.equal(f.writes.find(write=>write.id===12).body.item.items[0].line,1);
  assert.equal(f.records.get(12).item.items[0].quantity,60);
});

test('inconsistent REST and SuiteQL item identities cannot prepare a write',async()=>{
  const f=restFixture(),queryAll=f.queryAll;
  f.queryAll=async sql=>(await queryAll(sql)).map(row=>({...row,item:999}));
  await assert.rejects(()=>prepareSpecialRestAdjustmentPlan({orders:f.orders},f),/inconsistent order line identities/);
  assert.deepEqual(f.writes,[]);
});

test('property: native pending states accept reads and every execution, billing or closure change blocks all writes', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', ''),
    fc.boolean(), fc.boolean(), fc.boolean(), async (status, executed, billed, closed) => {
      const f = restFixture(); f.records.get(12).statusCode = status;
      Object.assign(f.records.get(12).item.items[0], { executed: executed ? 1 : 0, billed: billed ? 1 : 0, isClosed: closed });
      if (['A', 'B'].includes(status) && !executed && !billed && !closed) {
        const plan = await prepareSpecialRestAdjustmentPlan({ orders: f.orders }, f); assert.equal(plan.orders.length, 2);
      } else await assert.rejects(() => prepareSpecialRestAdjustmentPlan({ orders: f.orders }, f), { code: 'SPECIAL_ADJUSTMENT_CONFLICT' });
      assert.deepEqual(f.writes, []);
    }), { seed: 20260928, numRuns: 80 });
});

test('public NetSuite wrappers use REST for creation, verification and adjustments with Custom pricing', async () => {
  const f = restFixture(), payload = payloadFor([material()]);
  assert.equal((await createSpecialDiscountSalesOrderInNetSuite(payload, f)).id, 30);
  assert.equal(f.writes[0].path, '/record/v1/salesOrder');
  await verifySpecialDiscountSalesOrderInNetSuite(30, payload, f);
  f.records.get(30).item.items[1].ratepercent = -0.15;
  await assert.rejects(() => verifySpecialDiscountSalesOrderInNetSuite(30, payload, f), { code: 'SPECIAL_SO_PRICE_CONFLICT' });
  const plan = await prepareSpecialAdjustmentPlanInNetSuite({ orders: f.orders }, f);
  await applySpecialAdjustmentPlanInNetSuite(plan, f);
  await createSpecialDiscountSalesOrderInNetSuite(payload, { ...f, estimateId: 99 });
  assert.equal(f.writes.at(-1).path, '/record/v1/estimate/99/!transform/salesOrder?replace=item');
});

test('existing amount discounts recalculate with quantity, can be removed, and PALLET can be added again', async () => {
  const f=restFixture();
  await applySpecialAdjustmentPlan(await prepareSpecialRestAdjustmentPlan({orders:f.orders},f),f.boundary);
  Object.assign(f.orders[0].lines[0],{rate:20,nativeDiscountPercent:15,toNativeDiscountPercent:25,toQuantity:60});
  f.orders[0].pallets={fromQuantity:11,toQuantity:0,rate:40};f.orders[1].lines[0].toQuantity=60;
  const updated=await prepareSpecialRestAdjustmentPlan({orders:f.orders},f);
  await applySpecialAdjustmentPlan(updated,f.boundary);
  assert.deepEqual(f.records.get(11).item.items.map(line=>[line.item.id,line.quantity,line.rate]),[['2055',60,20],['10716',null,-300]]);
  Object.assign(f.orders[0].lines[0],{quantity:60,nativeDiscountPercent:25,toNativeDiscountPercent:0});
  Object.assign(f.orders[1].lines[0],{quantity:60});
  f.orders[0].pallets={fromQuantity:0,toQuantity:3,rate:40,unitId:246};
  const removed=await prepareSpecialRestAdjustmentPlan({orders:f.orders},f);
  await applySpecialAdjustmentPlan(removed,f.boundary);
  assert.deepEqual(f.records.get(11).item.items.map(line=>[line.item.id,line.quantity,line.rate]),[['2055',60,20],['1784',3,40]]);
});

test('a PALLET-only change preserves an existing native percentage without writing its rate', async()=>{
  const f=restFixture();
  const original=f.records.get(11).item.items;
  original[0].rate=20;
  original.splice(1,0,{line:3,lineUniqueKey:'103',item:{id:'10716'},quantity:null,units:null,rate:-15,ratepercent:-0.15,
    description:'',location:{id:'1'},taxCode:{id:'11'},price:{id:'-1'},isClosed:false});
  const orders=[{id:11,kind:'sales_order',lines:[],pallets:{fromQuantity:11,toQuantity:12,rate:40}}];
  const plan=await prepareSpecialRestAdjustmentPlan({orders},f);
  await applySpecialAdjustmentPlan(plan,f.boundary);
  assert.equal('rate' in f.writes[0].body.item.items[1],false);
  assert.equal(f.records.get(11).item.items[1].ratepercent,-0.15);
  assert.equal(f.records.get(11).item.items[2].quantity,12);
});

test('unreviewed remote changes and tampered saved plans stop before any REST mutation',async()=>{
  const attacks=[
    p=>{p.orders[0].target.header.memo='tampered';},
    p=>{p.orders[0].target.lines.push(structuredClone(p.orders[0].target.lines[0]));},
    p=>{p.orders[0].target.lines[1].remoteLineId=999;},
    p=>{p.orders[0].target.lines.shift();},
    p=>{p.orders[1].target.lines[0].rate='99';},
    p=>{p.orders[0].target.lines[2].description='unreviewed PALLET';},
    p=>{p.orders[0].target.lines[2].quantity=1.5;},
    p=>{p.orders[0].target.lines[1].rate='1';},
    p=>{p.orders[0].target.lines[1].rate='-1001';},
    p=>{p.orders[0].target.lines[1].rate='-1.001';},
    p=>{p.orders[0].target.lines[0].rate='Infinity';},
    p=>{p.orders[0].target.lines[2].itemId=2055;},
    p=>{p.orders[0].target.lines[1].createdPoId=12;},
    p=>{p.orders[0].target.lines[0].unitId=999;}
  ];
  for(const attack of attacks){
    const f=restFixture(),plan=await prepareSpecialRestAdjustmentPlan({orders:f.orders},f);attack(plan);
    await assert.rejects(()=>applySpecialAdjustmentPlan(plan,f.boundary));
    assert.deepEqual(f.writes,[]);
  }
  const f=restFixture(),plan=await prepareSpecialRestAdjustmentPlan({orders:f.orders},f);
  f.records.get(12).item.items[0].description='Remote PO change';
  await assert.rejects(()=>applySpecialAdjustmentPlan(plan,f.boundary),{code:'SPECIAL_ADJUSTMENT_CONFLICT'});
  assert.deepEqual(f.writes,[]);
});

test('property: calculated discounts preserve linked material keys and PO costs through repeated REST reviews',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:500}),fc.integer({min:1,max:10000}),async(quantity,percent)=>{
    const f=restFixture();f.orders[0].lines[0].toQuantity=quantity;f.orders[0].lines[0].toNativeDiscountPercent=percent/100;
    f.orders[1].lines[0].toQuantity=quantity;
    const plan=await prepareSpecialRestAdjustmentPlan({orders:f.orders},f);
    await applySpecialAdjustmentPlan(plan,f.boundary);const count=f.writes.length;
    await applySpecialAdjustmentPlan(plan,f.boundary);await f.boundary.apply(plan.orders[0]);
    const lines=f.records.get(11).item.items;
    const cents=(BigInt(quantity)*2000n*BigInt(percent)+5000n)/10000n;
    assert.equal(lines[1].rate,cents===0n?0:-Number(cents)/100);assert.equal(lines[1].item.id,'10716');
    assert.equal(lines[0].lineUniqueKey,'101');assert.equal(lines[0].createdPo.id,'12');
    assert.equal(lines[2].quantity,11);assert.equal(lines[2].rate,40);
    assert.equal(f.records.get(12).item.items[0].quantity,quantity);assert.equal(f.records.get(12).item.items[0].rate,5);
    assert.equal(f.writes.length,count);
  }),{seed:20260929,numRuns:80});
});


test('a quantity adjustment updates the PO vendor summary from its own percentages without changing gross costs or identities', async () => {
  const f=restFixture();
  const po=f.records.get(12);
  po.memo='MBBS-SPECIAL-PO:9';
  po.item.items.push({line:2,lineUniqueKey:'202',item:{id:'4981'},quantity:1,rate:-25,description:'Vendor discount | MBBS-SPECIAL-PO:9',location:{id:'1'},taxCode:{id:'11'}});
  const orders=[{id:12,kind:'purchase_order',vendorDiscountTotal:{before:25,after:10},lines:[{remoteLineId:201,itemId:2055,quantity:50,toQuantity:20,rate:5,unitId:865,description:'Reviewed material'}]}];
  const plan=await prepareSpecialRestAdjustmentPlan({orders},f);
  assert.deepEqual(plan.orders[0].target.lines.map(l=>[l.remoteLineId,l.quantity,l.rate]),[[201,20,'5'],[202,1,'-10']]);
  await applySpecialAdjustmentPlan(plan,createSpecialRestOrderBoundary(f));
  await applySpecialAdjustmentPlan(plan,createSpecialRestOrderBoundary(f));
  assert.equal(f.writes.length,1);
  assert.deepEqual(f.records.get(12).item.items.map(l=>[l.line,l.lineUniqueKey,l.quantity,l.rate]),[[1,'201',20,5],[2,'202',1,-10]]);
  orders[0].vendorDiscountTotal.before=99;
  await assert.rejects(prepareSpecialRestAdjustmentPlan({orders},f),{code:'SPECIAL_ADJUSTMENT_CONFLICT'});
});

test('a changed or missing vendor summary blocks quantity updates before any write',async()=>{
  for(const scenario of ['changed','missing','duplicate','foreign','invalid-target']){
    const f=restFixture(),po=f.records.get(12);
    const discount={line:2,lineUniqueKey:'202',item:{id:'4981'},quantity:1,rate:scenario==='changed'?-24:-25,description:scenario==='foreign'?'Unreviewed':'Vendor discount | MBBS-SPECIAL-PO:9',location:{id:'1'}};
    if(scenario!=='missing')po.item.items.push(discount);
    if(scenario==='duplicate')po.item.items.push({...discount,line:3,lineUniqueKey:'203'});
    const orders=[{...f.orders[1],vendorDiscountTotal:{before:25,after:scenario==='invalid-target'?-1:10},lines:[{...f.orders[1].lines[0],toQuantity:20}]}];
    await assert.rejects(prepareSpecialRestAdjustmentPlan({orders},f),{code:'SPECIAL_ADJUSTMENT_CONFLICT'});assert.equal(f.writes.length,0);
  }
});

test('material packaging fields survive later quantity and discount adjustments',async()=>{
 const f=restFixture();Object.assign(f.records.get(11).item.items[0],{custcol_plt:1,custcol_lyr:2,custcol_sec:3,custcol_pcs:4});
 const plan=await prepareSpecialRestAdjustmentPlan({orders:f.orders},f);
 await applySpecialAdjustmentPlan(plan,f.boundary);
 const line=f.records.get(11).item.items.find(row=>row.item.id==='2055');assert.deepEqual([line.custcol_plt,line.custcol_lyr,line.custcol_sec,line.custcol_pcs],[1,2,3,4]);
});
