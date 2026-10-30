import assert from 'node:assert/strict';
import test from 'node:test';
import { createStockExchangeNetSuite } from '../../../src/stock-exchange-netsuite.js';
import { exchangeProof, confirmedExchangeLines, verifyExchangeTransfer } from '../../../src/stock-exchange-proof.js';

const line={item:{id:'123'},adjustQtyBy:2,units:'3',custcol_atlas_rc_so:{id:'5'},custcol_position:'SOB123'};
const intent={externalId:'mbbs-exchange-1-2026-10',memo:'3445 2026 Oct Exchange',month:'2026-10',lines:[line]};
const transfer={id:101,tranId:'IT101',externalId:intent.externalId,memo:intent.memo,tranDate:'2026-10-29',
  location:{id:'1'},transferLocation:{id:'9'},inventory:{items:[{...line,line:1}]}};
test('transfer adapter creates and appends through Inventory Transfer REST without replacing existing lines',async()=>{
  const calls=[];const remote=createStockExchangeNetSuite({
    rest:async(path,options={})=>{calls.push({path,...options});return options.method==='POST'?{id:101}:{data:structuredClone(transfer)};},
    sql:async()=>[{id:101}],directory:async()=>[{id:1,subsidiary:1},{id:9,parent:1,name:'3445 Return'}]
  });
  assert.equal((await remote.create({externalId:intent.externalId,inventory:{items:[line]}})).id,101);
  await remote.append(101,[line]);
  assert.deepEqual(calls.at(-1),{path:'/101',method:'PATCH',body:{inventory:{items:[line]}}});
  assert.ok(calls.every(call=>!call.path.includes('replace')));
  assert.equal((await remote.findExternal(intent.externalId)).id,101);
  assert.equal((await remote.findMonthly({locationId:1,month:'2026-10'})).length,1);
  await assert.rejects(remote.findExternal("bad' OR 1=1"),/identity/);
});
test('adapter rejects incomplete readback, wrong IDs and duplicate external identities',async()=>{
  const remote=createStockExchangeNetSuite({rest:async()=>({data:{...transfer,inventory:{items:[],hasMore:true}}}),sql:async()=>[{id:1},{id:2}]});
  await assert.rejects(remote.get(101),/complete/);
  await assert.rejects(remote.get(102),/identity/);
  await assert.rejects(remote.findExternal(intent.externalId),/Multiple/);
});
test('posting proof preserves old rows and verifies exact additions with repeated SKU/reason combinations',()=>{
  const before=structuredClone(transfer),proof=exchangeProof(before),after=structuredClone(before);
  after.inventory.items.push({...line,line:2});
  verifyExchangeTransfer(after,intent,{sourceId:1,destinationId:9});
  assert.equal(confirmedExchangeLines(after,intent,proof)[0].line,2);
  assert.equal(confirmedExchangeLines(before,intent,proof),null);
  for(const field of ['adjustQtyBy','units','custcol_position']){
    const changed=structuredClone(after);changed.inventory.items[1][field]='wrong';
    assert.throws(()=>confirmedExchangeLines(changed,intent,proof),/differs/);
  }
  after.inventory.items[0].adjustQtyBy=10;
  assert.throws(()=>confirmedExchangeLines(after,intent,proof),/existing.*changed/);
  assert.throws(()=>confirmedExchangeLines({...before,inventory:{items:[]}},intent,proof),/missing/);
  assert.throws(()=>confirmedExchangeLines({...after,id:999},intent,proof),/identity/);
  assert.throws(()=>verifyExchangeTransfer({...before,tranDate:'2026-11-01'},intent,{sourceId:1,destinationId:9}),/date/);
  assert.throws(()=>verifyExchangeTransfer({...before,inventory:{items:[...before.inventory.items,...before.inventory.items]}},intent,{sourceId:1,destinationId:9}),/duplicated/);
});
