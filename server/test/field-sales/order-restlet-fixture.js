import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';

// Only SuiteScript's external record/search/runtime boundary is simulated. Every
// validation, intent stamp, recovery and response executes the shipped RESTlet.
export function sandbox({multi=true,writes=true,environment='SANDBOX',suiteTax=false}={}){
 const records=new Map(),relationships=[],saves=[];let sequence=0,script,loseType=null,changeOnSave=null;
 const fields=['custbody_fs_quote_revision','custbody_fs_quote_hash','custbody_fs_state_hash','custbody_fs_company'];
 function wrap(data){return {
  id:data.id,getFields:()=>fields,getValue:f=>data.fields[typeof f==='string'?f:f.fieldId],setValue:({fieldId,value})=>{data.fields[fieldId]=value;},
  getLineCount:({sublistId})=>(data.sublists[sublistId]||[]).length,
  getSublistValue:({sublistId,fieldId,line})=>data.sublists[sublistId]?.[line]?.[fieldId],
  insertLine:({sublistId,line})=>{data.sublists[sublistId]||=[];data.sublists[sublistId].splice(line,0,{});},
  setSublistValue:({sublistId,fieldId,line,value})=>{data.sublists[sublistId]||=[];data.sublists[sublistId][line]||={};data.sublists[sublistId][line][fieldId]=value;},
  getSublistSubrecord:()=>({setValue:({fieldId,value})=>{data.address||={};data.address[fieldId]=value;}}),
  getSubrecord:({fieldId})=>({setValue:({fieldId:f,value})=>{if(f==='addrtext'){data.fields[fieldId==='billingaddress'?'billaddress':'shipaddress']=value;}}}),
  save:()=>{
   if(data.fields.externalid&&[...records.values()].some(r=>r.type===data.type&&r.id!==data.id&&r.fields.externalid===data.fields.externalid)){throw new Error('Duplicate external ID');}
   data.id||=String(++sequence);data.fields.tranid||='SO-'+data.id;
   if(data.type==='customersubsidiaryrelationship'){relationships.push(structuredClone(data));}
   if(data.type==='salesorder'){
    let subtotal=0;for(const l of data.sublists.item||[]){l.amount=Math.round(l.quantity*l.rate*100)/100;subtotal+=Math.round(l.amount*100);}
    const tax=Math.round(subtotal*.13);Object.assign(data.fields,{subtotal:subtotal/100,taxtotal:tax/100,total:(subtotal+tax)/100});
    if(changeOnSave&&String(data.fields.custbody_fs_state_hash).startsWith('pending:')){data.fields[changeOnSave]='External edit';}
   }
   records.set(data.type+':'+data.id,structuredClone(data));saves.push(data.type);
   if(loseType===data.type){loseType=null;throw new Error('Lost response after commit');}return data.id;
  }
 };}
 const record={Type:{SALES_ORDER:'salesorder',CUSTOMER:'customer',CURRENCY:'currency'},
  create:({type,defaultValues})=>wrap({type,fields:{customform:defaultValues?.customform},sublists:{}}),
  load:({type,id})=>{if(type==='currency'){return {getValue:()=> 'CAD'};}const data=records.get(type+':'+id);if(!data){throw new Error('Record not found');}return wrap(structuredClone(data));}};
 const search={Type:{ITEM:'item'},lookupFields:()=>({isinactive:false,subsidiary:[{value:'1'},{value:'3'},{value:'7'}],saleunit:[{value:'1',text:'Each'}]}),create:({type,filters})=>({run:()=>({getRange:()=>{
  if(type==='customersubsidiaryrelationship'){return relationships.filter(r=>String(r.fields.entity)===String(filters[0][2])).map(r=>({getValue:f=>r.fields[f]}));}
  return [...records.values()].filter(r=>r.type===type&&r.fields.externalid===filters[0][2]).map(r=>({getValue:()=>r.id}));
 }})})};
 const runtime={envType:environment,EnvType:{SANDBOX:'SANDBOX'},isFeatureInEffect:({feature})=>feature==='MULTISUBSIDIARYCUSTOMER'?multi:feature==='TAX_OVERHAULING'?suiteTax:false,getCurrentScript:()=>({getParameter:()=>writes})};
 const crypto={HashAlg:{SHA256:'sha256'},createHash:()=>{const h=createHash('sha256');return {update:({input})=>h.update(input),digest:()=>h.digest('hex')};}};
 vm.runInNewContext(readFileSync(new URL('../../netsuite-field-sales-restlet.js',import.meta.url),'utf8'),{define:(_deps,fn)=>{script=fn(record,search,runtime,crypto,{Encoding:{UTF_8:'utf8',HEX:'hex'}});}},{filename:new URL('../../netsuite-field-sales-restlet.js',import.meta.url).pathname});
 return {post:p=>JSON.parse(JSON.stringify(script.post(p))),records,relationships,saves,fields,loseNext:type=>{loseType=type;},editOnSave:field=>{changeOnSave=field;}};
}
export const payload=(company='MBT')=>({externalId:'field-sales-order-'+randomUUID(),customerExternalId:'field-sales-customer-'+randomUUID()+(company==='MBBS'?'-mbbs':'-mbt_mbr'),company,revision:1,payloadHash:'f'.repeat(64),number:'FS-'+company+'-000123',config:{subsidiaryId:company==='MBT'?'3':company==='MBR'?'7':'1',customerSubsidiaries:company==='MBBS'?['1']:['3','7'],salesOrderFormId:'3',currencyId:'1',locationId:'1',taxCodeId:'4'},customer:{name:'Example Builder',billing:{line1:'1 Test Road',city:'Toronto',province:'ON',postalCode:'M1A 1A1',country:'CA'}},jobsite:{address:'90 Belfield Road'},billToAddress:'1 Test Road',shipToAddress:'90 Belfield Road',confirmation:{confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z'},lines:[{company,itemId:'1',unitId:'1',quantity:'3',unitRate:'19.99',description:'Block'}]});
