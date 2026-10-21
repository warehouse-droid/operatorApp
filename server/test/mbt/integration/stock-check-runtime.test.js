import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {createStockCheckRuntime} from '../../../src/stock-check/runtime.js';
import {createStockCheckRepository} from '../../../src/stock-check/repository.js';
const repo=createStockCheckRepository({credentialKey:async()=>Buffer.alloc(32,11)});
test.after(()=>closeDb());
async function fixture(t,adapters) {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query("UPDATE scm_stock_check_jobs SET status='cancelled' WHERE status IN ('queued','running')");
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-check-worker-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const vendor=await repo.saveVendor({name:'Worker Fixture '+crypto.randomUUID(),methodKey:'unilock-ontario-v1'},'fixture');
  const runtime=()=>createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir,repository:repo,adapters,logger:{error:()=>{}}});
  return {vendor,runtime,dataDir};
}
test('two app workers cannot run vendor catalog or cart sessions concurrently',async t=>{
  let active=0,maximum=0,release,started;
  const gate=new Promise(resolve=>{release=resolve;}),start=new Promise(resolve=>{started=resolve;});
  const {vendor,runtime}=await fixture(t,{catalog:async options=>{
    active++;maximum=Math.max(maximum,active);started();await gate;
    await options.onStep({key:'fixture_catalog',status:'success',detail:'Catalog read.'});active--;
    return {summary:{imported:0},errors:[],products:[]};
  }});
  const a=await repo.createJob(vendor.id,{kind:'catalog_refresh'},'fixture'),b=await repo.createJob(vendor.id,{kind:'catalog_refresh'},'fixture');
  const one=runtime(),two=runtime(),first=one.tick();
  await start;await two.tick();assert.equal((await repo.getJob(b.id)).status,'queued');release();await first;await two.tick();
  assert.equal(maximum,1);assert.equal((await repo.getJob(a.id)).status,'completed');assert.equal((await repo.getJob(b.id)).status,'completed');
});
test('changed vendor credentials fail a queued login before contacting the vendor',async t=>{
  let called=false;const {vendor,runtime}=await fixture(t,{login:async()=>{called=true;return {status:'login_verified'};}});
  const account=await repo.saveAccount(vendor.id,{label:'Main',username:'fixture-user',password:'fixture-password'},'fixture');
  const job=await repo.createJob(vendor.id,{kind:'login_test'},'fixture');
  await repo.saveAccount(vendor.id,{id:account.id,revision:account.revision,label:'Main',username:'fixture-user',password:'new-fixture-password'},'fixture');
  await runtime().tick();const read=await repo.getJob(job.id);assert.equal(called,false);assert.equal(read.status,'failed');assert.match(read.result.reason,/login changed/i);
});
test('login worker saves private screenshot evidence and sanitizes external failure messages',async t=>{
  const secret='fixture-worker-secret';const {vendor,runtime,dataDir}=await fixture(t,{login:async options=>{
    const filename=await options.onScreenshot('login',Buffer.from([255,216,255,217]));
    await options.onStep({key:'login',status:'success',detail:'Signed in.',screenshot:filename});throw new Error('Vendor failure '+secret);
  }});
  await repo.saveAccount(vendor.id,{label:'Main',username:'fixture-user',password:secret},'fixture');
  const job=await repo.createJob(vendor.id,{kind:'login_test'},'fixture');await runtime().tick();const read=await repo.getJob(job.id);
  assert.equal(read.status,'failed');assert.equal(JSON.stringify(read).includes(secret),false);assert.match(read.result.reason,/redacted/);
  const file=path.join(dataDir,'stock-check/evidence',job.id,read.steps[0].screenshot);assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('cancelled queued jobs never call the vendor and interrupted running jobs require SCM review',async t=>{
  let called=false;const {vendor,runtime}=await fixture(t,{catalog:async()=>{called=true;}});
  const queued=await repo.createJob(vendor.id,{kind:'catalog_refresh'},'fixture');await repo.cancelJob(queued.id);await runtime().tick();assert.equal(called,false);
  const running=await repo.createJob(vendor.id,{kind:'catalog_refresh'},'fixture');await repo.claimNextJob();await repo.recoverInterrupted();
  const read=await repo.getJob(running.id);assert.equal(read.status,'failed');assert.match(read.result.reason,/restarted|review/i);
});
