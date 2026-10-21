import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {createSpecialStockCase} from '../../../src/special-stock-request-repository.js';
import {createStockCheckRepository} from '../../../src/stock-check/repository.js';
import {createRequestStockChecks} from '../../../src/stock-check/request-checks.js';
const repo=createStockCheckRepository({credentialKey:async()=>Buffer.alloc(32,7)});
const sample={sku:'OLLAMA-EXACT-0',name:'Urban Rectangle 6cm Dark Charcoal',colour:'DARK CHARCOAL',size:'190mm x 380mm x 60mm',pickupLocation:'Ayr',url:'https://ontario.order.unilock.com/products/products/urban?child=OLLAMA-EXACT-0'};
let actor,product;
test.before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  actor=(await createOperator({username:'ollama-'+crypto.randomUUID(),displayName:'TEST Ollama',password:crypto.randomUUID(),role:'scm'})).id;
  product=await repo.upsertScrapedProduct(1,sample);
});
test.after(()=>closeDb());
async function fixture(exact=false) {
  return createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'PRIVATE CUSTOMER',vendorId:331,vendorName:'Unilock Ltd',fulfillmentMethod:'yard_pickup',
    lines:[{productName:exact?sample.name:'UrbanTM Rectangle',color:sample.colour,size:exact?sample.size:'6cm 7.5x15',quantity:5,uom:'SQFT',rate:10,requiredDate:'2099-02-01'}]},
  {operatorId:actor,authorizedStoreLocationIds:[1]});
}
test('explicit matching reads stored descriptors without creating jobs or changing business/catalogue data; ordinary reads skip inference',async()=>{
  const d=await fixture(),calls=[];
  const checks=createRequestStockChecks(repo,{matcher:{match:async(lines,products)=>{calls.push({lines,products});return [{lineId:lines[0].lineId,product,aiMatch:{status:'matched',confidence:.99,reason:'Same variant'}}];}}});
  assert.equal((await checks.get(d.id)).lines[0].product,null);assert.equal(calls.length,0);
  const before=(await query('SELECT row_to_json(l) AS row FROM sales_special_stock_lines l WHERE request_id=$1',[d.id])).rows;
  const result=await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');return checks.match(d.id);});
  assert.equal(result.lines[0].product.id,product.id);assert.equal(result.lines[0].aiMatch.status,'matched');assert.equal(calls.length,1);
  assert.equal(JSON.stringify(calls).includes('PRIVATE CUSTOMER'),false);
  assert.deepEqual((await query('SELECT row_to_json(l) AS row FROM sales_special_stock_lines l WHERE request_id=$1',[d.id])).rows,before);
  assert.equal((await query("SELECT count(*)::int AS n FROM scm_stock_check_jobs WHERE payload->'requestLine'->>'requestId'=$1",[String(d.id)])).rows[0].n,0);
  assert.equal((await checks.get(d.id)).lines[0].product,null,'Read-only matching does not persist an inferred selection.');
  assert.equal(calls.length,1);
});
test('unique exact matches and non-Unilock requests do not call Ollama',async()=>{
  const checks=createRequestStockChecks(repo,{matcher:{match:async()=>{assert.fail('Exact selections must not call Ollama');}}});
  const d=await fixture(true);assert.equal((await checks.match(d.id)).lines[0].product.id,product.id);
  await query("UPDATE sales_special_stock_lines SET brand='Other',response_vendor_name='Other' WHERE request_id=$1",[d.id]);
  assert.deepEqual((await checks.match(d.id)).lines,[]);
});
test('request changes while inference is pending discard the result',async()=>{
  const d=await fixture();let resolve,started;
  const entered=new Promise(done=>{started=done;}),pending=new Promise(done=>{resolve=done;});
  const checks=createRequestStockChecks(repo,{matcher:{match:async lines=>{started();await pending;return [{lineId:lines[0].lineId,product,aiMatch:{status:'matched'}}];}}});
  const result=checks.match(d.id);await entered;
  await query("UPDATE sales_special_stock_lines SET color='FOSSIL' WHERE request_id=$1",[d.id]);resolve();
  await assert.rejects(result,error=>error.status===409);
});
test('catalogue changes while inference is pending discard the result',async()=>{
  const d=await fixture();let resolve,started;
  const entered=new Promise(done=>{started=done;}),pending=new Promise(done=>{resolve=done;});
  const checks=createRequestStockChecks(repo,{matcher:{match:async lines=>{started();await pending;return [{lineId:lines[0].lineId,product,aiMatch:{status:'matched'}}];}}});
  const result=checks.match(d.id);await entered;
  await repo.upsertScrapedProduct(1,{...sample,name:sample.name+' Updated'});resolve();
  await assert.rejects(result,error=>error.status===409);
});
