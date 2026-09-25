import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageNetSuite} from '../src/inventory-damage-netsuite.js';
const locations=[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}];
const transfer={id:998187,tranId:'IT00551',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[{line:1}],totalResults:1}};
test('D5/D6: actual adapter appends without replace and marks post-write readback errors',async()=>{
  const calls=[];
  const remote=createDamageNetSuite({directory:async()=>locations,sql:async()=>[],rest:async(path,options)=>{
    calls.push({path,options});
    if(options?.method==='POST')return {id:998187};
    if(options?.method==='PATCH')return {status:204};
    throw Object.assign(new Error('readback denied'),{status:403,netsuiteResponseReceived:true});
  }});
  await remote.append(998187,{item:{id:'1256'},adjustQtyBy:3,units:'191'});
  assert.equal(calls[0].path,'/998187');assert.equal(calls[0].options.method,'PATCH');
  assert.deepEqual(calls[0].options.body,{inventory:{items:[{item:{id:'1256'},adjustQtyBy:3,units:'191'}]}});
  await assert.rejects(remote.create({externalId:'mbbs-damage-1-2026-09'}),{status:403,damageWriteAcknowledged:true});
});
test('D7: adapter filters history by memo month and exact locations, labels units, resolves identity',async()=>{
  const remote=createDamageNetSuite({directory:async()=>locations,sql:async statement=>{
    if(statement.includes('tl.units'))return [{unit_id:191,unit:'PC'}];
    if(statement.includes('externalid='))return [{id:998187}];
    return [{id:998187,memo:'3445 2026 Sep Damage'},{id:7,memo:'2967 2026 Sep Damage'},{id:8,memo:'3445 2026 June Damage'}];
  },rest:async path=>({data:path.startsWith('/7?')?{...transfer,location:{id:'28'}}:transfer})});
  assert.equal((await remote.findMonthly({locationId:1,month:'2026-09'})).length,1);
  assert.equal((await remote.findExternal('mbbs-damage-1-2026-09')).id,998187);
  assert.equal((await remote.units(transfer))['191'],'PC');
  await assert.rejects(remote.findExternal("x' OR 1=1"));
});
test('D6: incomplete expanded transfer lines must block writing',async()=>{
  const remote=createDamageNetSuite({rest:async()=>({data:{...transfer,inventory:{items:[{line:1}],totalResults:2}}})});
  await assert.rejects(remote.get(998187),/complete transfer/i);
});
test('D5/D6: missing creation Location header reconciles identity; duplicate identity is rejected',async()=>{
  const remote=createDamageNetSuite({sql:async()=>[{id:998187}],rest:async(_path,options)=>options?.method==='POST'?{id:null}:{data:transfer}});
  assert.equal((await remote.create({externalId:'mbbs-damage-1-2026-09'})).id,998187);
  const absent=createDamageNetSuite({sql:async()=>[]});assert.equal(await absent.findExternal('mbbs-damage-1-2026-09'),null);
  const duplicate=createDamageNetSuite({sql:async()=>[{id:1},{id:2}]});await assert.rejects(duplicate.findExternal('mbbs-damage-1-2026-09'),{status:409});
});
