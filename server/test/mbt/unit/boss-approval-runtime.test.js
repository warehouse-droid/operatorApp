import test from 'node:test';
import assert from 'node:assert/strict';
import {createBossApprovalRuntime} from '../../../src/boss-approval-runtime.js';
function harness(overrides={}){
 const calls={enqueued:[],sent:[],finished:[],bootstraps:0};
 const repo={settings:async()=>({enabled:true,bootstrap_complete:false}),claimCommand:async()=>null,claimSource:async()=>null,claimEmail:async()=>null,
  markBootstrapped:async()=>calls.bootstraps++,roster:async()=>[{operatorId:'tony',active:true,roles:['boss'],ownerId:'1'}],
  emailContent:async()=>({kind:'requested',status:'pending',current_snapshot:{ownerId:'1'},snapshot:{},current_email:'new@example.test'}),
  finishEmail:async(job,status,error)=>calls.finished.push({status,error}),...overrides.repo};
 const mailer={readiness:()=>({configured:true}),send:async(job,event)=>calls.sent.push({job,event}),...overrides.mailer};
 const runtime=createBossApprovalRuntime({repo,mailer,service:{processCommand:async()=>{},processSource:async()=>{}},
  remote:{pending:async()=>[{id:123,tranid:'SOT123'}]},enqueue:async job=>calls.enqueued.push(job),logger:{error(){}},...overrides.runtime});
 return {runtime,calls};
}
test('bootstrap enrolls pending sales orders through a delayed refresh, never directly publishes',async()=>{
 const {runtime,calls}=harness();const start=Date.now();await runtime.tick();assert.equal(calls.bootstraps,1);assert.equal(calls.enqueued[0].orderType,'sales_order');assert(calls.enqueued[0].availableAt.getTime()>=start+10000);
});
test('mail delivery uses current account email; obsolete requested alerts are cancelled',async()=>{
 const normal=harness();await normal.runtime.sendEmail({operator_id:'tony',email:'old@example.test'});assert.equal(normal.calls.sent[0].job.email,'new@example.test');assert.equal(normal.calls.finished[0].status,'sent');
 const reassigned=harness({repo:{emailContent:async()=>({kind:'requested',status:'pending',current_snapshot:{ownerId:'2'}}),roster:async()=>[{operatorId:'tony',ownerId:'1',active:true,roles:['boss']},{operatorId:'jason',ownerId:'2',active:true,roles:['boss']}]}});
 await reassigned.runtime.sendEmail({operator_id:'tony'});assert.equal(reassigned.calls.sent.length,0);assert.equal(reassigned.calls.finished[0].status,'cancelled');
});
test('transient mail errors retry independently; ambiguous delivery is held for review',async()=>{
 for(const [error,status] of [[{responseCode:450},'pending'],[{responseCode:550},'failed'],[{code:'ECONNECTION'},'pending'],[{code:'ETIMEDOUT',command:'DATA'},'uncertain']]){
  const {runtime,calls}=harness({mailer:{send:async()=>{throw error;}}});await runtime.sendEmail({operator_id:'tony'});assert.equal(calls.finished[0].status,status);
 }
});
test('backfill failure cannot block already committed sources or notification delivery',async()=>{
 let sources=0,emails=0;
 const {runtime}=harness({repo:{claimSource:async()=>{sources++;return null;},claimEmail:async()=>{emails++;return null;}},runtime:{remote:{pending:async()=>{throw new Error('backfill unavailable');}}}});
 await runtime.tick();assert.equal(sources,1);assert.equal(emails,1);
});
test('a slow NetSuite scan does not delay later notification delivery ticks',async()=>{
 let release,emails=0;
 const held=new Promise(resolve=>{release=resolve;});
 const {runtime}=harness({repo:{claimEmail:async()=>{emails++;return null;}},runtime:{remote:{pending:async()=>{await held;return [];}}}});
 const first=runtime.tick();await new Promise(resolve=>setTimeout(resolve,5));
 try{await runtime.tick();assert.equal(emails,2);}finally{release();await first;}
});
