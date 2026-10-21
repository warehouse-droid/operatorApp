import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {createStockCheckRepository} from '../../../src/stock-check/repository.js';
const repo=createStockCheckRepository({credentialKey:async()=>Buffer.alloc(32,7)});
const sample={sku:'177ECS0163703-0',name:'Endura™ Coping 24x14 Cham Oat Beige',series:'Endura Coping',finish:'SMOOTH',colour:'OAT BEIGE',
  shape:'COPING',size:'24 x 14 Cham',pickupLocation:'Pickering',url:'https://ontario.order.unilock.com/products/products/endura-coping?child=177ECS0163703-0'};
const actor='stock-check-fixture';
test.after(async()=>{await closeDb();});
async function vendor(label='Fixture vendor') {
  return repo.saveVendor({name:label+' '+crypto.randomUUID().slice(0,8),methodKey:'unilock-ontario-v1'},actor);
}
test('vendor accounts are separate, support multiple logins, and store encrypted passwords only',async()=>{
  const v=await vendor(),secret='fixture-password-for-account';
  const a=await repo.saveAccount(v.id,{label:'Stock login',username:'fixture-user',password:secret,active:true},actor);
  const b=await repo.saveAccount(v.id,{label:'Second login',username:'fixture-user-2',password:'other-fixture-password'},actor);
  const accounts=await repo.listAccounts(v.id);assert.equal(accounts.length,2);assert.equal(a.configured,true);assert.notEqual(a.id,b.id);
  assert.equal(JSON.stringify(accounts).includes(secret),false);assert.equal(JSON.stringify(accounts).includes('encrypted_secret'),false);
  const stored=await query('SELECT encrypted_secret FROM scm_stock_check_accounts WHERE id=$1',[a.id]);
  assert.equal(JSON.stringify(stored.rows).includes(secret),false);
  assert.equal((await repo.getCredentials(v.id,a.id)).password,secret);
  const v2=await vendor();await assert.rejects(repo.getCredentials(v2.id,a.id),error=>error.status===404);
});
test('vendor selection cannot use an account belonging to another vendor',async()=>{
  const one=await vendor(),two=await vendor();
  const account=await repo.saveAccount(one.id,{label:'Main',username:'fixture-user',password:'fixture-password'},actor);
  const current=await repo.getVendor(two.id);
  await assert.rejects(repo.saveVendor({id:two.id,name:two.name,methodKey:two.methodKey,selectedAccountId:account.id,revision:current.revision},actor),error=>error.code==='STOCK_CHECK_ACCOUNT_MISMATCH');
  assert.equal((await repo.getVendor(two.id)).selectedAccountId,null);
});
test('refresh deduplicates exact SKUs, preserves SCM overrides, and clearing overrides restores source values',async()=>{
  const v=await vendor();const first=await repo.upsertScrapedProduct(v.id,sample);
  const manual=await repo.saveProduct(v.id,{id:first.id,revision:first.revision,overrides:{name:'SCM description',pickupLocation:'Ayr'}},actor);
  assert.equal(manual.name,'SCM description');assert.equal(manual.pickupCode,'07');
  await repo.upsertScrapedProduct(v.id,{...sample,name:'New portal description',pickupLocation:'Gormley'});
  const list=await repo.listProducts({vendorId:v.id});assert.equal(list.total,1);assert.equal(list.items[0].name,'SCM description');assert.equal(list.items[0].pickupLocation,'Ayr');
  const reset=await repo.saveProduct(v.id,{id:first.id,revision:list.items[0].revision,overrides:{}},actor);
  assert.equal(reset.name,'New portal description');assert.equal(reset.pickupLocation,'Gormley');assert.equal(reset.hasOverrides,false);
});
test('stale SCM edits conflict without overwriting the newer correction',async()=>{
  const v=await vendor();const row=await repo.upsertScrapedProduct(v.id,sample);
  await repo.saveProduct(v.id,{id:row.id,revision:row.revision,overrides:{name:'First correction'}},actor);
  await assert.rejects(repo.saveProduct(v.id,{id:row.id,revision:row.revision,overrides:{name:'Stale correction'}},actor),error=>error.code==='STOCK_CHECK_REVISION_CONFLICT');
  assert.equal((await repo.getProduct(v.id,row.id)).name,'First correction');
});
test('unmapped source plants remain editable catalog records and cannot start a stock test',async()=>{
  const v=await vendor();await repo.saveAccount(v.id,{label:'Main',username:'fixture-user',password:'fixture-password'},actor);
  const row=await repo.upsertScrapedProduct(v.id,{...sample,pickupLocation:'Chicago'});
  assert.equal(row.pickupLocation,'Chicago');assert.equal(row.pickupCode,null);assert.equal(row.pickupNeedsReview,true);
  await assert.rejects(repo.createJob(v.id,{kind:'stock_test',productId:row.id,quantity:5},actor),error=>error.code==='STOCK_CHECK_PICKUP_REVIEW_REQUIRED');
  const corrected=await repo.saveProduct(v.id,{id:row.id,revision:row.revision,overrides:{pickupLocation:'Pickering'}},actor);
  assert.equal(corrected.pickupNeedsReview,false);assert.equal(corrected.pickupCode,'03');
});
test('job payloads omit credentials, claims are atomic, and results retain per-step evidence',async()=>{
  const v=await vendor();const secret='fixture-sensitive-secret';
  await repo.saveAccount(v.id,{label:'Main',username:'fixture-user',password:secret},actor);
  const product=await repo.upsertScrapedProduct(v.id,sample);
  const first=await repo.createJob(v.id,{kind:'stock_test',productId:product.id,quantity:5},actor);
  const second=await repo.createJob(v.id,{kind:'stock_test',productId:product.id,quantity:2},actor);
  assert.equal(JSON.stringify(first).includes(secret),false);
  const claimed=await Promise.all([repo.claimNextJob(),repo.claimNextJob()]);
  assert.equal(new Set(claimed.map(row=>row.id)).size,2);assert.equal(claimed.every(row=>row.status==='running'),true);
  await repo.addStep(first.id,{key:'cart_verification',status:'success',detail:'Five bundles accepted.',screenshot:'cart-proof.jpg'});
  await repo.finishJob(first.id,{status:'stock_confirmed',verifiedQuantity:5,availabilityEvidenceVersion:1,availabilityText:'Available',availabilitySource:'cart'},'completed');
  const read=await repo.getJob(first.id);assert.equal(read.status,'completed');assert.equal(read.result.status,'stock_confirmed');assert.equal(read.steps[0].screenshot,'cart-proof.jpg');
  await repo.cancelJob(second.id);assert.equal((await repo.getJob(second.id)).cancelRequested,true);
});
test('blank passwords preserve an existing login, including reactivation, and cannot create an unconfigured account',async()=>{
  const v=await vendor();
  await assert.rejects(repo.saveAccount(v.id,{label:'Missing',username:'fixture-user'},actor),error=>error.code==='STOCK_CHECK_CREDENTIALS_REQUIRED');
  const account=await repo.saveAccount(v.id,{label:'Original',username:'fixture-user',password:'fixture-preserved-secret'},actor);
  const disabled=await repo.saveAccount(v.id,{id:account.id,revision:account.revision,label:'Renamed',username:'fixture-user',password:'',active:false},actor);
  const enabled=await repo.saveAccount(v.id,{id:account.id,revision:disabled.revision,label:'Renamed',username:'fixture-user-2',password:'',active:true},actor);
  assert.equal(enabled.active,true);assert.equal((await repo.getCredentials(v.id,account.id)).password,'fixture-preserved-secret');
  assert.equal((await repo.getCredentials(v.id,account.id)).username,'fixture-user-2');
});
test('legacy cart-only positives are unverified in job reads and history while their stored audit result is preserved',async()=>{
  const v=await vendor();await repo.saveAccount(v.id,{label:'Main',username:'fixture-user',password:'fixture-secret'},actor);
  const p=await repo.upsertScrapedProduct(v.id,sample),job=await repo.createJob(v.id,{kind:'stock_test',productId:p.id,quantity:5},actor);
  await repo.finishJob(job.id,{status:'stock_confirmed',verifiedQuantity:5,reason:'The cart accepted five bundles.'},'completed');
  const read=await repo.getJob(job.id);assert.equal(read.result.status,'availability_unverified');assert.equal(read.result.verifiedQuantity,null);assert.equal(read.result.acceptedQuantity,5);
  assert.equal((await repo.listJobs(v.id))[0].result.status,'availability_unverified');
  const stored=await query('SELECT result FROM scm_stock_check_jobs WHERE id=$1',[job.id]);assert.equal(stored.rows[0].result.status,'stock_confirmed');assert.equal(stored.rows[0].result.verifiedQuantity,5);
});
