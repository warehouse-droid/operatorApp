import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createRepairRepository} from '../../src/repair/repository.js';
import {createRepairDirectory} from '../../src/repair/directory.js';
import {createRepairNetSuite} from '../../src/repair/netsuite.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');after(closeDb);
const office={id:'master-office',role:'repair_office'},operator={id:'master-operator',role:'operator'},driver={id:'master-driver',role:'driver'};
const repo=createRepairRepository(),scenario=fn=>withTransaction(fn,{rollback:true});
function fixture(){
 const start=Date.now()+Math.floor(Math.random()*1000000),vehicles=[{id:start,name:'VEH-LINK',customer_id:'13366',plate:'LINK-PLATE',alias:'Linked loader',serial:'MATCH-SERIAL',item_id:'4001',vehicle_type:'Loader',isinactive:'F'},{id:start+1,name:'VEH-YARD',customer_id:'7143',alias:'Yard forklift',serial:'YARD-SERIAL',vehicle_type:'Forklift',isinactive:'F'}],machines=[{id:start,name:'MC-LINK',alias:'LINK-CODE',serial:'MATCH-SERIAL',item_id:'4001',subsidiary_id:'7',isinactive:'F'},{id:start+1,name:'MC-STANDALONE',alias:'NEW-MACHINE-CODE',serial:'UNLINKED-SERIAL',subsidiary_id:'7',renter_id:'9999',isinactive:'F'},{id:start+2,name:'MC-INACTIVE',alias:'Retired machine',subsidiary_id:'7',isinactive:'T'}];
 const calls={vehicles:0,machines:0,creates:[]};const remote=new Map();let failAfterWrite=false;
 const adapter={vehicles:async()=>{calls.vehicles++;return vehicles;},machines:async()=>{calls.machines++;return machines;},read:async(type,id)=>type==='customer'?{id:String(id),companyName:'Verified customer'}:null,
  create:async(type,payload)=>{const key=type+payload.externalId;if(!remote.has(key)){calls.creates.push({type,payload});remote.set(key,{id:String(start+100+remote.size),name:type==='customrecord240'?'VEH-CREATED':'MC-CREATED',...structuredClone(payload)});}if(failAfterWrite){failAfterWrite=false;throw new Error('Response lost after NetSuite saved');}return remote.get(key);}};
 return {start,vehicles,machines,calls,adapter,directory:createRepairDirectory({adapter,repo,enabled:()=>true}),loseResponse(){failAfterWrite=true;}};
}
test('NetSuite master sync supplies cached machine searches by code, name and serial',()=>scenario(async()=>{
 const f=fixture();await f.directory.sync(office);for(const search of ['NEW-MACHINE-CODE','MC-STANDALONE','UNLINKED-SERIAL']){
  const rows=await f.directory.search(office,search);assert.equal(rows.length,1);assert.equal(rows[0].machineId,String(f.start+1));assert.equal(rows[0].netsuiteId,null);assert.equal(rows[0].company,'MBR');assert.equal(rows[0].customerId,'13366','rental customer must not become the machine owner');
 }
 assert.deepEqual([f.calls.vehicles,f.calls.machines],[1,1]);assert.equal((await f.directory.search(office,'MC-INACTIVE')).length,0);
 const linked=await f.directory.search(office,'LINK-CODE');assert.equal(linked.length,1);assert.equal(linked[0].netsuiteId,String(f.start));
 assert.equal((await f.directory.search(operator,'Yard forklift')).length,1);assert.equal((await f.directory.search(driver,'Yard forklift')).length,0);
}));
test('NetSuite directory refresh coalesces concurrent syncs and does not link missing item numbers',()=>scenario(async()=>{
 const f=fixture();f.vehicles.push({id:f.start+9,name:'VEH-NO-ITEM',customer_id:'13366',alias:'No item',isinactive:'F'});
 await Promise.all([f.directory.sync(office),f.directory.sync(office)]);
 assert.equal(f.calls.vehicles,1);assert.equal(f.calls.machines,1);assert.equal((await f.directory.search(office,'MC-STANDALONE'))[0].netsuiteId,null);
 await f.directory.sync(office);assert.equal((await query('SELECT count(*) FROM repair_vehicles WHERE machine_id=$1 AND netsuite_id IS NULL',[f.start+1])).rows[0].count,'1');
}));
test('NetSuite directory refresh preserves an existing machine request identity when its Vehicle Master appears',()=>scenario(async()=>{
 const f=fixture();await f.directory.sync(office);const machine=(await f.directory.search(office,'MC-STANDALONE'))[0];
 f.vehicles.push({id:f.start+10,name:'VEH-LATER',customer_id:'13366',alias:'Later vehicle',serial:'UNLINKED-SERIAL',isinactive:'F'});
 await f.directory.sync(office);const rows=await f.directory.search(office,'MC-STANDALONE');assert.equal(rows.length,1);assert.equal(rows[0].id,machine.id);assert.equal(rows[0].netsuiteId,String(f.start+10));
}));
test('office creates the selected NetSuite master while financial posting is disabled and replays safely',()=>scenario(async()=>{
 for(const recordType of ['vehicle','machine']){
  const f=fixture(),input={commandId:randomUUID(),recordType,company:recordType==='machine'?'MBR':'MBBS',customerId:recordType==='machine'?'13366':'7143',alias:'Created equipment '+recordType,serial:'NEW-SERIAL',plate:recordType==='vehicle'?'NEW-PLATE':'',equipmentType:'forklift'};
  const first=await f.directory.register(office,input),replay=await f.directory.register(office,input);assert.deepEqual(replay,first);assert.equal(f.calls.creates.length,1);
  const sent=f.calls.creates[0];assert.equal(sent.type,recordType==='machine'?'customrecord_mrb_machine_master':'customrecord240');assert.equal(sent.payload[recordType==='machine'?'custrecord2':'custrecord70'],'NEW-SERIAL');assert.equal(sent.payload[recordType==='machine'?'custrecord50':'custrecord78'],input.alias);
  assert.equal(sent.payload.custrecord9,undefined,'do not set a renter as machine owner');assert.equal(first.recordType,recordType);
  const rows=await repo.vehicles(office,input.alias);assert.equal(rows.length,1);assert.equal(rows[0].equipmentType,'forklift');
  await assert.rejects(f.directory.register(office,{...input,alias:'Different equipment'}),/different content|already/i);assert.equal(f.calls.creates.length,1);
 }
}));
test('lost master-create response is reconciled by external identity and changed retry content cannot create another master',()=>scenario(async()=>{
 const f=fixture(),input={commandId:randomUUID(),recordType:'machine',company:'MBR',alias:'Recover machine',serial:'RECOVER-SERIAL',equipmentType:'loader'};f.loseResponse();
 await assert.rejects(f.directory.register(office,input),/Response lost/);
 await assert.rejects(f.directory.register(office,{...input,serial:'DIFFERENT-SERIAL'}),/identity|different|match/i);
 await assert.rejects(f.directory.register(office,{...input,recordType:'vehicle',customerId:'13366'}),/different/i);
 const result=await f.directory.register(office,input);assert.ok(result.netsuiteId);assert.equal(f.calls.creates.length,1);
}));
test('master creation rejects requester roles, disabled Repair and mismatched vehicle owners before remote writes',()=>scenario(async()=>{
 const f=fixture(),input={commandId:randomUUID(),recordType:'vehicle',company:'MBT',customerId:'7143',alias:'Denied vehicle',equipmentType:'truck'};
 await assert.rejects(f.directory.register(operator,input),error=>error.status===403);
 await assert.rejects(f.directory.register(office,input),/customer|company|owner/i);
 const disabled=createRepairDirectory({adapter:f.adapter,repo,enabled:()=>false});await assert.rejects(disabled.register(office,input),error=>error.status===409);
 await assert.rejects(f.directory.register(office,{...input,recordType:'machine',company:'EXTERNAL'}),/MBR|rental/i);assert.equal(f.calls.creates.length,0);
}));
test('NetSuite master read queries include source names, active state and machine subsidiary',async()=>{
 const queries=[],adapter=createRepairNetSuite({queryAll:async q=>{queries.push(q);return [];},record:async()=>{throw new Error('Unexpected record write');}});await adapter.vehicles();await adapter.machines();
 assert.match(queries[1],/custrecord30 AS subsidiary_id/i);assert.match(queries[1],/isinactive/i);assert.match(queries[0],/altname/i);
});
test('concurrent master-create retries share one persisted command and one NetSuite creation',async()=>{
 const f=fixture(),input={commandId:randomUUID(),recordType:'machine',company:'MBR',alias:'Concurrent '+randomUUID(),serial:randomUUID(),equipmentType:'loader'};
 const [a,b]=await Promise.all([f.directory.register(office,input),f.directory.register(office,input)]);assert.deepEqual(a,b);assert.equal(f.calls.creates.length,1);
});
