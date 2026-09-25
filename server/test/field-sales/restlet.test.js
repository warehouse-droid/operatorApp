import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

function suiteScript() {
  const records=new Map();let id=0,script,loseResponse=false,environment='SANDBOX',writes=true,converted=false;
  const wrap=(data,version=0)=>({
    id:data.id,
    getValue:f=>data.fields[typeof f==='string'?f:f.fieldId],
    setValue:({fieldId,value})=>{data.fields[fieldId]=value;},
    getLineCount:({sublistId})=>sublistId==='item'?data.lines.length:0,
    getSublistValue:({fieldId,line})=>data.lines[line]?.[fieldId],
    setSublistValue:({fieldId,line,value})=>{data.lines[line]||={};data.lines[line][fieldId]=value;},
    removeLine:({line})=>data.lines.splice(line,1),
    save:()=>{
      if(data.id&&records.get(data.id).version!==version){throw new Error('RCRD_HAS_BEEN_CHANGED');}
      const internalId=data.id||String(++id);data.id=internalId;data.fields.tranid=`EST-${internalId}`;
      let subtotal=0;for(const line of data.lines){line.amount=Math.round(line.quantity*line.rate*100)/100;subtotal+=Math.round(line.amount*100);}const tax=Math.round(subtotal*.13);Object.assign(data.fields,{subtotal:subtotal/100,taxtotal:tax/100,total:(subtotal+tax)/100});
      records.set(internalId,{...structuredClone(data),version:version+1});
      if(loseResponse&&String(data.fields.custbody_fs_state_hash).startsWith('pending:')){loseResponse=false;throw new Error('Transport response lost after business commit');}
      return internalId;
    }
  });
  const record={Type:{ESTIMATE:'estimate',CUSTOMER:'customer',CURRENCY:'currency'},create:()=>wrap({fields:{},lines:[]}),load:({type,id:recordId})=>{
    if(type==='customer'){return {getValue:f=>f==='isinactive'?false:1,getLineCount:()=>1,getSublistValue:()=>2};}
    if(type==='currency'){return {getValue:()=> 'CAD'};}
    if(type==='inventoryitem'){return {getLineCount:()=>3,getSublistValue:({line})=>line+1,getSublistText:({line})=>['Base Price','TRADE','TRADE-A'][line],getMatrixHeaderCount:()=>1,getMatrixHeaderValue:()=>0,getMatrixSublistValue:({line})=>[29.99,24.99,19.99][line],getValue:()=>1,getText:()=> 'Each'};}
    const data=records.get(String(recordId));return wrap(structuredClone(data),data.version);
  }};
  const search={Type:{ESTIMATE:'estimate',TRANSACTION:'transaction',ITEM:'item'},lookupFields:()=>({isinactive:false,subsidiary:[{value:'1'},{value:'2'}],saleunit:[{value:'1',text:'Each'}]}),create:({type,filters})=>({run:()=>({getRange:()=>{
    if(type==='transaction'){return converted?[{}]:[];}
    if(type==='item'){return [{recordType:'inventoryitem',getValue:()=>1}];}
    const row=[...records.values()].find(r=>r.fields.externalid===filters[0][2]);return row?[{getValue:()=>row.id}]:[];
  }})})};
  const runtime={EnvType:{SANDBOX:'SANDBOX'},get envType(){return environment;},getCurrentScript:()=>({getParameter:()=>writes}),isFeatureInEffect:({feature})=>feature==='MULTICURRENCY'};
  const crypto={HashAlg:{SHA256:'sha256'},createHash:()=>{const hash=createHash('sha256');return {update:({input})=>hash.update(input),digest:()=>hash.digest('hex')};}};
  vm.runInNewContext(readFileSync(new URL('../../netsuite-field-sales-restlet.js',import.meta.url),'utf8'),{define:(_deps,fn)=>{script=fn(record,search,runtime,crypto,{Encoding:{UTF_8:'utf8',HEX:'hex'}});}},{filename:new URL('../../netsuite-field-sales-restlet.js',import.meta.url).pathname});
  return {post:p=>script.post(p),records,loseNext:()=>{loseResponse=true;},changeEnvironment:()=>{environment='PRODUCTION';},disableWrites:()=>{writes=false;},convert:()=>{converted=true;}};
}
const payload=(revision=1)=>({action:'write',externalId:'field-sales-123e4567-e89b-42d3-a456-426614174000-mbbs',quoteId:'123e4567-e89b-42d3-a456-426614174000',company:'MBBS',revision,payloadHash:`payload-${revision}`,number:'FS-000001',customerId:'1',config:{subsidiaryId:'1',formId:'3',currencyId:'1',closedStatusId:'9',openStatusId:'7',taxCodeId:'4'},jobsite:{address:'90 Belfield Road'},lines:[{itemId:'1',description:'Block',quantity:String(revision),unitRate:'100',unitId:'1'}],totals:{subtotalMinor:revision*10000,taxMinor:revision*1300,totalMinor:revision*11300}});
test('NS1 actual RESTlet recovers a lost create, updates same ID, closes and reopens it',()=>{
  const s=suiteScript(),p=payload();s.loseNext();assert.equal(s.post(p).ok,false);assert.equal(s.records.size,1);
  const recovered=s.post({action:'lookup',externalId:p.externalId,recover:p});assert.equal(recovered.ok,true);assert.equal(recovered.unmodified,true);assert.equal(recovered.totals.totalMinor,11300);
  const next=s.post({...payload(2),expectedRemoteHash:recovered.remoteHash});assert.equal(next.ok,true);assert.equal(next.internalId,recovered.internalId);assert.equal(next.totals.totalMinor,22600);
  const closed=s.post({...payload(3),lines:[],close:true,expectedRemoteHash:next.remoteHash});assert.equal(closed.closed,true);assert.equal(s.records.size,1);
  const reopened=s.post({...payload(4),expectedRemoteHash:closed.remoteHash});assert.equal(reopened.ok,true);assert.equal(reopened.closed,false);assert.equal(reopened.internalId,recovered.internalId);
});
test('NS2 actual RESTlet rejects external edits, conversion and production/write gates',()=>{
  const s=suiteScript(),created=s.post(payload());s.records.get(created.internalId).fields.memo='External change';
  const edited=s.post({...payload(2),expectedRemoteHash:created.remoteHash});assert.equal(edited.ok,false);assert.match(edited.message,/changed externally/);
  const c=suiteScript(),original=c.post(payload());c.convert();assert.equal(c.post({...payload(2),expectedRemoteHash:original.remoteHash}).ok,false);
  const p=suiteScript();p.changeEnvironment();assert.equal(p.post(payload()).ok,false);assert.equal(p.records.size,0);
  const w=suiteScript();w.disableWrites();assert.equal(w.post(payload()).ok,false);assert.equal(w.records.size,0);
});
test('NS3 actual RESTlet reads explicit CAD Trade pricing without creating transactions',()=>{
  const s=suiteScript(),price=s.post({action:'price',itemId:'1',currencyId:'1',company:'MBBS',quantity:'1'});assert.equal(price.ok,true);assert.equal(price.unitRate,'19.99');assert.equal(price.unitId,1);assert.equal(s.post({action:'price',itemId:'1',currencyId:'1',company:'MBR',quantity:'1'}).unitRate,'24.99');assert.equal(s.post({action:'price',itemId:'1',currencyId:'1'}).ok,false);assert.equal(s.records.size,0);
});
test('NS4 stock-unit labels cannot silently become different NetSuite sales units',()=>{
  const s=suiteScript(),p=payload();p.lines[0].unitId=null;p.lines[0].unit='Pallet';
  const invalid=s.post(p);assert.equal(invalid.ok,false);assert.match(invalid.message,/sales unit/i);assert.equal(s.records.size,0);
  const units=s.post({action:'units',itemId:'1'});assert.equal(units.unitId,'1');assert.equal(units.unit,'Each');assert.equal(s.records.size,0);
});

test('T4 RESTlet accepts three distinct companies and rejects duplicate companies',()=>{
  const s=suiteScript(),estimates=['MBBS','MBR','MBT'].map(company=>({...payload(),company}));
  assert.equal(s.post({action:'preflight',estimates}).ok,true);
  assert.equal(s.post({action:'preflight',estimates:[estimates[0],estimates[0]]}).ok,false);
});
