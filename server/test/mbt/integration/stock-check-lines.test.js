import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {createSpecialStockCase} from '../../../src/special-stock-request-repository.js';
import {submitBackorderRequest} from '../../../src/backorder-request-service.js';
import {createStockCheckRepository} from '../../../src/stock-check/repository.js';
import {createRequestStockChecks} from '../../../src/stock-check/request-checks.js';
import {createOllamaMatcher} from '../../../src/stock-check/ollama-matching.js';
import {lineFingerprint} from '../../../src/stock-check/line-matching.js';
const repo=createStockCheckRepository({credentialKey:async()=>Buffer.alloc(32,7)}),checks=createRequestStockChecks(repo);
const sample={sku:'177ECS0163703-0',name:'Endura Coping 24x14 Cham Oat Beige',colour:'OAT BEIGE',size:'24 x 14',pickupLocation:'Pickering',url:'https://ontario.order.unilock.com/products/products/endura-coping?child=177ECS0163703-0'};
let actor,product;
test.before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  actor=(await createOperator({username:'live-lines-'+crypto.randomUUID(),displayName:'TEST Live Lines',password:crypto.randomUUID(),role:'scm'})).id;
  product=await repo.upsertScrapedProduct(1,sample);
  await repo.saveAccount(1,{label:'Fixture',username:'fixture-user',password:'fixture-secret'},actor);
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id) VALUES(88997701,'TEST-LIVE', $1,'SQFT','Unilock Ltd',331) ON CONFLICT DO NOTHING",[sample.name]);
});
test.after(()=>closeDb());
async function fixture(count=2,vendorName='Unilock Ltd',kind='special') {
  if(kind==='backorder') {
    return submitBackorderRequest({destinationLocationId:1,inquiryDate:'2099-01-01',vendorId:331,vendorName,fulfillmentMethod:'yard_pickup',
      lines:Array.from({length:count},()=>({itemId:88997701,salesQty:25.5,quantityMode:'direct',rate:10,requiredDate:'2099-02-01',detailSpec:sample.sku}))},
    {operatorId:actor,authorizedDestinationLocationIds:[1]});
  }
  return createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Live Stock',vendorId:331,vendorName,fulfillmentMethod:'yard_pickup',
    lines:Array.from({length:count},()=>({productName:sample.name,color:sample.colour,size:sample.size,quantity:25.5,uom:'SQFT',rate:10,requiredDate:'2099-02-01'}))},
  {operatorId:actor,authorizedStoreLocationIds:[1]});
}
const selection=data=>({lines:data.lines.map(line=>({lineId:line.lineId,productId:product.id,fingerprint:line.fingerprint}))});
test('special and regular backorder lines match a unique complete variant and retain per-line jobs without editing requests',async()=>{
  for(const kind of ['special','backorder']) {
    const d=await fixture(2,'Unilock Ltd',kind);
    const before=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows;
    const data=await checks.get(d.id);assert.equal(data.lines.length,2);assert.equal(data.lines[0].product.id,product.id);
    const saved=await checks.start(d.id,selection(data),actor);
    assert.equal(saved.lines.every(line=>line.job.status==='queued'),true);assert.equal(new Set(saved.lines.map(line=>line.job.id)).size,2);
    const job=await repo.getJob(saved.lines[0].job.id);assert.equal(job.payload.requestLine.quantity,25.5);assert.equal(job.payload.requestLine.uom,'SQFT');
    await repo.finishJob(job.id,{status:'low_stock',availabilityEvidenceVersion:2,reason:'Low inventory'},'completed');
    assert.equal((await checks.get(d.id)).lines[0].job.result.status,'low_stock');
    assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,before);
    assert.equal((await query('SELECT revision FROM sales_stock_requests WHERE id=$1',[d.id])).rows[0].revision,d.revision);
    await query("UPDATE scm_stock_check_jobs SET status='cancelled' WHERE payload->'requestLine'->>'requestId'=$1",[String(d.id)]);
  }
});
test('concurrent batch clicks reuse active checks and a 12-line batch is atomic beyond the interactive queue limit',async()=>{
  const d=await fixture(12),data=await checks.get(d.id);
  const [a,b]=await Promise.all([checks.start(d.id,selection(data),actor),checks.start(d.id,selection(data),actor)]);
  assert.deepEqual(a.lines.map(line=>line.job.id),b.lines.map(line=>line.job.id));
  assert.equal((await query("SELECT count(*)::int AS n FROM scm_stock_check_jobs WHERE payload->'requestLine'->>'requestId'=$1",[String(d.id)])).rows[0].n,12);
  await query("UPDATE scm_stock_check_jobs SET status='cancelled' WHERE payload->'requestLine'->>'requestId'=$1",[String(d.id)]);
});
test('stale fingerprints, foreign lines and non-Unilock lines cannot queue jobs or overwrite old evidence',async()=>{
  const d=await fixture(),data=await checks.get(d.id),input=selection(data);
  await query("UPDATE sales_special_stock_lines SET product_name='Changed material' WHERE id=$1",[d.lines[0].id]);
  await assert.rejects(checks.start(d.id,input,actor),error=>error.status===409);
  const fresh=await checks.get(d.id);fresh.lines[0].lineId=99999999;
  await assert.rejects(checks.start(d.id,selection(fresh),actor),error=>error.status===400);
  const other=await fixture(1,'Other Vendor');assert.deepEqual((await checks.get(other.id)).lines,[]);
  await assert.rejects(checks.start(other.id,input,actor),error=>error.status===400);
  assert.equal((await query("SELECT count(*)::int AS n FROM scm_stock_check_jobs WHERE payload->'requestLine'->>'requestId'=$1",[String(d.id)])).rows[0].n,0);
});
test('ambiguous variants require selection and quantity changes invalidate a completed result while preserving its evidence link',async()=>{
  const d=await fixture(1);await repo.upsertScrapedProduct(1,{...sample,sku:'177ECS0163703-X',url:sample.url.replace('3703-0','3703-X')});
  const data=await checks.get(d.id);assert.equal(data.lines[0].product,null);assert.equal(data.lines[0].candidates.length,2);
  const saved=await checks.start(d.id,selection(data),actor),job=saved.lines[0].job;
  await repo.finishJob(job.id,{status:'stock_available',availabilityEvidenceVersion:2},'completed');
  await query('UPDATE sales_special_stock_lines SET requested_quantity=26 WHERE id=$1',[d.lines[0].id]);
  const changed=(await checks.get(d.id)).lines[0];assert.equal(changed.stale,true);assert.equal(changed.job.id,job.id);
});
test('a bad product late in a batch rolls back all jobs and duplicate or oversized selections are rejected',async()=>{
  const d=await fixture(),data=await checks.get(d.id),input=selection(data);
  input.lines[1].productId=99999999;
  await assert.rejects(checks.start(d.id,input,actor),error=>error.status===404);
  const valid=selection(data);
  await assert.rejects(checks.start(d.id,{lines:[valid.lines[0],valid.lines[0]]},actor),error=>error.status===400);
  await assert.rejects(checks.start(d.id,{lines:Array(101).fill(valid.lines[0])},actor),error=>error.status===400);
  assert.equal((await query("SELECT count(*)::int AS n FROM scm_stock_check_jobs WHERE payload->'requestLine'->>'requestId'=$1",[String(d.id)])).rows[0].n,0);
  await assert.rejects(checks.get(99999999),error=>error.status===404);
});
test('regular Beacon Hill uses the saved description throughout matching, prompt, fingerprints and job labels without editing the request',async()=>{
  const code='UNI-BH80S-RDM-FOS',description='Beacon Hill 80mm S Rdm Fossil 81.6sqft/plt, 11.66sqft/lyr, 7lyrs/plt';
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,item_description,stock_unit,vendor,vendor_id) VALUES(88997703,$1,$1,$2,'SQFT','Unilock Ltd',331)",[code,description]);
  const material=await repo.upsertScrapedProduct(1,{sku:'0237M01818807-1',name:'Beacon Hill Smooth 8cm Fossil NS',colour:'FOSSIL',size:'Random',pickupLocation:'Ayr',url:'https://ontario.order.unilock.com/products/products/beacon-hill-smooth?child=0237M01818807-1'});
  const d=await submitBackorderRequest({destinationLocationId:1,vendorId:331,vendorName:'Unilock Ltd',fulfillmentMethod:'yard_pickup',lines:[{itemId:88997703,salesQty:10,quantityMode:'direct'}]},
    {operatorId:actor,authorizedDestinationLocationIds:[1]});
  const before=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1',[d.id])).rows;
  const row=before[0],oldFingerprint=lineFingerprint({vendorName:row.brand,productName:row.product_name,color:row.color,size:row.size,
    detailSpec:row.detail_spec,itemCode:row.regular_item_code,vendorReference:row.vendor_reference,quantity:Number(row.requested_quantity),uom:row.requested_uom});
  const old=await repo.createJob(1,{kind:'stock_test',productId:material.id,quantity:1},actor,{queueLimit:100,requestLine:{requestId:d.id,lineId:Number(row.id),fingerprint:oldFingerprint,description:code}});
  await repo.finishJob(old.id,{status:'low_stock',availabilityEvidenceVersion:2},'completed');
  const prompts=[],matcher=createOllamaMatcher({settings:()=>({baseUrl:'http://fixture',model:'fixture'}),fetchImpl:async(_url,options)=>{
    prompts.push(JSON.parse(options.body).prompt);return {ok:true,json:async()=>({response:JSON.stringify({matches:[{lineId:d.lines[0].id,sku:material.sku,confidence:.99}]})})};
  }}),service=createRequestStockChecks(repo,{matcher});
  const data=await service.get(d.id);assert.equal(data.lines[0].productName,description);assert.equal(data.lines[0].itemCode,null);assert.equal(data.lines[0].referenceItemCode,code);
  assert.equal(data.lines[0].stale,true);assert.equal(data.lines[0].job.id,old.id);assert.equal(data.lines[0].product,null);
  const matched=await service.match(d.id);assert.equal(matched.lines[0].product.id,material.id);assert.equal(prompts.length,1);assert.ok(prompts[0].includes(description));assert.equal(prompts[0].includes(code),false);
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1',[d.id])).rows,before);
  const saved=await service.start(d.id,{lines:[{lineId:data.lines[0].lineId,productId:material.id,fingerprint:data.lines[0].fingerprint}]},actor);
  assert.equal(saved.lines[0].job.payload.requestLine.description,description);
  await query("UPDATE scm_stock_check_jobs SET status='cancelled' WHERE id=$1",[saved.lines[0].job.id]);
  await query("UPDATE sales_special_stock_lines SET detail_spec=$2 WHERE request_id=$1",[d.id,description.replace('80mm','60mm')]);
  assert.notEqual((await service.get(d.id)).lines[0].fingerprint,data.lines[0].fingerprint);
  assert.equal((await service.get(d.id)).lines[0].stale,true);
});
test('regular lines with missing saved descriptions read the inventory description; missing descriptions never reach Ollama',async()=>{
  const code='UNI-FALLBACK-ONLY',description='Beacon Hill 80mm S Rdm Fossil';
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,item_description,stock_unit,vendor,vendor_id) VALUES(88997704,$1,$1,$2,'SQFT','Unilock Ltd',331)",[code,description]);
  const d=await submitBackorderRequest({destinationLocationId:1,vendorId:331,vendorName:'Unilock Ltd',fulfillmentMethod:'yard_pickup',lines:[{itemId:88997704,salesQty:1,quantityMode:'direct',detailSpec:''}]},
    {operatorId:actor,authorizedDestinationLocationIds:[1]});
  const service=createRequestStockChecks(repo,{matcher:{match:async()=>{assert.fail('Missing descriptions must not be guessed from internal codes.');}}});
  const first=(await service.get(d.id)).lines[0];assert.equal(first.productName,description);
  await query("UPDATE inventory_items SET item_description='' WHERE item_id=88997704");
  const missing=(await service.match(d.id)).lines[0];assert.equal(missing.descriptionMissing,true);assert.deepEqual(missing.candidates,[]);assert.equal(missing.product,null);
  assert.match(missing.aiMatch.reason,/description is missing/u);assert.notEqual(missing.fingerprint,first.fingerprint);
});
