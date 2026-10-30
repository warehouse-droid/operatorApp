import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {createRepairRuntime} from '../../src/repair/runtime.js';
import {createOperator,loginOperator,getOperatorByToken,operatorHomeRoute} from '../../src/auth-repository.js';
import {query,closeDb,withTransaction} from '../../src/db.js';
import {createRepairOperations} from '../../src/repair/operations.js';
import {createRepairRepository} from '../../src/repair/repository.js';
import {fixture} from './fixture.js';
import {staffReturnPath} from '../../public/staff-login-routes.js';
import {staffPathAllowed} from '../../public/mbr/domain.js';
after(closeDb);
test('real runtime feature gate starts/stops safely and new roles authenticate with correct home routes',async()=>{
 const config={repair:{enabled:false,postingEnabled:false},appBaseUrl:'http://localhost',driverRoutePush:{}};
 const authenticate=async(req,res,next)=>{req.operator=await getOperatorByToken(String(req.headers.authorization||'').slice(7));if(!req.operator)return res.status(401).json({error:'Login required'});next();};
 const runtime=createRepairRuntime({config,authenticate,authenticateDriver:authenticate,dataDir:'/app/test-artifacts/repair-runtime'});const app=express();app.use('/api/repair',runtime.router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  runtime.start();runtime.start();runtime.stop();runtime.stop();assert.equal((await fetch(base+'/api/repair/jobs')).status,404);
  for(const role of ['repair_office','repair_technician']){
   const username=`repair-${randomUUID()}`;await createOperator({username,displayName:'Repair runtime test',role,password:'test-Repair-password'});const session=await loginOperator(username,'test-Repair-password');config.repair.enabled=true;
   const response=await fetch(base+'/api/repair/me',{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.actor.role,role);assert.equal(body.actor.password_hash,undefined);
   assert.equal(operatorHomeRoute(role),role==='repair_office'?'/repair':'/repair/workshop');assert.equal(staffReturnPath('/repair',[role]),'/repair');
  }
  assert.equal(staffPathAllowed({role:'mbr_sales',roles:['mbr_sales']},'/api/repair/jobs'),true);
 }finally{runtime.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('manual linking is revision guarded, audited, and prevents automatic overwrite',async()=>{
 const f=await fixture();try{
  const job=await f.repo.create(f.actors.driver,{commandId:randomUUID(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Manual link test',condition:'can_operate'});
  const operations=createRepairOperations({repo:f.repo,adapter:{link:async()=>({id:'405',name:'WOR00405'})}});
  await assert.rejects(operations.link(f.actors.driver,job.id,{kind:'wor',netsuiteId:'405',revision:1,reason:'Manual import'}),/access/);
  const linked=await operations.link(f.actors.repair_office,job.id,{kind:'wor',netsuiteId:'405',revision:1,reason:'Existing office work order'});assert.equal(linked.data.worId,'405');assert.equal(linked.data.manualLinks,true);assert.equal(linked.postings[0].state,'attention');
  await assert.rejects(operations.retry(f.actors.repair_office,linked.postings[0].id,{reason:'Checked'}),/Manually linked/);
 }finally{await f.close();}
});
test('migration constraints and feature settings retain financial history under rollback',()=>withTransaction(async()=>{
 const repo=createRepairRepository(),office={id:'settings',role:'repair_office'},admin={id:'settings-admin',role:'admin'};
 let settings=await repo.settings(office);assert.equal(settings.inspectionFeeMinor,15000);
 settings=await repo.configure(office,{commandId:randomUUID(),revision:settings.revision,inspectionFee:'175.50'});assert.equal(settings.inspectionFeeMinor,17550);
 await assert.rejects(repo.configure(office,{commandId:randomUUID(),revision:settings.revision,postingEnabled:true}),/access/);
 const result=await repo.configure(admin,{commandId:randomUUID(),revision:settings.revision,postingEnabled:false,mappings:{mbbsCustomerId:'12345'}});assert.equal(result.mappings.mbbsCustomerId,'12345');
 assert.ok((await query("SELECT id FROM repair_events WHERE kind='settings_changed'")).rowCount);
},{rollback:true}));
