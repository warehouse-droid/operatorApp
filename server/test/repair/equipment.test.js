import {startedAction} from './fixture.js';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createRepairRepository} from '../../src/repair/repository.js';
import {createRepairDirectory} from '../../src/repair/directory.js';
import {createRepairOperations} from '../../src/repair/operations.js';
import {assertRepairVehicleAvailable} from '../../src/repair/guards.js';
import {canApprove} from '../../public/repair/domain.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');after(closeDb);
const repo=createRepairRepository(),office={id:'equipment-office',role:'repair_office'},tech={id:'equipment-tech',role:'repair_technician'},operator={id:'equipment-operator',role:'operator',operatorYardLocationIds:[1]},dispatch={id:'equipment-dispatch',role:'dispatcher'},control={id:'equipment-control',role:'yard_manager',yardLocationIds:[1]};
const command=job=>({commandId:randomUUID(),revision:job.revision});
const scenario=fn=>withTransaction(fn,{rollback:true});
async function vehicle(type='forklift',company='MBBS',customer='7000'){
 const id=randomUUID();await query('INSERT INTO repair_vehicles(id,company,customer_id,plate,alias,data) VALUES($1,$2,$3,$4,$5,$6)',[id,company,customer,id.slice(0,8),'Equipment selection test',{equipmentType:type,netSuiteVehicleType:type==='unknown'?'#':type}]);return id;
}
const intake=async(id,input={})=>repo.create(operator,{commandId:randomUUID(),vehicleId:id,yardId:1,meter:'100',meterUnit:'hours',defect:'Hydraulic leak',condition:'out_of_service',...input});
const correct=(actor,job,id,type='forklift',extra={})=>repo.action(actor,job.id,{...command(job),action:'equipment',vehicleId:id,equipmentType:type,yardId:1,reason:'Checked machine number at repair centre',...extra});
test('NetSuite explicit types survive import; ambiguous models are never inferred from company or plate',()=>scenario(async()=>{
 const labels=['Forklift','Bin Truck','Track Loader','#','ER655','Moffett','Trailer'];const start=Date.now();
 const directory=createRepairDirectory({repo,adapter:{vehicles:async()=>labels.map((label,i)=>({id:String(start+i),customer_id:'7973',plate:'TRUCK-'+i,alias:'Forklift '+i,vehicle_type:label})),machines:async()=>[]},postingEnabled:()=>false});
 await directory.sync(office);const rows=(await query('SELECT data FROM repair_vehicles WHERE netsuite_id BETWEEN $1 AND $2 ORDER BY netsuite_id',[start,start+labels.length-1])).rows;
 assert.deepEqual(rows.map(r=>r.data.equipmentType),['forklift','truck','loader','unknown','unknown','unknown','unknown']);assert.deepEqual(rows.map(r=>r.data.netSuiteVehicleType),labels);
}));
test('requester selection captures type; unverified suggestions wait for office or repair confirmation',()=>scenario(async()=>{
 const id=await vehicle('unknown');let job=await intake(id,{equipmentType:'forklift'});
 assert.equal(job.data.equipmentType,'forklift');assert.equal(job.data.equipmentTypeConfirmed,false);
 job=await startedAction(repo,tech,job.id,{...command(job),action:'inspection_complete',done:'Inspected the selected machine'});
 await assert.rejects(repo.quote(office,job.id,{...command(job),lines:[{id:'a',kind:'labor',description:'Repair',quantity:'1',unitPrice:'100'}]}),/type.*confirm|confirm.*type/i);
 job=await correct(office,job,id);assert.equal(job.data.equipmentTypeConfirmed,true);assert.equal(job.data.inspectionComplete,true);
 assert.equal((await repo.get(office,job.id)).inspectionFeeMinor,15000);
}));
test('equipment type routes internal quotes independently of company or requester role',()=>{
 const job={company:'MBBS',yardId:1,data:{equipmentType:'truck',equipmentTypeConfirmed:true}};
 assert.equal(canApprove(dispatch,job),true);assert.equal(canApprove(control,job),false);
 const machine={...job,company:'MBT',data:{equipmentType:'forklift',equipmentTypeConfirmed:true}};
 assert.equal(canApprove(dispatch,machine),false);assert.equal(canApprove(control,machine),true);
 assert.equal(canApprove({...control,yardLocationIds:[28]},machine),false);
 assert.equal(canApprove(dispatch,{...job,data:{equipmentType:'truck',equipmentTypeConfirmed:false}}),false);
 assert.equal(canApprove(control,{...job,data:{equipmentType:'unknown',equipmentTypeConfirmed:true}}),false);
});
test('correction moves the hold and audits old/new equipment without another inspection charge',()=>scenario(async()=>{
 const first=await vehicle(),second=await vehicle('loader');let job=await intake(first);const input={...command(job),action:'equipment',vehicleId:second,equipmentType:'loader',yardId:1,reason:'Requester selected the neighbouring machine'};
 job=await repo.action(tech,job.id,input);assert.equal(job.vehicleId,second);assert.equal(job.data.vehicle.id,second);assert.equal(job.data.equipmentType,'loader');assert.equal(job.status,'re_inspect');
 assert.equal((await repo.action(tech,job.id,input)).revision,job.revision);
 await assertRepairVehicleAvailable({vehicleId:first,enabled:true});await assert.rejects(assertRepairVehicleAvailable({vehicleId:second,enabled:true}),error=>error.code==='REPAIR_OUT_OF_SERVICE');
 const changed=(await query("SELECT actor,data FROM repair_events WHERE request_id=$1 AND kind='equipment_corrected'",[job.id])).rows[0];assert.equal(changed.actor,'staff:equipment-tech');assert.equal(changed.data.previous.vehicleId,first);assert.equal(changed.data.current.vehicleId,second);assert.equal(changed.data.reason,input.reason);
 assert.equal(job.data.originalEquipment.vehicleId,first);assert.equal((await repo.get(office,job.id)).inspectionFeeMinor,15000);assert.equal((await query("SELECT count(*) FROM repair_postings WHERE request_id=$1 AND kind='inspection'",[job.id])).rows[0].count,'1');
 await intake(first);await correct(office,job,first);await assert.rejects(assertRepairVehicleAvailable({vehicleId:first,enabled:true}),/out of service/);
}));
test('equipment corrections require staff authority, reason, revision and the same billing owner',()=>scenario(async()=>{
 const first=await vehicle(),second=await vehicle(),foreign=await vehicle('forklift','MBBS','9999');const job=await intake(first);
 await assert.rejects(correct(operator,job,second),error=>error.status===403);await assert.rejects(correct(dispatch,job,second),error=>error.status===403);
 await assert.rejects(correct(office,job,second,'forklift',{reason:''}),/reason/i);
 await assert.rejects(correct(office,job,foreign),/billing|company/i);
 await assert.rejects(correct(office,job,second,'forklift',{revision:0}),error=>error.code==='REPAIR_STALE');
 assert.equal((await repo.get(office,job.id)).vehicleId,first);
}));
test('corrected equipment invalidates accepted scope and needs a fresh inspection and approval',()=>scenario(async()=>{
 const first=await vehicle(),second=await vehicle('loader');let job=await intake(first);job=await startedAction(repo,tech,job.id,{...command(job),action:'inspection_complete',done:'Initial diagnosis'});
 const quote=await repo.quote(office,job.id,{...command(job),lines:[{id:'a',kind:'labor',description:'Repair',quantity:'1',unitPrice:'100'}]});await repo.decide(control,job.id,{commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'a',status:'approved'}]});job=await repo.get(office,job.id);
 job=await correct(office,job,second,'loader');assert.equal(job.data.inspectionComplete,false);assert.equal((await repo.quoteHistory(office,job.id))[0].status,'superseded');
 await assert.rejects(repo.action(tech,job.id,{...command(job),action:'start_repair'}),/approved/);await assert.rejects(repo.decide(control,job.id,{commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'a',status:'approved'}]}),/no longer|access/);
}));
test('in-flight posting blocks correction; attempted external identities require reconciliation',()=>scenario(async()=>{
 const first=await vehicle(),second=await vehicle();let job=await intake(first);
 await query("UPDATE repair_postings SET state='working',attempt=1 WHERE request_id=$1",[job.id]);await assert.rejects(correct(tech,job,second),/posting.*progress|posting.*active/i);assert.equal((await repo.get(office,job.id)).vehicleId,first);
 await query("UPDATE repair_postings SET state='uncertain' WHERE request_id=$1",[job.id]);job=await correct(office,job,second);assert.equal(job.data.equipmentReconciliation,true);
 const posting=(await query('SELECT * FROM repair_postings WHERE request_id=$1',[job.id])).rows[0];assert.equal(posting.state,'attention');
 const operations=createRepairOperations({repo,adapter:{}});await assert.rejects(operations.retry(office,posting.id,{reason:'Retry'}),/equipment.*reconcil|reconcil.*equipment/i);
}));
