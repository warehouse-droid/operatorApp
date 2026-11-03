import {isOther,OTHER_WOR_VEHICLE} from '../../public/repair/targets.js';
import {reference,fail,amount,tax,totals} from '../../public/repair/domain.js';
import {createHash} from 'node:crypto';
import {worChildren,verifyWorChild} from './wor-lines.js';
import {servicePrices} from './service-prices.js';
export function orderFingerprint(order){return createHash('sha256').update(JSON.stringify({customer:String(order.entity?.id),form:String(order.customForm?.id),wor:String(order.custbody14?.id),total:Number(order.total),lines:(order.item?.items||[]).map(line=>({item:String(line.item?.id),quantity:Number(line.quantity),rate:Number(line.rate),description:line.description||'',tax:String(line.taxCode?.id)}))})).digest('hex');}
const postingVehicle=job=>isOther(job)?{...job.data.vehicle,...OTHER_WOR_VEHICLE}:job.data.vehicle;
const ref=value=>({id:reference(value)});
const approved=lines=>lines.filter(line=>line.decision==='approved');
function taxCode(bps,mapping) {
 const id=mapping.taxCodes?.[String(bps)]||(bps===1300?mapping.taxCodeId:null);
 if(!id) throw fail(`Configure the NetSuite tax code for ${(bps/100).toFixed(2)}%.`,409,'REPAIR_TAX_MAPPING');
 return ref(id);
}
export function inspectionWor(job,_mapping) {
 const v=postingVehicle(job);
 return {externalId:`repair-${job.id}-wor`,altName:v.alias||v.plate||v.serial,
  custrecord_wo_vehicle:ref(v.netsuiteId),custrecord_wo_customer:ref(v.customerId),custrecord_wo_status:ref('1'),
  custrecord147:job.data.defect,custrecord124:v.plate||'',custrecord126:v.serial||'',custrecord129:v.alias||'',
  custrecord132:new Date(job.createdAt||Date.now()).toISOString().slice(0,10)};
}
function inspectionLine(job,mapping) {
 return {item:ref(mapping.inspectionItemId),description:`Inspection · ${job.number}`,quantity:1,price:{id:'-1'},
  rate:job.inspectionFeeMinor/100,taxCode:taxCode(job.inspectionTaxBps,mapping)};
}
export function inspectionSos(job,mapping,worId) {
 if(job.company==='MBR') throw fail('Internal MBR repairs do not create an SOS.');
 const v=postingVehicle(job),fee=inspectionLine(job,mapping);fee.price={id:'-1'};
 return {externalId:`repair-${job.id}-sos`,customForm:ref(mapping.sosFormId),subsidiary:ref(mapping.subsidiaryId),
  location:ref(mapping.locationId),currency:ref(mapping.currencyId),entity:ref(v.customerId),custbody14:ref(worId),
  custbody17:v.serial||'',custbody18:v.plate||'',custbody19:v.alias||'',custbody3:ref('1'),custbody5:ref('1'),
  memo:`${job.number} · Inspection first; quote approval required for repairs.`,toBeEmailed:false,item:{items:[fee]}};
}
export function completionSos(job,mapping,worId,lines) {
 const result=inspectionSos(job,mapping,worId);const accepted=approved(lines);
 if(accepted.length) result.item.items.push({item:ref(mapping.discountItemId),description:'Inspection fee credit — applied once',
  price:{id:'-1'},rate:-job.inspectionFeeMinor/100});
 result.item.items.push(...accepted.map(line=>({item:ref(line.itemId),description:line.description,
  quantity:line.quantityMilli/1000,price:{id:'-1'},rate:line.unitMinor/100,taxCode:taxCode(line.taxBps??job.inspectionTaxBps,mapping)})));
 result.memo=`${job.number} · ${accepted.length?'Approved repair scope completed':'Repair declined; inspection only'}`;
 return result;
}
export function purchaseBill(purchase,mapping) {
 return {externalId:`repair-purchase-${purchase.id}`,customForm:ref(mapping.billFormId),subsidiary:ref(mapping.subsidiaryId),
  currency:ref(mapping.currencyId),entity:ref(purchase.vendorId),location:ref(mapping.locationId),tranId:purchase.invoiceRef,
  tranDate:purchase.purchaseDate,memo:`Repair purchase ${purchase.number||purchase.id}`,expense:{items:purchase.lines.map(line=>({
   account:ref(line.accountId||mapping.partsAccountId),class:ref(mapping.classId),location:ref(mapping.locationId),
   amount:amount(line.quantityMilli,line.unitMinor)/100,taxCode:taxCode(line.taxBps,mapping),
   memo:[line.requestNumber,line.description].filter(Boolean).join(' · '),isBillable:false}))}};
}
export function inspectionLabor(job,mapping,worId,credited=false) {
 return {externalId:`repair-${job.id}-inspection`,custrecord141:ref(worId),custrecord209:ref(mapping.inspectionItemId),
  custrecord148:'Inspection',custrecord156:1,custrecord157:credited?0:job.inspectionFeeMinor/100,
  custrecord154:job.data.inspectionComplete===true,custrecord212:`${job.number}; meter ${job.data.meter||''} ${job.data.meterUnit||''}. ${credited?'Inspection fee credited against approved repair scope.':''}`};
}
export function workChildren(job,mapping,worId,lines,usages=[],work=[]) {
 return approved(lines).map(line=>{
  const externalId=`repair-${job.id}-line-${line.id}`;
  if(line.kind==='part'){
   const entries=usages.filter(entry=>entry.quoteLineId===line.id);
   const issued=entries.filter(x=>x.kind==='issue').reduce((n,x)=>n+x.quantityMilli,0)/1000;
   const returned=entries.filter(x=>x.kind==='return').reduce((n,x)=>n+x.quantityMilli,0)/1000;
   return {recordType:'customrecord247',payload:{externalId,custrecord159:ref(worId),custrecord160:ref(line.itemId),
    custrecord161:line.description,custrecord162:issued,custrecord167:returned,custrecord169:line.quantityMilli/1000,custrecord170:line.unitMinor/100}};
  }
  const entries=work.filter(entry=>entry.data?.quoteLineId===line.id),actualHours=entries.reduce((n,x)=>n+Number(x.data?.hoursMilli||0),0)/1000;
  const actualCost=entries.reduce((n,x)=>n+Number(x.data?.hoursMilli||0)*Number(x.data?.hourlyCostMinor||0),0);
  return {recordType:'customrecord246',payload:{externalId,custrecord141:ref(worId),custrecord209:ref(line.itemId),
   custrecord148:line.description,custrecord152:actualHours,custrecord156:actualHours,custrecord157:actualHours?actualCost/(actualHours*100000):0,custrecord154:true,
   custrecord153:work.filter(entry=>entry.data?.quoteLineId===line.id).map(entry=>entry.data.done).join('\n').slice(0,3900)}};
 });
}

/** Reads and mutations are injected; tests never contact NetSuite. */
export function createRepairNetSuite({record,queryAll}) {
 async function read(type,id) {
  try{return (await record(type,id,{method:'GET'})).data;}
  catch(error){if(error.status===404) return null;throw error;}
 }
 async function create(type,payload) {
  let existing=await read(type,`eid:${payload.externalId}`);
  if(!existing){await record(type,null,{method:'POST',body:payload});existing=await read(type,`eid:${payload.externalId}`);}
  if(!existing?.id||existing.externalId!==payload.externalId) throw fail('NetSuite record identity could not be verified.',409,'REPAIR_REMOTE_IDENTITY');
  return existing;
 }
 async function update(type,id,payload) {
  await record(type,id,{method:'PATCH',body:payload});const result=await read(type,id);
  if(!result?.id) throw fail('NetSuite update could not be verified.',409,'REPAIR_REMOTE_VERIFY');return result;
 }
 async function link(kind,id,job,purchase) {
  const types={wor:'customrecord_mbr_work_order',sos:'salesOrder',bill:'vendorBill'};
  if(!types[kind]) throw fail('Choose WOR, SOS or Bill.');
  const result=await read(types[kind],reference(id));if(!result) throw fail('NetSuite record was not found.',404);
  if(kind==='wor'&&String(result.custrecord_wo_vehicle?.id)!==String(postingVehicle(job).netsuiteId)) throw fail('WOR belongs to another vehicle.',409);
  if(kind==='sos'&&(job.company==='MBR'||String(result.entity?.id)!==String(job.data.vehicle.customerId)||String(result.customForm?.id)!=='183')) throw fail('SOS customer or form does not match this repair.',409);
  if(kind==='bill'&&(String(result.entity?.id)!==purchase.vendorId||String(result.tranId)!==purchase.invoiceRef)) throw fail('Bill supplier or invoice does not match.',409);
  return result;
 }
 async function inspection(job,mapping,remember) {
  const wor=job.data.worId?await read('customrecord_mbr_work_order',job.data.worId):await create('customrecord_mbr_work_order',inspectionWor(job,mapping));
  if(!wor?.id||String(wor.custrecord_wo_vehicle?.id)!==String(postingVehicle(job).netsuiteId)) throw fail('Linked WOR is missing or belongs to another vehicle.',409);await remember({worId:String(wor.id),worRef:wor.name});
  await create('customrecord246',inspectionLabor(job,mapping,wor.id));
  if(job.company==='MBR') return {worId:String(wor.id),worRef:wor.name};
  const sos=job.data.sosId?await read('salesOrder',job.data.sosId):await create('salesOrder',inspectionSos(job,mapping,wor.id));
  if(!sos?.id||String(sos.entity?.id)!==String(job.data.vehicle.customerId)) throw fail('Inspection SOS could not be verified.',409);
  await update('customrecord_mbr_work_order',wor.id,{custrecord_wo_so:ref(sos.id)});
  return {worId:String(wor.id),worRef:wor.name,sosId:String(sos.id),sosRef:sos.tranId,sosFingerprint:orderFingerprint(sos)};
 }
 async function complete(job,mapping,lines,usages,work) {
  if(!job.data.worId) throw fail('Inspection WOR is still pending.',409);
  if(job.company!=='MBR'){
   const sos=await read('salesOrder',job.data.sosId);
   if(!sos||String(sos.entity?.id)!==String(job.data.vehicle.customerId)) throw fail('Linked SOS identity changed.',409);
   if(!['A','B','D','E','F'].includes(String(sos.orderStatus?.id))||sos.item?.items?.some(line=>Number(line.quantityBilled||0)>0)){
    const expected=totals(lines,job.inspectionFeeMinor,job.inspectionTaxBps,job.inspectionFeeMinor);
    throw fail(`Accounting reconciliation required: SOS is billed or closed. If the inspection was already invoiced, the remaining repair charge before tax is ${(expected.remainingMinor/100).toFixed(2)} CAD.`,409,'REPAIR_ACCOUNTING_RECONCILIATION');
   }
   if(!job.data.sosFingerprint||orderFingerprint(sos)!==job.data.sosFingerprint)throw fail('SOS was changed outside Repair or lacks a verified snapshot. Office reconciliation is required.',409,'REPAIR_EXTERNAL_CHANGE');
  }
  const wor=await read('customrecord_mbr_work_order',job.data.worId);
  if(!wor?.id||String(wor.custrecord_wo_vehicle?.id)!==String(postingVehicle(job).netsuiteId)||String(wor.custrecord_wo_customer?.id)!==String(job.data.vehicle.customerId))throw fail('WOR equipment or customer changed outside Repair. Office reconciliation is required.',409,'REPAIR_REMOTE_IDENTITY');
  const children=workChildren(job,mapping,job.data.worId,lines,usages,work),activeIds=new Set(children.map(child=>child.payload.externalId));
  for(const [type,parent,zero] of [['customrecord246','custrecord141',{custrecord156:0,custrecord157:0}],['customrecord247','custrecord159',{custrecord169:0,custrecord170:0}]]){
   const existing=await queryAll(`SELECT id,externalid FROM ${type} WHERE ${parent}=${reference(job.data.worId)}`);
   for(const child of existing)if(String(child.externalid||'').startsWith(`repair-${job.id}-line-`)&&!activeIds.has(child.externalid))await update(type,child.id,zero);
  }
  for(const child of children){const found=await create(child.recordType,child.payload);await update(child.recordType,found.id,child.payload);}
  const inspectionPayload=inspectionLabor(job,mapping,job.data.worId,approved(lines).length>0);inspectionPayload.custrecord152=work.filter(entry=>entry.phase==='inspection').reduce((n,entry)=>n+Number(entry.data.hoursMilli||0),0)/1000;
  const inspection=await create('customrecord246',inspectionPayload);await update('customrecord246',inspection.id,inspectionPayload);
  await update('customrecord_mbr_work_order',job.data.worId,{custrecord_wo_status:ref(job.status==='re_inspect'?'1':job.receipt==='accepted'?'5':'4')});
  if(job.company==='MBR') return {updated:true};
  const payload=completionSos(job,mapping,job.data.worId,lines);
  const result=await record('salesOrder',job.data.sosId,{method:'PATCH',body:payload,replaceItems:true});
  const verified=await read('salesOrder',job.data.sosId);const expected=totals(lines,job.inspectionFeeMinor,job.inspectionTaxBps);
  if(Math.round(Number(verified?.total)*100)!==expected.totalMinor) throw fail('SOS totals differ from the approved quote; accounting review required.',409,'REPAIR_REMOTE_TOTAL');
  return {updated:true,status:result.status,sosFingerprint:orderFingerprint(verified)};
 }
 return {read,create,update,link,inspection,complete,fingerprint:orderFingerprint,
  async postWor(job,mapping,lines,usages,work,remember){
   const children=worChildren(job,mapping,lines,usages,work);
   const wor=job.data.worId?await read('customrecord_mbr_work_order',job.data.worId):await create('customrecord_mbr_work_order',inspectionWor(job,mapping));
   if(!wor?.id||String(wor.custrecord_wo_vehicle?.id)!==String(postingVehicle(job).netsuiteId)||String(wor.custrecord_wo_customer?.id)!==String(job.data.vehicle.customerId))throw fail('WOR equipment or customer does not match this request.',409,'REPAIR_REMOTE_IDENTITY');
   if(wor.custrecord_wo_so?.id&&String(wor.custrecord_wo_so.id)!==String(job.data.sosId||''))throw fail('WOR is linked to another SOS. Reconcile the link before posting.',409,'REPAIR_REMOTE_IDENTITY');
   await remember({worId:String(wor.id),worRef:wor.name||wor.altName});
   for(const child of children)child.payload[child.type==='customrecord246'?'custrecord141':'custrecord159']=ref(wor.id);
   const active=new Set(children.map(child=>child.payload.externalId));
   for(const [type,parent,zero] of [['customrecord246','custrecord141',{custrecord152:0,custrecord156:0,custrecord157:0}],['customrecord247','custrecord159',{custrecord162:0,custrecord167:0,custrecord169:0,custrecord170:0}]]){
    const existing=await queryAll(`SELECT id,externalid FROM ${type} WHERE ${parent}=${reference(wor.id)}`);
    for(const child of existing)if(String(child.externalid||'').startsWith(`repair-${job.id}-`)&&!active.has(child.externalid))await update(type,child.id,zero);
   }
   for(const child of children){const found=await create(child.type,child.payload);const parent=child.type==='customrecord246'?'custrecord141':'custrecord159';if(String(found[parent]?.id)!==String(wor.id))throw fail('A workforce or parts record belongs to another WOR.',409,'REPAIR_REMOTE_IDENTITY');verifyWorChild(await update(child.type,found.id,child.payload),child.payload);}
   const completed=await update('customrecord_mbr_work_order',wor.id,{custrecord_wo_status:ref('4')});if(String(completed.custrecord_wo_status?.id)!=='4')throw fail('WOR completion could not be verified.',409,'REPAIR_REMOTE_VERIFY');
   return {worId:String(wor.id),worRef:completed.name||wor.name||wor.altName};
  },
  async postSos(job,mapping,lines,remember){
   if(job.company==='MBR')throw fail('Internal rental repairs do not require SOS.',409);
   if(!job.data.worId||!job.data.worPostedAt)throw fail('Post the completed WOR first.',409);
   const wor=await read('customrecord_mbr_work_order',job.data.worId);
   if(!wor?.id||String(wor.custrecord_wo_vehicle?.id)!==String(postingVehicle(job).netsuiteId)||String(wor.custrecord_wo_customer?.id)!==String(job.data.vehicle.customerId))throw fail('WOR identity changed. Reconcile before linking the SOS.',409,'REPAIR_REMOTE_IDENTITY');
   const payload={...completionSos(job,mapping,wor.id,lines),orderStatus:{id:'B'}};
   let sos=job.data.sosId?await read('salesOrder',job.data.sosId):await read('salesOrder',`eid:${payload.externalId}`);
   if(sos){
    if(String(sos.entity?.id)!==String(job.data.vehicle.customerId)||String(sos.customForm?.id)!==String(mapping.sosFormId)||sos.custbody14?.id&&String(sos.custbody14.id)!==String(wor.id))throw fail('SOS customer, form or WOR link does not match.',409,'REPAIR_REMOTE_IDENTITY');
    if(!['A','B','D','E','F'].includes(String(sos.orderStatus?.id))||sos.item?.items?.some(l=>Number(l.quantityBilled||0)>0))throw fail('SOS is billed or closed. Accounting reconciliation is required.',409,'REPAIR_ACCOUNTING_RECONCILIATION');
    if(job.data.sosId&&(!job.data.sosFingerprint||orderFingerprint(sos)!==job.data.sosFingerprint))throw fail('SOS changed outside Repair. Reconcile before posting.',409,'REPAIR_EXTERNAL_CHANGE');
    if(wor.custrecord_wo_so?.id&&String(wor.custrecord_wo_so.id)!==String(sos.id))throw fail('WOR already links to another SOS.',409,'REPAIR_REMOTE_IDENTITY');
    delete payload.orderStatus;await record('salesOrder',sos.id,{method:'PATCH',body:payload,replaceItems:true});sos=await read('salesOrder',sos.id);
   }else{if(wor.custrecord_wo_so?.id)throw fail('Reconcile the SOS already linked to this WOR.',409,'REPAIR_REMOTE_IDENTITY');sos=await create('salesOrder',payload);}
   await remember({sosId:String(sos.id),sosRef:sos.tranId,sosFingerprint:orderFingerprint(sos)});
   if(String(sos.custbody14?.id)!==String(wor.id)||Math.round(Number(sos.total)*100)!==totals(lines,job.inspectionFeeMinor,job.inspectionTaxBps).totalMinor)throw fail('SOS link or approved quote totals could not be verified.',409,'REPAIR_REMOTE_TOTAL');
   const linked=await update('customrecord_mbr_work_order',wor.id,{custrecord_wo_so:ref(sos.id)});
   if(String(linked.custrecord_wo_so?.id)!==String(sos.id))throw fail('The WOR backlink to SOS could not be verified.',409,'REPAIR_REMOTE_VERIFY');
   return {sosId:String(sos.id),sosRef:sos.tranId,sosFingerprint:orderFingerprint(sos),sosRemoteStatus:sos.orderStatus?.refName||sos.orderStatus?.id};
  },
  async bill(purchase,mapping){
   const payload=purchaseBill(purchase,mapping),invoice=String(purchase.invoiceRef).replaceAll("'","''");
   const duplicates=await queryAll(`SELECT id,externalid FROM transaction WHERE type='VendBill' AND entity=${reference(purchase.vendorId)} AND tranid='${invoice}'`);
   if(duplicates.some(row=>row.externalid!==payload.externalId))throw fail('An existing supplier invoice was found in NetSuite. Verify and manually link its Bill instead of creating a duplicate.',409,'REPAIR_DUPLICATE_BILL');
   const bill=await create('vendorBill',payload);const total=purchase.lines.reduce((n,line)=>{const base=amount(line.quantityMilli,line.unitMinor);return n+base+tax(base,line.taxBps);},0);
   if(String(bill.entity?.id)!==String(purchase.vendorId)||String(bill.tranId)!==purchase.invoiceRef||Math.round(Number(bill.total)*100)!==total)throw fail('Vendor Bill identity or total differs from the purchase. Office reconciliation is required.',409,'REPAIR_BILL_VERIFY');
   return {billId:String(bill.id),billRef:bill.tranId};
  },
  async vehicles(){return queryAll('SELECT id,name,altname,custrecord68 AS plate,custrecord78 AS alias,custrecord70 AS serial,custrecord69 AS item_id,custrecord77 AS customer_id,BUILTIN.DF(custrecord77) AS customer_name,custrecord76 AS vehicle_type,isinactive FROM customrecord240 ORDER BY id');},
  async machines(){return queryAll('SELECT id,name,altname,custrecord1 AS item_id,custrecord2 AS serial,custrecord50 AS alias,custrecord30 AS subsidiary_id,custrecord48 AS manufacturer,custrecord49 AS model,custrecord51 AS description,isinactive FROM customrecord_mrb_machine_master ORDER BY id');},
  async customers(search){const clean=String(search||'').slice(0,100).replaceAll("'","''");return queryAll(`SELECT id,entityid,companyname FROM customer WHERE isinactive='F' AND (LOWER(entityid) LIKE LOWER('%${clean}%') OR LOWER(companyname) LIKE LOWER('%${clean}%')) ORDER BY entityid FETCH FIRST 30 ROWS ONLY`);},
  async vendors(search){const clean=String(search||'').slice(0,100).replaceAll("'","''");return queryAll(`SELECT id,entityid,companyname FROM vendor WHERE isinactive='F' AND (LOWER(entityid) LIKE LOWER('%${clean}%') OR LOWER(companyname) LIKE LOWER('%${clean}%')) ORDER BY entityid FETCH FIRST 30 ROWS ONLY`);},
  async services(currencyId='1'){
   const currency=reference(currencyId),rows=await queryAll(`SELECT i.id,i.itemid,i.displayname,i.saleunit AS unit_id,p.saleunit AS price_unit_id,p.unitprice AS base_price,p.currency AS currency_id,BUILTIN.DF(p.currency) AS currency_name,p.pricelevel AS price_level_id,BUILTIN.DF(p.pricelevel) AS price_level,BUILTIN.DF(p.quantity) AS minimum_quantity FROM item i LEFT JOIN pricing p ON p.item=i.id AND p.currency=${currency} AND BUILTIN.DF(p.pricelevel)='Base Price' WHERE i.isinactive='F' AND (UPPER(i.itemid) LIKE 'SVC-%' OR i.id=10555) ORDER BY i.itemid,p.quantity FETCH FIRST 1000 ROWS ONLY`);
   return servicePrices(rows,currency);
  },
  async technicians(){
   const [work,parts]=await Promise.all([queryAll('SELECT DISTINCT custrecord149 AS first_id,BUILTIN.DF(custrecord149) AS first_name,custrecord214 AS second_id,BUILTIN.DF(custrecord214) AS second_name,custrecord215 AS third_id,BUILTIN.DF(custrecord215) AS third_name FROM customrecord246'),queryAll('SELECT DISTINCT custrecord165 AS id,BUILTIN.DF(custrecord165) AS name FROM customrecord247 WHERE custrecord165 IS NOT NULL')]);
   const people=[...parts,...work.flatMap(row=>['first','second','third'].map(key=>({id:row[key+'_id'],name:row[key+'_name']})))].filter(row=>row.id&&row.name);
   return [...new Map(people.map(row=>[String(row.id),{id:String(row.id),name:row.name.trim(),active:true,source:'wor'}])).values()];
  }
 };
}
