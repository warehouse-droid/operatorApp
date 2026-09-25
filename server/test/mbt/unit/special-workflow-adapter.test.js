import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSpecialUnits, synchronizeSpecialDescriptions } from '../../../src/special-stock-netsuite-adapter.js';
import { nextReminderDate, reminderDate, torontoDate, specialStage, parseStages } from '../../../public/special-stock-workflow.js';
import { dispatchOrderPalletQuantity } from '../../../src/dispatch-special-order-pallets.js';
import { projectSpecialStockCase } from '../../../src/special-stock-request-policy.js';
import fc from 'fast-check';

function fixture({ corrupt = false, conflict = false, partialFailure = false } = {}) {
  const items = [
    { line: 1, item: {id:2055}, units: {id:1}, quantity: 10, description: 'A', rate: 12 },
    { line: 4, item: {id:2055}, units: {id:1}, quantity: 20, description: conflict ? 'OTHER EDIT' : 'B', rate: 24 },
    { line: 5, item: {id:1784}, units: {id:3}, quantity: 3, description: 'PALLET', rate: 35 }
  ];
  const calls = [];
  let failOnce = partialFailure;
  return {
    items, calls,
    changes: [{ caseLineId: 2, remoteLineId: 987, itemId:2055, quantity:20, unitId:1, previousDescription:'B', description:'Revised B' }],
    dependencies: {
      queryAll: async () => [{ uniquekey:987, rest_line_id:4, item:2055 }],
      rest: async (path, options={}) => {
        if (options.method === 'PATCH') {
          calls.push({path,...options});
          for (const patch of options.body.item.items) items.find(line => line.line === patch.line).description = patch.description;
          if (corrupt) items[0].rate = 999;
          if (failOnce) { failOnce=false; throw new Error('Response lost after patch'); }
        }
        return {data:{item:{items:structuredClone(items)}}};
      }
    }
  };
}
test('repeated item IDs use the unique SO line key and preserve all other values', async () => {
  const f=fixture(); await synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},f.dependencies);
  assert.deepEqual(f.calls[0].body, { item:{items:[{line:4,description:'Revised B'}]} });
  assert.equal(f.calls[0].path.includes('replace'),false);
  assert.equal(f.items[0].description,'A'); assert.equal(f.items[2].quantity,3);
  assert.equal(f.items[1].rate,24); assert.equal(f.items[1].quantity,20);
});
test('external conflicting edit stops before PATCH', async () => {
  const f=fixture({conflict:true}); await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},f.dependencies),/changed in NetSuite/);
  assert.equal(f.calls.length,0);
});
test('verification detects unrelated price changes', async () => {
  const f=fixture({corrupt:true}); await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},f.dependencies),/verification failed/);
});
test('retry recognizes a successful patch whose response was lost', async () => {
  const f=fixture({partialFailure:true});
  await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},f.dependencies),/Response lost/);
  await synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},f.dependencies);
  assert.equal(f.calls.length,1);
});
test('UOM resolves through the item units type, without implicit conversion', async () => {
  const deps={ queryAll:async()=>[{unitstype:353}],rest:async()=>({data:{uom:{items:[{internalId:91,abbreviation:'PC',unitName:'Piece'},{internalId:92,abbreviation:'SQFT'}]}}}) };
  const result=await resolveSpecialUnits([{itemId:2055,uom:'PC',quantity:10}],deps);
  assert.equal(result[0].unitId,91); assert.equal(result[0].quantity,10);
  await assert.rejects(resolveSpecialUnits([{itemId:2055,uom:'PLT'}],deps),/native NetSuite UOM/);
});
test('zero pallets remains zero for large Special quantities and cost privacy is recursive', () => {
  assert.equal(dispatchOrderPalletQuantity({specialPalletTotal:0,items:[{itemId:2055,quantity:9000}],fallbackSalesQuantity:9000,reportedPallets:20}),0);
  const timestamp=new Date('2026-09-24T12:00:00Z');
  const projected=projectSpecialStockCase({createdAt:timestamp,lines:[],purchaseOrderLines:[{unitPurchaseCost:4}],events:[{details:{scmInternalNote:'private'}}]},'sales');
  assert.equal(projected.createdAt.toISOString(),timestamp.toISOString());
  assert.equal(JSON.stringify(projected).includes('private'),false);
  assert.equal(JSON.stringify(projected).includes('unitPurchaseCost'),false);
});
test('Toronto dates and weekend reminder boundaries are explicit', () => {
  assert.equal(torontoDate(new Date('2026-09-25T02:00:00Z')),'2026-09-24');
  assert.equal(reminderDate('2026-09-28'),'2026-09-23');
  assert.equal(reminderDate('2026-09-27'),'2026-09-23');
  assert.throws(()=>parseStages('attention'),/supported/);
});
test('property: postponement cannot hide a due alert, readiness clears it, and waiting dominates order stages', () => {
  fc.assert(fc.property(fc.integer({min:1,max:28}),fc.boolean(),fc.boolean(),(day,so,po)=>{
    const due=`2026-09-${String(day).padStart(2,'0')}`;
    assert.equal(nextReminderDate({previousDue:due,eta:'2099-10-01',ready:false,today:'2026-09-30'}),due);
    assert.equal(nextReminderDate({previousDue:due,eta:'2099-10-01',ready:true,today:'2026-09-30'}),null);
    assert.equal(specialStage({waitingForProduction:true,salesOrderId:so?1:null,purchaseOrderId:po?2:null}),'wait_for_production');
  }),{seed:24092026,numRuns:200});
});

test('ambiguous repeated item lines must not acquire an arbitrary SO identity', async () => {
  const { matchSpecialOrderCoverage } = await import('../../../src/special-stock-request-domain.js');
  const expected=[{id:1,itemId:2055,description:'Identical',quantity:10,uom:'PC'},{id:2,itemId:2055,description:'Identical',quantity:10,uom:'PC'}];
  const actual=[{id:81,lineId:901,itemId:2055,description:'Identical',quantity:10,uom:'PC'},{id:82,lineId:902,itemId:2055,description:'Identical',quantity:10,uom:'PC'}];
  assert.throws(()=>matchSpecialOrderCoverage(expected,actual),error=>error.code==='SPECIAL_ORDER_LINE_AMBIGUOUS');
  assert.deepEqual(matchSpecialOrderCoverage([{...expected[0],remoteLineId:902},{...expected[1],remoteLineId:901}],actual).map(row=>row.remoteLineId),[902,901]);
});

test('boundary refuses missing metadata and invalid or conflicting remote line identities', async () => {
  await assert.rejects(resolveSpecialUnits([{itemId:0,uom:'PC',quantity:1}],{queryAll:async()=>[],rest:async()=>({})}),/identity/);
  for(const rows of [[],[{}]]) await assert.rejects(resolveSpecialUnits([{itemId:2055,uom:'PC',quantity:1}],{queryAll:async()=>rows,rest:async()=>({})}),/units type/);
  await assert.rejects(resolveSpecialUnits([{itemId:2055,uom:'PC',quantity:1}],{queryAll:async()=>[{unitstype:1}],rest:async()=>({})}),/native NetSuite UOM/);
  const cached=await resolveSpecialUnits([{itemId:2055,uom:'Piece',quantity:1},{itemId:2055,uom:'PC',quantity:2}],{queryAll:async()=>[{unitstype:1}],rest:async()=>({data:{uom:{items:[{id:3,abbreviation:'PC',unitName:'Piece'}]}}})});
  assert.deepEqual(cached.map(line=>line.unitId),[3,3]);
  const empty=fixture(); await synchronizeSpecialDescriptions({salesOrderId:77,changes:[]},empty.dependencies);
  await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:[...empty.changes,...empty.changes]},empty.dependencies),/distinct/);
  for(const identities of [[],[{uniquekey:987,rest_line_id:4,item:1784}]]) {
    const f=fixture();await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},{...f.dependencies,queryAll:async()=>identities}),/exact linked/);
  }
  const missing=fixture();await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:missing.changes},{...missing.dependencies,rest:async()=>({})}),/could not be read/);
  for(const patch of [{quantity:999},{units:{id:99}},{item:{id:1784}}]) {
    const f=fixture();Object.assign(f.items[1],patch);await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},f.dependencies),/changed in NetSuite/);
  }
  const f=fixture();let calls=0;const rest=f.dependencies.rest;
  await assert.rejects(synchronizeSpecialDescriptions({salesOrderId:77,changes:f.changes},{...f.dependencies,rest:async(...args)=>{
    calls++; const result=await rest(...args);return calls===3?{data:{item:{items:[]}}}:result;
  }}),/verification failed/);
});
test('the filter exposes seven labelled choices, retains multiple selections and allows clearing', async () => {
  const {stageFilterHtml}=await import('../../../public/special-stock-workflow.js');
  const html=stageFilterHtml(['new_enquiry','completed']);
  assert.equal((html.match(/type="checkbox"/g)||[]).length,7);
  assert.equal((html.match(/checked/g)||[]).length,2);
  assert.match(html,/Clear selection/);assert.match(stageFilterHtml(''),/All/);
  assert.deepEqual(parseStages(['confirmed','confirmed']),['confirmed']);
  assert.deepEqual(parseStages(null),[]);
});
