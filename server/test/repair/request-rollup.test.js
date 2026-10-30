import {startedAction} from './fixture.js';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createRepairRepository} from '../../src/repair/repository.js';
after(closeDb);const repo=createRepairRepository();const role=value=>({id:value,role:value,roles:[value]}),office=role('repair_office'),tech=role('repair_technician'),dispatch=role('dispatcher'),driver=role('driver');const cmd=revision=>({commandId:randomUUID(),revision});
test('requester receives the whole multi-job request using the child action revision',()=>withTransaction(async()=>{
 const vehicle=randomUUID();await query("INSERT INTO repair_vehicles(id,company,customer_id,alias,data) VALUES($1,'MBT','7973','Multi-job handover',$2)",[vehicle,{equipmentType:'truck'}]);
 let first=await repo.create(driver,{...cmd(),vehicleId:vehicle,meter:'1',meterUnit:'km',condition:'out_of_service',defect:'First issue'});first=await startedAction(repo,tech,first.id,{...cmd(first.revision),action:'inspection_complete',done:'Inspected'});
 const quote=async(job,id,mode)=>repo.quote(office,job.id,{...cmd(job.revision),mode,title:id,lines:[{id,kind:'labor',description:id,quantity:'1',unitPrice:'100'}]});const approve=async q=>{await repo.decide(dispatch,q.jobId,{...cmd(),quoteId:q.id,decisions:[{id:q.lines[0].id,status:'approved'}]});return repo.get(office,q.jobId);};
 first=await approve(await quote(first,'first','initial'));const second=await approve(await quote(first,'second','additional'));first=await startedAction(repo,tech,first.id,{...cmd(first.revision),action:'complete',done:'First job done'});
 const mixed={...driver,roles:['driver','admin']};let view=await repo.get(mixed,first.id,{requestView:true});assert.equal(view.number,first.requestNumber);assert.equal(view.status,'queuing');assert.equal(view.receipt,'none');assert.equal(view.revision,first.revision);assert.equal(view.workJobs.length,2);
 await startedAction(repo,tech,second.id,{...cmd(second.revision),action:'complete',done:'Second job done'});view=await repo.get(driver,first.id);assert.equal(view.receipt,'pending');assert.equal(view.number,first.requestNumber);assert.equal(view.revision,(await repo.get(office,first.id)).revision);assert.deepEqual(view.work.filter(w=>w.phase==='repair').map(w=>w.data.done).sort(),['First job done','Second job done']);
 const photo=await repo.addAttachment(driver,{requestId:first.id,kind:'handover',filename:'handover.png',mimeType:'image/png',byteSize:1,sha256:'0'.repeat(64),storageKey:'fixture-handover'});await repo.action(driver,first.id,{...cmd(view.revision),action:'receive',decision:'accepted',attachmentIds:[photo.id]});assert.equal((await repo.get(driver,first.id)).request.stage,'closed');assert.equal((await repo.list(driver,{mine:true,active:true})).some(r=>r.id===first.id),false);
},{rollback:true}));
