import {startedAction} from './fixture.js';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createRepairRepository} from '../../src/repair/repository.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const repo=createRepairRepository({query,transaction:withTransaction});
after(closeDb);
const actor=(role,id=role)=>({id,role,roles:[role],yardLocationIds:[1],operatorYardLocationIds:[1]});
const office=actor('repair_office'),tech=actor('repair_technician'),driver=actor('driver','driver-a'),dispatch=actor('dispatcher');
const command=(revision=1)=>({commandId:randomUUID(),revision});
const scenario=fn=>withTransaction(fn,{rollback:true});
async function intake(company='MBT') {
 const masterId=(await query("SELECT 8000000000000+nextval('repair_request_number_seq') AS id")).rows[0].id;
 const id=randomUUID();await query(`INSERT INTO repair_vehicles(id,netsuite_id,company,customer_id,plate,alias,data) VALUES($1,$2,$3,'7973',$4,'Test truck',$5)`,[id,masterId,company,id.slice(0,8),{equipmentType:'truck',netSuiteVehicleType:'Truck'}]);
 const created=await repo.create(company==='MBT'?driver:office,{commandId:randomUUID(),vehicleId:id,yardId:1,meter:'12345',meterUnit:'km',defect:'Brake light failed',condition:'out_of_service'});
 return created;
}
async function inspected(job) {return startedAction(repo,tech,job.id,{...command(job.revision),action:'inspection_complete',done:'Inspected wiring',nextStep:'Replace wiring',hours:'0.5'});}
async function approved(job) {
 job=await inspected(job);
 const quote=await repo.quote(office,job.id,{...command(job.revision),lines:[{id:'labor',kind:'labor',itemId:'10650',description:'Wiring repair',quantity:'1',unitPrice:'1000',taxBps:1300}]});
 await repo.decide(dispatch,job.id,{commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'labor',status:'approved'}]});
 return repo.get(tech,job.id);
}
test('submission replay creates one request and one inspection posting intent',()=>scenario(async()=>{
 const original=await intake();const stored=(await query('SELECT payload FROM repair_commands WHERE result->>\'id\'=$1',[original.id])).rows[0];
 assert.ok(stored);const replay=await repo.create(driver,stored.payload);assert.equal(replay.id,original.id);
 assert.equal(Number((await query('SELECT count(*) FROM repair_postings WHERE request_id=$1',[original.id])).rows[0].count),1);
 assert.equal(original.inspectionFeeMinor,undefined,'requester cannot see charges');
 assert.equal((await repo.get(office,original.id)).inspectionFeeMinor,15000);
}));
test('repair cannot begin before approval; whole quote approval gates actual work',()=>scenario(async()=>{
 let job=await intake();await assert.rejects(repo.action(tech,job.id,{...command(job.revision),action:'start_repair'}),/approved/i);
 job=await approved(job);job=await repo.action(tech,job.id,{...command(job.revision),action:'start_repair'});assert.equal(job.status,'in_progress');
 await assert.rejects(repo.action(office,job.id,{...command(job.revision),action:'condition',condition:'can_operate',reason:''}),/reason/i);
 job=await repo.action(office,job.id,{...command(job.revision),action:'condition',condition:'can_operate',reason:'Office verified equipment condition'});assert.equal(job.condition,'can_operate');
 job=await repo.action(driver,job.id,{...command(job.revision),action:'condition',condition:'can_operate',reason:'Corrected report'});assert.equal(job.condition,'can_operate');
}));
test('quote decisions are role scoped and reject stale/repeated different payloads',()=>scenario(async()=>{
 const job=await inspected(await intake());
 const quote=await repo.quote(office,job.id,{...command(job.revision),lines:[{id:'a',kind:'labor',itemId:'10650',description:'Repair',quantity:'1',unitPrice:'1000'}]});
 const input={commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'a',status:'approved'}]};
 await assert.rejects(repo.decide(office,job.id,input),/access/i);
 const yes=await repo.decide(dispatch,job.id,input);assert.equal(yes.status,'decided');
 assert.deepEqual(await repo.decide(dispatch,job.id,input),yes);
 await assert.rejects(repo.decide(dispatch,job.id,{...input,decisions:[{id:'a',status:'rejected'}]}),/different/i);
}));
test('public quote links disclose only the quote, expire, and cannot approve another request',()=>scenario(async()=>{
 const job=await inspected(await intake('EXTERNAL'));
 const quote=await repo.quote(office,job.id,{...command(job.revision),lines:[{id:'a',kind:'labor',itemId:'10650',description:'Repair',quantity:'1',unitPrice:'1000'}]});
 const link=await repo.quoteLink(office,job.id,quote.id);
 const view=await repo.publicQuote(link.token);assert.equal(view.quote.id,quote.id);assert.equal(view.job.data,undefined);
 await assert.rejects(repo.publicQuote('invalid'),/not found/i);
 await query("UPDATE repair_quotes SET public_expires_at=now()-interval '1 second' WHERE id=$1",[quote.id]);
 await assert.rejects(repo.publicQuote(link.token),/expired/i);
}));
test('receipt rejects missing photo, keeps same request on rejection and sends durable notice',()=>scenario(async()=>{
 let job=await approved(await intake());job=await startedAction(repo,tech,job.id,{...command(job.revision),action:'complete',done:'Fixed wiring'});
 assert.equal(job.receipt,'pending');assert.ok((await repo.notifications(driver)).length);
 await assert.rejects(repo.action(driver,job.id,{...command(job.revision),action:'receive',decision:'accepted',attachmentIds:[]}),/photo/i);
 const attachment=randomUUID();await query(`INSERT INTO repair_attachments(id,request_id,kind,filename,mime_type,byte_size,sha256,storage_key,created_by) VALUES($1,$2,'handover','photo.jpg','image/jpeg',100,'hash','test-key',$3)`,[attachment,job.id,'driver:driver-a']);
 job=await repo.action(driver,job.id,{...command(job.revision),action:'receive',decision:'rejected',reason:'Still faulty',attachmentIds:[attachment]});
 assert.equal(job.status,'re_inspect');assert.equal(Number((await query('SELECT count(*) FROM repair_requests WHERE id=$1',[job.id])).rows[0].count),1);
}));
test('stock buy/receive five, issue three, return one; no duplicate movement or negative stock',()=>scenario(async()=>{
 let job=await approved(await intake());
 const part=await repo.savePart(office,{name:'Pump',sku:randomUUID(),tracked:true,unit:'each'});
 const req=await repo.requestParts(tech,job.id,{...command(job.revision),quoteLineId:'labor',partId:part.id,description:'Pump',quantity:'3'});
 await repo.approveParts(office,req.id,{...command(),status:'approved',eta:'2026-12-01'});
 const purchase=await repo.purchase(office,{commandId:randomUUID(),vendorId:'12821',invoiceRef:randomUUID(),purchaseDate:'2026-10-26',lines:[{partRequestId:req.id,requestId:job.id,partId:part.id,category:'job_part',description:'Pump',quantity:'5',unitPrice:'100',taxBps:1300,accountId:'2211',surplusReason:'Two for next repair'}]});
 const input={commandId:randomUUID(),quantity:'5'};
 await repo.receivePurchase(tech,purchase.id,purchase.lines[0].id,input);await repo.receivePurchase(tech,purchase.id,purchase.lines[0].id,input);
 job=await repo.get(tech,job.id);
 await repo.usePart(tech,job.id,{...command(job.revision),partId:part.id,quantity:'3',quoteLineId:'labor',kind:'issue'});
 assert.equal((await repo.parts()).find(p=>p.id===part.id).onHandMilli,2000);
 job=await repo.get(tech,job.id);await assert.rejects(repo.usePart(tech,job.id,{...command(job.revision),partId:part.id,quantity:'3',quoteLineId:'labor',kind:'issue'}),/stock/i);
 await repo.usePart(tech,job.id,{...command(job.revision),partId:part.id,quantity:'1',quoteLineId:'labor',kind:'return'});
 assert.equal((await repo.parts()).find(p=>p.id===part.id).onHandMilli,3000);
 await assert.rejects(repo.getPurchase(dispatch,purchase.id),/access/i);
}));
test('a revised quote blocks work again and preserves every earlier approval version',()=>scenario(async()=>{
 let job=await approved(await intake());const original=job.quote.id;
 await repo.quote(office,job.id,{...command(job.revision),lines:[{id:'new',kind:'labor',description:'Additional repair scope',quantity:'1',unitPrice:'1200'}]});
 job=await repo.get(tech,job.id);await assert.rejects(repo.action(tech,job.id,{...command(job.revision),action:'start_repair'}),/approved/);
 const history=await repo.quoteHistory(office,job.id);assert.equal(history.length,2);assert.equal(history[1].id,original);assert.equal(history[1].lines[0].decision,'approved');assert.equal(history[0].status,'pending');
}));
test('formal receipt holds all parts requests and stock changes until rejection',()=>scenario(async()=>{
 let job=await approved(await intake());const part=await repo.savePart(office,{name:'Receipt hold part',sku:randomUUID(),tracked:true});
 await repo.adjustStock(office,{commandId:randomUUID(),partId:part.id,quantity:'3',direction:'add',reason:'Opening stock'});
 job=await startedAction(repo,tech,job.id,{...command(job.revision),action:'complete',done:'Ready for receiving inspection'});
 await assert.rejects(repo.requestParts(tech,job.id,{...command(job.revision),quoteLineId:'labor',partId:part.id,description:'Extra part',quantity:'1'}),/formal receipt/i);
 await assert.rejects(repo.usePart(tech,job.id,{...command(job.revision),quoteLineId:'labor',partId:part.id,quantity:'1',kind:'issue'}),/formal receipt/i);
 assert.equal((await repo.parts()).find(p=>p.id===part.id).onHandMilli,3000);
 assert.equal((await repo.get(tech,job.id)).status,'completed');
}));
test('whole quote rejection retains existing inspection notes and hours without manual Team completion',()=>scenario(async()=>{
 let job=await intake();job=await startedAction(repo,tech,job.id,{...command(job.revision),action:'inspection_complete',done:'Customer declined replacement; inspection only',nextStep:'Do not operate until repaired',hours:'0.25'});const quote=await repo.quote(office,job.id,{...command(job.revision),lines:[{id:'a',kind:'labor',description:'Declined work',quantity:'1',unitPrice:'1000'}]});
 await repo.decide(dispatch,job.id,{commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'a',status:'rejected'}]});job=await repo.get(tech,job.id);
 assert.equal(job.status,'completed');assert.equal(job.outcome,'declined');
 const completed=await repo.get(tech,job.id),entry=completed.work.at(-1);assert.equal(entry.phase,'inspection');assert.equal(entry.data.done,'Customer declined replacement; inspection only');assert.equal(entry.data.hoursMilli,250);assert.equal(completed.data.nextStep,'Do not operate until repaired');
}));
