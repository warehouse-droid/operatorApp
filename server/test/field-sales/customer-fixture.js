import {randomUUID} from 'node:crypto';
import {query} from '../../src/db.js';
import {createFieldSalesRepository} from '../../src/field-sales/repository.js';

export async function customerFixture(options={}) {
 const actor={id:randomUUID(),role:'field_sales',display_name:'Test George'},admin={...actor,role:'admin'};
 await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,'Test George','test','test','field_sales',ARRAY['field_sales'])`,[actor.id]);
 const companies=Object.fromEntries(['MBBS','MBT','MBR'].map((c,i)=>[c,{name:c,taxBps:1300,subsidiaryId:String(i+1),salesOrderFormId:'3',currencyId:'1',taxCodeId:'4',locationId:'1',terms:'Test terms',validityDays:30}]));
 await query(`UPDATE field_sales_settings SET data=data||$1::jsonb`,[JSON.stringify({enabled:true,postingEnabled:false,salesOrderPostingEnabled:true,companies})]);
 const repo=createFieldSalesRepository(undefined,{postingEnabled:true,...options}),cmd=(kind,payload,a=actor)=>repo.command(a,{id:randomUUID(),kind,payload});
 const sites=[];for(const address of ['90 Belfield Road','3445 Kennedy Road']){sites.push((await cmd('jobsite.save',{id:randomUUID(),address})).jobsite);}
 const type=(await cmd('customerType.save',{id:randomUUID(),name:'Custom '+randomUUID()})).customerType;
 const netsuiteCustomers=options.linked===false?{}:{MBBS:'700',MBT_MBR:'701'};
 for(const id of Object.values(netsuiteCustomers)){await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1::bigint,$1::text,'Existing builder','Existing builder','CAD',true,now(),'test',repeat('a',64)) ON CONFLICT(netsuite_id) DO UPDATE SET active=true,currency='CAD'",[id]);}
 const customer=(await cmd('customer.save',{id:randomUUID(),name:'Example Builder',typeIds:[type.id],netsuiteCustomers,billing:{line1:'1 Test Road',city:'Toronto',province:'ON',postalCode:'M1V 4Y3',country:'CA'},representatives:[{id:randomUUID(),name:'Lee',phone:'416-555-0100',email:'lee@example.test'},{id:randomUUID(),name:'Sam',email:'sam@example.test'}]})).customer;
 for(const site of sites){await cmd('customer.link',{customerId:customer.id,jobsiteId:site.id,linked:true});}
 for(const c of ['MBBS','MBT','MBR']){await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit,unit_rate) VALUES($1,'984000001','TEST-ITEM','Sample item','BDL','36.99') ON CONFLICT(company,item_id) DO UPDATE SET active=true`,[c]);}
 const draft={id:randomUUID(),company:'MBBS',jobsiteId:sites[0].id,fieldSalesCustomerId:customer.id,customerRepresentativeId:customer.representatives[0].id,quoteDate:'2026-09-21',validUntil:'2026-10-21',note:'看见红单才上货',lines:[{id:randomUUID(),company:'MBBS',itemId:'984000001',sku:'TEST-ITEM',description:'Roofing',quantity:'120',unitRate:'36.99'},{id:randomUUID(),company:'MBBS',itemId:'984000001',description:'Roofing extra',quantity:'10',unitRate:'38.99'}]};
 return {actor,admin,repo,cmd,sites,type,customer,draft,companies};
}

export function fakeNetSuite({loseOrderResponse=false,wrongTotals=false}={}) {
 const customers=new Map(),orders=new Map(),calls=[];
 const transport=async(action,p)=>{
  calls.push(action);
  if(action==='customer.lookup'){
   // These accounts already exist in NetSuite. Track accounts read, never create.
   const c={found:true,internalId:p.linkedCustomerId,reference:'Existing builder',externalId:'created-in-netsuite',active:true,currencyId:'1',subsidiaries:p.linkedCustomerId==='700'?['1']:['2','3']};
   if(!['700','701'].includes(p.linkedCustomerId)){return {found:false};}
   customers.set(p.linkedCustomerId,c);return c;
  }
  if(action==='order.preflight'){return {ok:true};}
  if(action==='order.lookup'){return orders.get(p.externalId)||{found:false};}
  if(action==='order.create'){
   if(orders.has(p.externalId)){throw new Error('Duplicate order creation');}
   const o={found:true,internalId:String(900+orders.size),reference:'SO-TEST',externalId:p.externalId,payloadHash:p.payloadHash,revision:p.revision,customerId:p.customerNetsuiteId,company:p.company,unmodified:true,totals:{...p.totals,totalMinor:p.totals.totalMinor+(wrongTotals?1:0)}};
   orders.set(p.externalId,o);if(loseOrderResponse){throw new Error('Network timeout after save');}return o;
  }
  throw new Error('Unexpected action '+action);
 };
 return {transport,customers,orders,calls};
}

