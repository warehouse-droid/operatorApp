import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageNetSuite} from '../src/inventory-damage-netsuite.js';
const locations=[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}];
const record=id=>({id,tranId:`IT${id}`,memo:'3445 2026 Oct Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[{line:1,units:'554'}],totalResults:1}});
test('S1: review overlaps independent reads and deduplicates transfer rows',async()=>{
  let directoryStarted=false,listStarted=false,sqlCalls=0,recordCalls=0;
  const remote=createDamageNetSuite({directory:async()=>{directoryStarted=true;await Promise.resolve();assert.equal(listStarted,true);return locations;},
    sql:async statement=>{sqlCalls++;listStarted=true;assert.match(statement,/memo LIKE '%2026-10%'/);assert.doesNotMatch(statement,/JOIN transactionline/);
      return [{id:1031838,memo:'3445 2026 Oct Damage',unit_id:'554',unit:'PC'},
        {id:1031838,memo:'3445 2026 Oct Damage',unit_id:'554',unit:'PC'}];},
    rest:async()=>{recordCalls++;return {data:record('1031838')};}});
  const records=await remote.findMonthly({locationId:1,month:'2026-10'});
  assert.equal(directoryStarted,true);assert.equal(records.length,1);
  assert.equal(recordCalls,1);assert.equal(sqlCalls,1);
});
test('S1: transfer reads start before the independent directory read completes',async()=>{
  let recordStarted=false;
  const remote=createDamageNetSuite({sql:async()=>[{id:1031838,memo:'3445 2026 Oct Damage'}],
    directory:async()=>{await new Promise(resolve=>setTimeout(resolve,20));assert.equal(recordStarted,true);return locations;},
    rest:async()=>{recordStarted=true;return {data:record('1031838')};}});
  assert.equal((await remote.findMonthly({locationId:1,month:'2026-10'})).length,1);
});
test('S1: transfer readback is bounded parallel and verifies exact destinations and month',async()=>{
  let active=0,max=0;
  const remote=createDamageNetSuite({directory:async()=>locations,
    sql:async()=>Array.from({length:8},(_,i)=>({id:i+1,memo:i===7?'3445 2026 Sep Damage':'3445 2026 Oct Damage'})),
    rest:async path=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,10));active--;
      const result=record(path.split('?')[0].slice(1));if(result.id==='6') result.transferLocation.id='11';return {data:result};}});
  const records=await remote.findMonthly({locationId:1,month:'2026-10'});
  assert.ok(max>1,'independent transfer reads should overlap');assert.ok(max<=3,'no more than three simultaneous reads');
  assert.equal(records.length,6);assert.ok(records.every(row=>row.transferLocation.id==='10'));
  await assert.rejects(remote.findMonthly({locationId:"1 OR 1=1",month:'2026-10'}));
  await assert.rejects(remote.findMonthly({locationId:1,month:"2026-10'"}));
});
test('S2: partial labels and direct reads retain the real unit-label query',async()=>{
  let unitQueries=0;
  const remote=createDamageNetSuite({directory:async()=>locations,sql:async statement=>{
    if(statement.includes('tl.units')) {unitQueries++;return [{unit_id:'554',unit:'PC'}];}
    return [{id:1031838,memo:'3445 2026 Oct Damage',unit_id:'191',unit:'wrong unit'}];
  },rest:async()=>({data:record('1031838')})});
  const records=await remote.findMonthly({locationId:1,month:'2026-10'});
  assert.deepEqual(await remote.units(records[0]),{'554':'PC'});
  assert.deepEqual(await remote.units(await remote.get(1031838)),{'554':'PC'});assert.equal(unitQueries,2);
});
test('S1: an early directory failure is handled while the transfer list is still loading',async()=>{
  const remote=createDamageNetSuite({directory:async()=>{throw new Error('Directory unavailable');},
    sql:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return [{id:1031838,memo:'3445 2026 Oct Damage'}];},
    rest:async()=>({data:record('1031838')})});
  await assert.rejects(remote.findMonthly({locationId:1,month:'2026-10'}),/Directory unavailable/);
});
