/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import fc from 'fast-check';
import { prepareSpecialAdjustmentPlan as prepareAmountPlan,applySpecialAdjustmentPlan } from '../../../src/special-stock-adjustment-adapter.js';
import { buildSpecialSalesOrderPayload as buildAmountPayload } from '../../../src/special-stock-request-netsuite.js';
import {assertSpecialDiscountRestReady} from '../../../src/netsuite.js';

// Preserve the uploaded artifact's legacy protocol contracts independently of
// production, whose order creation/adjustment boundaries now use REST amounts.
async function prepareSpecialAdjustmentPlan(input,boundary){
 const plan=await prepareAmountPlan(input,boundary);
 for(const order of plan.orders)for(const [index,line]of order.target.lines.entries())if(line.itemId===10716){
  const change=input.orders.find(candidate=>candidate.id===order.id)?.lines.find(candidate=>candidate.remoteLineId===order.target.lines[index-1].remoteLineId);
  if(change?.toNativeDiscountPercent>0)line.rate=`-${change.toNativeDiscountPercent}%`;
 }
 return plan;
}
function buildSpecialSalesOrderPayload(input){
 const payload=buildAmountPayload(input),discounts=input.draft.materialLines.map(line=>line.nativeDiscountPercent ?? line.discountPercent ?? 0).filter(Boolean);
 for(const line of payload.item.items)if(Number(line.item.id)===10716)line.rate=`-${discounts.shift()}%`;
 return payload;
}

function fixture(){
 const material={lineuniquekey:101,item:2055,quantity:24,units:865,rate:9,description:'A',location:1,taxcode:'13',createdpo:12};
 const records=new Map([[11,{header:{entity:1,location:1,memo:'MBBS-SPECIAL-SO:7'},items:[material,{...material,lineuniquekey:102,quantity:10,rate:20,description:'B'},
  {lineuniquekey:103,item:1784,quantity:2,units:246,rate:40,description:'PALLET',location:1,taxcode:'13'}]}],
 [12,{header:{entity:2,location:1},items:[{...material,lineuniquekey:201,rate:4,createdpo:null}]}]]);
 const saves=[];let sequence=900,entry,failAfterSave=false,failPo=false;
 function model(id,type,create=false){
  const data=structuredClone(create?{header:{},items:[]}:records.get(id));let current;
  if(!Object.hasOwn(data.header,'orderstatus'))data.header.orderstatus='B';
  return {getValue:({fieldId})=>data.header[fieldId],setValue:({fieldId,value})=>{data.header[fieldId]=value;},
   getText:()=>data.header.status ?? (type==='purchaseorder'?'Pending Receipt':'Pending Fulfillment'),
   getLineCount:()=>data.items.length,getSublistValue:({fieldId,line})=>data.items[line]?.[fieldId],
   getSublistText:({fieldId,line})=>String(data.items[line]?.[fieldId]??''),
   setSublistValue:({fieldId,line,value})=>{(data.items[line]??={})[fieldId]=value;},
   setSublistText:({fieldId,line,text})=>{data.items[line][fieldId]=text;},
   insertLine:({line})=>data.items.splice(line,0,{}),removeLine:({line})=>data.items.splice(line,1),
   selectNewLine:()=>{current={taxcode:'13'};},setCurrentSublistValue:({fieldId,value})=>{current[fieldId]=value;},
   setCurrentSublistText:({fieldId,text})=>{current[fieldId]=text;},commitLine:()=>data.items.push(current),
   getSubrecord:()=>({setValue:({fieldId,value})=>{data.header[fieldId]=value;}}),
   save:()=>{
    if(id===12&&failPo){failPo=false;throw Error('PO unavailable');}
    for(const line of data.items)line.lineuniquekey??=++sequence;
    records.set(id,data);saves.push(id);
    if(failAfterSave){failAfterSave=false;throw Error('lost response');}
    return id;
   }};
 }
 const modules={'N/error':{create:({name,message})=>Object.assign(Error(message),{name})},'N/log':{audit(){},error(){}},
  'N/render':{},'N/runtime':{accountId:'TEST_SB1',envType:'SANDBOX',EnvType:{SANDBOX:'SANDBOX'},getCurrentUser:()=>({id:1,role:1}),getCurrentScript:()=>({getRemainingUsage:()=>5000})},
  'N/record':{Type:{SALES_ORDER:'salesorder',PURCHASE_ORDER:'purchaseorder',ESTIMATE:'estimate'},load:({id,type})=>model(id,type),create:({type})=>model(20,type,true),transform:({toType})=>model(20,toType,true)}};
 vm.runInNewContext(fs.readFileSync('netsuite-smart-scm-picking-ticket-restlet.js','utf8'),{define:(names,factory)=>{entry=factory(...names.map(name=>modules[name]));}},{filename:'/app/netsuite-smart-scm-picking-ticket-restlet.js'});
 const call=input=>JSON.parse(JSON.stringify(entry.post(input)));
 const boundary={snapshot:async order=>call({action:'specialOrderAdjustment',mode:'snapshot',kind:order.kind,entityId:order.id}).snapshot,
  apply:async order=>call({action:'specialOrderAdjustment',mode:'apply',kind:order.kind,entityId:order.id,baseline:order.baseline,target:order.target})};
 const orders=[{id:11,kind:'sales_order',lines:[{remoteLineId:101,itemId:2055,quantity:24,rate:9,description:'A',unitId:865,toQuantity:36,toRate:10,toNativeDiscountPercent:25}],pallets:{fromQuantity:2,toQuantity:0,rate:40}},
  {id:12,kind:'purchase_order',lines:[{remoteLineId:201,itemId:2055,quantity:24,rate:4,description:'A',unitId:865,toQuantity:36}]}];
 return {records,saves,call,boundary,orders,loseResponse(){failAfterSave=true;},failPo(){failPo=true;}};
}
test('pending native status B remains readable when orderstatus has no English select label',()=>{
 for(const [id,kind]of [[11,'sales_order'],[12,'purchase_order']])for(const label of ['B','',null,'En attente']){
  const f=fixture();f.records.get(id).header.orderstatus='B';f.records.get(id).header.status=label;
  const result=f.call({action:'specialOrderAdjustment',mode:'snapshot',entityId:id,kind});
  assert.equal(result.ok,true);assert.ok(result.snapshot.lines.length);assert.deepEqual(f.saves,[]);
 }
});
test('property: only native pending status codes permit snapshots regardless of display label',()=>{
 fc.assert(fc.property(fc.constantFrom('A','B','C','D','E','F','G','H','Z','',null),
  fc.oneof(fc.string(),fc.constantFrom('Pending Fulfillment','Pending Receipt','Pending Approval')),(code,label)=>{
  for(const [id,kind]of [[11,'sales_order'],[12,'purchase_order']]){
   const f=fixture();f.records.get(id).header.orderstatus=code;f.records.get(id).header.status=label;
   const snapshot=()=>f.call({action:'specialOrderAdjustment',mode:'snapshot',entityId:id,kind});
   if(['A','B'].includes(code))assert.equal(snapshot().ok,true);
   else assert.throws(snapshot,/Only pending, unexecuted orders/);
   assert.deepEqual(f.saves,[]);
  }
 }),{numRuns:70,seed:20260926});
});
test('pending code cannot bypass fulfilled, received, billed or closed line checks',()=>{
 for(const [id,kind,fields]of [[11,'sales_order',['quantityfulfilled','quantitybilled','isclosed']],
  [12,'purchase_order',['quantityreceived','quantitybilled','isclosed']]])for(const field of fields){
  const f=fixture();f.records.get(id).header.orderstatus='B';f.records.get(id).items[0][field]=field==='isclosed'?true:1;
  assert.throws(()=>f.call({action:'specialOrderAdjustment',mode:'snapshot',entityId:id,kind}),/Fulfilled, received, billed or closed/);
  assert.deepEqual(f.saves,[]);
 }
});
test('real RESTlet logic inserts percent text in-place, preserves material keys/PO links and retries a lost save response',async()=>{
 const f=fixture(),plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);f.loseResponse();
 await assert.rejects(()=>applySpecialAdjustmentPlan(plan,f.boundary));
 await applySpecialAdjustmentPlan(plan,f.boundary);
 assert.deepEqual(f.saves,[11,12]);
 assert.deepEqual(f.records.get(11).items.map(line=>[line.item,line.quantity??null,line.rate]),[[2055,36,10],[10716,null,'-25%'],[2055,10,20]]);
 assert.deepEqual(f.records.get(11).items.filter(line=>line.item===2055).map(line=>[line.lineuniquekey,line.createdpo]),[[101,12],[102,12]]);
 assert.equal(f.records.get(12).items[0].rate,4);
});
test('native creation uses gross material and negative percent text, preserves shipping fields and zero-priced items',()=>{
 const f=fixture();
 const payload=buildSpecialSalesOrderPayload({ discountMode: 'line',caseId:7,netsuiteLocationId:1,deliveryMethodId:2,draft:{customerId:1,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST delivery',deliveryDate:'2099-01-01',
  materialLines:[{itemId:2055,quantity:24,unitId:865,rate:10,discountPercent:25,description:'A'},{itemId:2055,quantity:1,unitId:865,rate:0,description:'B'}],ancillaryLines:[]}});
 const result=f.call({action:'createSpecialSalesOrder',payload});
 assert.equal(result.entityId,20);assert.deepEqual(f.records.get(20).items.map(x=>[x.item,x.rate]),[[2055,10],[10716,'-25%'],[2055,0]]);
 assert.equal(f.records.get(20).header.addrtext,'TEST delivery');assert.equal(f.records.get(20).header.externalid,'MBBS-SPECIAL-SO:7');
});
test('native SO creation and estimate conversion keep missing and zero pack columns blank',()=>{
 for(const estimateId of [undefined,7])for(const value of [undefined,null,'',0,'0.00','2.5',-1,true,'bad',Infinity,1e9+1]){
  const f=fixture(),payload=buildSpecialSalesOrderPayload({caseId:7,netsuiteLocationId:1,pickupMethodId:2,
   draft:{customerId:1,materialLines:[{itemId:2055,quantity:24,unitId:865,rate:10,description:'A'}]}});
  const fields=['custcol_plt','custcol_lyr','custcol_sec','custcol_pcs'];
  for(const field of fields)payload.item.items[0][field]=value;
  const create=()=>f.call({action:'createSpecialSalesOrder',payload,estimateId});
  if([-1,true,'bad',Infinity,1e9+1].includes(value)){assert.throws(create,/Invalid PLT/);assert.deepEqual(f.saves,[]);}
  else{assert.equal(create().entityId,20);assert.deepEqual(fields.map(field=>f.records.get(20).items[0][field]),fields.map(()=>value==='2.5'?2.5:null));}
 }
});
test('fulfilled lines, stale baselines, positive discounts and PO repricing fail without saving',async()=>{
 for(const fault of ['fulfilled','stale','positive','po-price']){
  const f=fixture(),plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);
  if(fault==='fulfilled')f.records.get(11).items[0].quantityfulfilled=1;
  if(fault==='stale')f.records.get(11).items[1].description='External change';
  if(fault==='positive')plan.orders[0].target.lines[1].rate='25%';
  if(fault==='po-price')plan.orders[1].target.lines[0].rate='100';
  if(fault==='po-price')await assert.rejects(()=>f.boundary.apply(plan.orders[1]));
  else await assert.rejects(()=>applySpecialAdjustmentPlan(plan,f.boundary));
  assert.deepEqual(f.saves,[],fault);
 }
});
test('a later review can remove its discount and add PALLET without duplicating material',async()=>{
 const f=fixture(),first=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);
 await applySpecialAdjustmentPlan(first,f.boundary);
 const order=f.orders[0];order.lines[0]={...order.lines[0],quantity:36,rate:10,toQuantity:36,nativeDiscountPercent:25,toNativeDiscountPercent:0};
 order.pallets={fromQuantity:0,toQuantity:5,rate:40,unitId:246};
 const second=await prepareSpecialAdjustmentPlan({orders:[order]},f.boundary);
 await applySpecialAdjustmentPlan(second,f.boundary);
 assert.deepEqual(f.records.get(11).items.map(x=>[x.item,x.quantity,x.rate]),[[2055,36,10],[2055,10,20],[1784,5,40]]);
});
test('a durable JSONB plan can reorder object keys without losing its baseline or retry identity',async()=>{
 const f=fixture(),plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,reorder(value[key])])):value;
 const saved=reorder(plan);await applySpecialAdjustmentPlan(saved,f.boundary);await applySpecialAdjustmentPlan(saved,f.boundary);
 assert.deepEqual(f.saves,[11,12]);
});
test('property: native insertion preserves keys, links and exact negative percentage text',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),async(percent)=>{
  const f=fixture();f.orders[0].lines[0].toNativeDiscountPercent=percent/100;
  const plan=await prepareSpecialAdjustmentPlan({orders:f.orders},f.boundary);await applySpecialAdjustmentPlan(plan,f.boundary);
  const items=f.records.get(11).items;assert.equal(items[1].rate,`-${percent/100}%`);
  assert.equal(items[0].lineuniquekey,101);assert.equal(items[0].createdpo,12);assert.equal(items[2].lineuniquekey,102);
 }),{numRuns:60,seed:260929});
});
test('production discount readiness requires the active item and never an uploaded write-script capability',async()=>{
 let calls=0;
 const boundary={restlet:async()=>{throw Error('Order operations must not use RESTlet');},queryAll:async sql=>{
  calls++;assert.match(sql,/id=10716.*itemtype='Discount'.*isinactive='F'/);return [{id:10716}];}};
 await assertSpecialDiscountRestReady(boundary);assert.equal(calls,1);
 await assert.rejects(()=>assertSpecialDiscountRestReady({...boundary,queryAll:async()=>[]}),{code:'SPECIAL_DISCOUNT_ITEM_REQUIRED'});
 const source=fs.readFileSync('src/netsuite.js','utf8');
 const section=source.slice(source.indexOf('export async function assertSpecialDiscountRestReady'),source.indexOf('export async function applySpecialQuantityPlanInNetSuite'));
 assert.doesNotMatch(section,/configuredRestletJson|action:\s*['"](?:health|specialOrderAdjustment|createSpecialSalesOrder)/);
});
