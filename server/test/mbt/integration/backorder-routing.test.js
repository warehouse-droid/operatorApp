import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test,{before,after} from 'node:test';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import * as special from '../../../src/special-stock-request-repository.js';

const users={},requests=[],sku=88999401,other=88999402;
let server,base;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id) VALUES($1,'TEST-ROUTE-A','Routing A','EA','TEST Route Alpha',331),($2,'TEST-ROUTE-B','Routing B','BAG','TEST Route Beta',332)",[sku,other]);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm']){
    const username='route-'+role+'-'+crypto.randomUUID(),password=crypto.randomUUID();
    users[role]=await createOperator({username,password,displayName:'TEST '+role,role,roles:[role],yardLocationIds:role==='sales'?[1,28]:[]});
    const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);users[role].token=(await r.json()).token;
  }
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[requests]);await closeDb();});
async function http(role,path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+users[role].token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
const draft=()=>({deliveryMethod:'backorder',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,salesQty:4,rate:0,destinationLocationId:1},{itemId:other,salesQty:6,rate:0,destinationLocationId:28}]});
async function create(input=draft()){const r=await http('sales','/api/sales/stock-requests',input);assert.equal(r.status,201,JSON.stringify(r.body));requests.push(r.body.id);return r.body;}
async function action(d,role,name,input){const r=await http(role,`/api/${role}/stock-requests/${d.id}/backorder/${name}`,{expectedRevision:d.revision,...input});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}

test('Backorder persists independent catalog vendors and destination yards and lists every material route',async()=>{
  const d=await create();
  assert.deepEqual(d.lines.map(l=>[l.vendorId,l.vendorName,l.destinationLocationId]),[[331,'TEST Route Alpha',1],[332,'TEST Route Beta',28]]);
  const saved=await http('scm','/api/scm/stock-requests/'+d.id);assert.equal(saved.status,200);assert.deepEqual(saved.body.lines.map(l=>[l.vendorId,l.vendorName,l.destinationLocationId]),d.lines.map(l=>[l.vendorId,l.vendorName,l.destinationLocationId]));
  for(const role of ['sales','scm'])for(const filter of ['vendor=TEST%20Route%20Beta','destinationLocationId=28','destinationLocationIds=28','destinationLocationIds=28,15']){
    const list=await http(role,`/api/${role}/stock-requests?type=backorder&${filter}`);assert.equal(list.status,200);assert.ok(list.body.requests.some(r=>r.id===d.id),filter);
  }
  const filters=await http('sales','/api/sales/stock-requests');assert.equal(filters.status,200);assert.ok(filters.body.filterOptions.vendors.includes('TEST Route Beta'));
  const defaulted=await create({ ...draft(),lines:[{itemId:sku,salesQty:1,rate:0},{itemId:other,salesQty:2,rate:0,vendorName:'TEST Custom vendor'}] });
  assert.deepEqual(defaulted.lines.map(l=>[l.vendorName,l.destinationLocationId]),[['TEST Route Alpha',1],['TEST Custom vendor',1]]);
  assert.equal(defaulted.lines[1].vendorId,null);
});
test('Backorder refuses inaccessible or invalid per-line yards atomically on create and edit',async()=>{
  const count=async()=>Number((await query('SELECT count(*) AS n FROM sales_stock_requests')).rows[0].n),before=await count();
  for(const yard of [15,26,999,0,-1,'1.5','garbage']){
    const input=draft();input.lines[1].destinationLocationId=yard;
    const r=await http('sales','/api/sales/stock-requests',input);assert.ok([400,403].includes(r.status),JSON.stringify(r));assert.equal(await count(),before);
  }
  const d=await create(),line=d.lines[1];
  for(const input of [{destinationLocationId:15},{destinationLocationId:'bad'},{vendorName:''},{vendorId:-1}]){
    const r=await http('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${line.id}/edit`,{expectedRevision:d.revision,...input});assert.ok([400,403].includes(r.status));
  }
  const saved=await http('sales','/api/sales/stock-requests/'+d.id);assert.equal(saved.body.revision,d.revision);assert.deepEqual(saved.body.lines,d.lines);
});
test('Backorder reviews different vendors and edits one route without changing another material or saved prices',async()=>{
  const input=draft();input.lines[0].rate=10;input.lines[0].discountPercent=5;let d=await create(input);
  for(const [index,line] of d.lines.entries())d=await action(d,'scm',`lines/${line.id}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331+index,vendorName:index?'TEST Route Beta':'TEST Route Alpha',vendorYard:'TEST receiving',unitPurchaseCost:3});
  for(const line of d.lines)d=await action(d,'sales',`lines/${line.id}/decision`,{decision:'accepted'});
  const untouched=d.lines[1];
  d=await action(d,'sales',`lines/${d.lines[0].id}/edit`,{quantity:8,vendorName:'TEST Changed supplier',vendorId:333,destinationLocationId:28});
  assert.equal(d.lines[0].vendorName,'TEST Changed supplier');assert.equal(d.lines[0].vendorId,333);assert.equal(d.lines[0].destinationLocationId,28);assert.equal(d.lines[0].originalRate,10);assert.equal(d.lines[0].quotedDiscountPercent,5);assert.equal(d.lines[0].salesDecision,'pending');assert.equal(d.lines[0].responseVendorId,null);
  assert.deepEqual(d.lines[1],untouched);
  const r=await http('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${d.lines[0].id}/edit`,{expectedRevision:d.revision-1,vendorName:'Stale overwrite'});assert.equal(r.status,409);
  d=await action(d,'scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:334,vendorName:'TEST Final supplier',vendorYard:'TEST receiving'});assert.equal(d.lines[0].vendorId,334);assert.equal(d.lines[0].destinationLocationId,28);
});
test('Special requests continue rejecting mixed vendors while Backorder line routing rejects hostile vendor input',async()=>{
  const context={operatorId:users.sales.id,authorizedStoreLocationIds:[1,28]},d=await special.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Special',vendorName:'TEST Route Alpha',fulfillmentMethod:'yard_pickup',lines:[{productName:'A',quantity:1,uom:'PCS',rate:10,requiredDate:'2099-02-01'},{productName:'B',quantity:2,uom:'PCS',rate:10,requiredDate:'2099-02-01'}]},context);requests.push(d.id);
  const reviewed=await special.respondSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Route Alpha',vendorYard:'TEST yard'},{operatorId:users.scm.id});
  await assert.rejects(special.respondSpecialStockLine(d.id,d.lines[1].id,{expectedRevision:reviewed.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:332,vendorName:'TEST Route Beta',vendorYard:'TEST yard'},{operatorId:users.scm.id}),{code:'SPECIAL_RESPONSE_MIXED_VENDOR'});
  for(const vendor of [{vendorName:''},{vendorName:'x'.repeat(201)},{vendorId:0},{vendorId:'bad'}]){const input=draft();Object.assign(input.lines[1],vendor);const r=await http('sales','/api/sales/stock-requests',input);assert.equal(r.status,400,JSON.stringify(r));}
});
