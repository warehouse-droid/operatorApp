import express from 'express';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {query} from '../../src/db.js';
import {createRepairRepository} from '../../src/repair/repository.js';
import {createRepairRouter} from '../../src/repair/router.js';
import {createRepairMedia} from '../../src/repair/media.js';
import {jobStarted} from '../../public/repair/domain.js';
import {createRepairOperations} from '../../src/repair/operations.js';
// Positive scenario setup explicitly performs the new Start transition before
// its work/completion command. Start-denial tests call repo.action directly.
export async function startedAction(repo,actor,id,input){
 const current=await repo.get(actor,id),phase=input.action==='inspection_complete'?'inspection':input.phase||'repair';let started=current;
 if(!jobStarted(current,phase))started=await repo.action(actor,id,{commandId:randomUUID(),revision:current.revision,action:phase==='inspection'?'inspection_start':'start_repair'});
 return repo.action(actor,id,{...input,revision:input.revision===current.revision?started.revision:input.revision});
}
export async function fixture({directoryFactory,postingAdapter={}}={}){
 if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Disposable tests only');
 const repo=createRepairRepository();const actors=Object.fromEntries(['driver','operator','repair_office','repair_technician','dispatcher','yard_manager','mbr_sales','admin','other'].map(role=>[role,{id:role,role:role==='other'?'operator':role,roles:[role==='other'?'operator':role],yardLocationIds:[1],operatorYardLocationIds:[1],display_name:role}]));
 const masterId=(await query("SELECT 8000000000000+nextval('repair_request_number_seq') AS id")).rows[0].id;
 const vehicle=randomUUID();await query("INSERT INTO repair_vehicles(id,netsuite_id,company,customer_id,plate,alias,data) VALUES($1,$2,'MBT','7973','TEST-RP','Repair test truck',$3)",[vehicle,masterId,{equipmentType:'truck',netSuiteVehicleType:'Truck'}]);
 const dataDir=await fs.mkdtemp('/app/test-artifacts/repair-media-'),media=createRepairMedia({repo,dataDir});
 const authenticate=(req,res,next)=>{const actor=actors[String(req.headers.authorization||'').replace(/^Bearer /,'')];if(!actor)return res.status(401).json({error:'Login required'});if(req.headers['x-repair-actor']==='driver')req.driver=actor;else req.operator=actor;next();};
 const app=express();const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
 app.use('/api/repair',createRepairRouter({repo,media,authenticate,authenticateDriver:authenticate,enabled:()=>true,appBaseUrl:base,push:{publicKey:''},directory:directoryFactory?directoryFactory(repo):{search:(actor,search)=>repo.vehicles(actor,search),vendors:async()=>[{id:'12821',entityid:'DTC',companyname:'Industrial supplier'}],services:async()=>[],customers:async()=>[]},operations:createRepairOperations({repo,adapter:postingAdapter}),logger:{error(){}}}));
 app.use(express.static(path.resolve('public')));app.get(['/operator/repair','/driver/repair'],(_req,res)=>res.sendFile(path.resolve('public/repair/requester.html')));app.get(['/repair','/repair/workshop','/repair/office'],(_req,res)=>res.sendFile(path.resolve('public/repair/index.html')));app.get('/repair/quote',(_req,res)=>res.sendFile(path.resolve('public/repair/quote.html')));
 async function request(actor,url,body,options={}){const response=await fetch(base+'/api/repair'+url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${actor}`, ...body?{'Content-Type':'application/json'}:{},...options.headers},body:body?JSON.stringify(body):undefined,...options});return {status:response.status,data:await response.json()};}
 return {repo,actors,vehicle,base,request,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});}};
}
