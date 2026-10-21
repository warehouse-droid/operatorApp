/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function fixture() {
  const so={header:{orderstatus:'B',location:1,entity:10,discountrate:'-10%',discountitem:2022},lines:[
    {lineuniquekey:101,item:2055,quantity:2,units:865,rate:50,description:'A'},
    {lineuniquekey:102,item:-2,description:'Subtotal'},
    {lineuniquekey:103,item:2022,rate:-10,description:'10% discount'},
    {lineuniquekey:104,item:2055,quantity:3,units:865,rate:60,description:'B'}]};
  const request={action:'createSpecialPurchaseOrder',entityId:11,caseId:67,vendorId:331,locationId:1,
    lines:[{remoteLineId:101,quantity:2,unitId:865,description:'A',salesRate:50,purchaseRate:20},
      {remoteLineId:104,quantity:3,unitId:865,description:'B',salesRate:60,purchaseRate:30}]};
  let entry,saves=0,lose=false,ignore=false,corrupt=false,corruptBefore=false;
  const modules={
    'N/error':{create:({name,message})=>Object.assign(Error(message),{name})},'N/log':{audit(){},error(){}},'N/render':{},
    'N/runtime':{accountId:'TEST',envType:'SANDBOX',EnvType:{SANDBOX:'SANDBOX'},getCurrentUser:()=>({id:1,role:1}),getCurrentScript:()=>({getRemainingUsage:()=>5000})},
    'N/record':{Type:{SALES_ORDER:'salesorder'},load:({type,id,isDynamic})=>{
      assert.equal(type,'salesorder');assert.equal(id,11);assert.equal(isDynamic,true);
      const data=structuredClone(so);let selected;
      return {getValue:({fieldId})=>data.header[fieldId],getLineCount:()=>data.lines.length,
        getSublistValue:({fieldId,line})=>data.lines[line][fieldId],selectLine:({line})=>{selected=line;},
        setCurrentSublistValue:({fieldId,value})=>{assert.ok(['povendor','porate','createpo'].includes(fieldId));data.lines[selected][fieldId]=value;if(corruptBefore)data.lines[0].rate=999;},commitLine(){},
        save:()=>{saves++;for(const line of data.lines)if(line.createpo==='SpecOrd'&&!ignore)line.createdpo=22;if(corrupt)data.lines[0].rate=999;Object.assign(so,data);if(lose){lose=false;throw Error('Lost ACK');}return 11;}};
    }}
  };
  vm.runInNewContext(readFileSync('netsuite-smart-scm-picking-ticket-restlet.js','utf8'),{define:(names,factory)=>{entry=factory(...names.map(n=>modules[n]));}},{filename:`${process.cwd()}/netsuite-smart-scm-picking-ticket-restlet.js`});
  return {so,request,call:(r=request)=>JSON.parse(JSON.stringify(entry.post(r))),saves:()=>saves,lose:()=>{lose=true;},ignore:()=>{ignore=true;},corrupt:()=>{corrupt=true;},corruptBefore:()=>{corruptBefore=true;}};
}
test('native SuiteScript creates one linked PO for exact reviewed materials and leaves every commercial value intact',()=>{
  const f=fixture(),before=structuredClone(f.so);
  assert.equal(f.call({action:'health'}).capabilities.createSpecialPurchaseOrder,true);
  assert.equal(f.call().purchaseOrderId,22);assert.equal(f.saves(),1);
  for(const [i,line] of before.lines.entries())for(const field of Object.keys(line))assert.equal(f.so.lines[i][field],line[field]);
  assert.deepEqual(f.so.header,before.header);
  assert.equal(f.call().purchaseOrderId,22);assert.equal(f.saves(),1);
});
test('lost native save response recovers existing links without saving again',()=>{
  const f=fixture();f.lose();assert.throws(()=>f.call());assert.equal(f.saves(),1);
  assert.equal(f.call().purchaseOrderId,22);assert.equal(f.saves(),1);
});
test('native script rejects changed prices, quantities, identities, partial links and pending creation before saving',()=>{
  for(const patch of [{quantity:4},{rate:60},{description:'Changed'},{units:99},{item:1784},{isclosed:true},{quantityfulfilled:1},{quantitybilled:1},{createpo:'DropShip'},{createpo:'SpecOrd'},{createdpo:22}]){
    const f=fixture();Object.assign(f.so.lines[0],patch);assert.throws(()=>f.call(),{name:'MBBS_SPECIAL_NATIVE_PO_CONFLICT'});assert.equal(f.saves(),0);
  }
  for(const change of [f=>{f.request.lines=[];},f=>{f.request.lines[1].remoteLineId=101;},f=>{f.request.lines[0].purchaseRate=-1;},f=>{f.so.header.location=2;},f=>{f.so.header.orderstatus='D';}]){
    const f=fixture();change(f);assert.throws(()=>f.call());assert.equal(f.saves(),0);
  }
});
test('native script detects ignored creation flags and post-save SO price changes',()=>{
  for(const type of ['ignore','corrupt']){const f=fixture();f[type]();assert.throws(()=>f.call(),{name:'MBBS_SPECIAL_NATIVE_PO_CONFLICT'});assert.equal(f.saves(),1);}
});


test('dynamic sourcing cannot silently change SO commercial values before saving',()=>{
  const f=fixture();f.corruptBefore();assert.throws(()=>f.call(),{name:'MBBS_SPECIAL_NATIVE_PO_CONFLICT'});assert.equal(f.saves(),0);assert.equal(f.so.lines[0].rate,50);
});
