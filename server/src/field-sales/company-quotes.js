import { randomUUID } from 'node:crypto';
import { calculateQuote,COMPANIES,fail,required,text,uuid,torontoDate } from '../../public/field-sales/domain.js';
import {quoteDates} from '../../public/field-sales/quote-drafts.js';
import { suggestedRate } from '../../public/field-sales/pricing.js';
import { getQuote } from './quotes.js';
import { customerGroup,customerExternalId } from './customers.js';

export function quoteProfile(c={}) {
 const profile={taxBps:c.taxBps,validityDays:Number.isInteger(c.validityDays)?c.validityDays:30};
 for(const key of ['name','address','phone','taxNumber','terms']){profile[key]=text(c[key],key==='terms'?10000:1000);}
 profile.visible=Object.fromEntries(['expires','expectedClose','salesRep','shippingMethod','signature','barcode'].map(k=>[k,c.visible?.[k]!==false]));
 return profile;
}
export const billingText=b=>[b?.line1,b?.line2,[b?.city,b?.province,b?.postalCode].filter(Boolean).join(' '),b?.country].filter(Boolean).join('\n');

export async function saveCompanyQuotes(){
 throw fail('Review this pending batch as one combined quote before saving.',409,'FIELD_SALES_QUOTE_UPGRADE');
}

export async function saveCompanyQuote(db,actor,p,settings,resolveSite,directory) {
 const unified=p.schemaVersion===3;
 const id=uuid(p.id),existing=(await db.query('SELECT * FROM field_sales_quotes WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(existing?.parent_quote_id){throw fail('This company document belongs to a combined quote. Open the parent quote to edit.',409,'FIELD_SALES_QUOTE_UPGRADE');}
 if(existing?.confirmation){throw fail('This quote is confirmed. Copy it to a new quote to make changes.',409);}
 if(existing&&Number(p.revision)!==existing.revision){throw fail('This quote changed. Review the latest revision.',409,'FIELD_SALES_CONFLICT');}
 if(!unified&&!COMPANIES.includes(p.company)){throw fail('Choose one company, jobsite and local customer. Older mixed-company drafts must be split and reviewed.',409,'FIELD_SALES_QUOTE_UPGRADE');}
 if(!unified&&existing&&(existing.company!==p.company)){throw fail('A saved quote belongs to one company. Copy its items into a new company quote.',409);}
 if(!p.fieldSalesCustomerId){throw fail('Choose a Field Sales customer.');}
 const site=await resolveSite(p.jobsiteId);if(site.archived){throw fail('Choose an active jobsite.');}
 const {customer,representative}=await directory.selected(p.fieldSalesCustomerId,site.id,p.customerRepresentativeId);
 if(!Array.isArray(p.lines)||p.lines.some(l=>!l||typeof l!=='object')||!unified&&p.lines.some(l=>l.company!==p.company)){throw fail('Every item must belong to the quote company.');}
 if(p.lines.some(l=>l.id&&!/^[A-Za-z0-9_-]{1,80}$/.test(String(l.id)))){throw fail('Quote line identifiers contain invalid characters.');}
 const calculated=calculateQuote(p,settings.companies);
 if(unified&&!calculated.lines.length){throw fail('Add at least one item to create a quote.');}
 for(const company of Object.keys(calculated.companies)){if(p.expectedTaxBps&&p.expectedTaxBps[company]!==settings.companies[company].taxBps){throw fail('The tax policy changed. Review the draft with current taxes.',409,'FIELD_SALES_POLICY_CHANGED');}}
 for(const line of calculated.lines){
  const item=(await db.query('SELECT * FROM field_sales_catalog WHERE company=$1 AND item_id=$2 AND active',[line.company,line.itemId])).rows[0];
  if(!item){throw fail(`Select an active ${line.company} catalog item.`);}
  line.unit=item.unit;line.unitId=item.pricing?.unitId||null;
  line.catalogPrice={unitRate:suggestedRate(item,line.quantity),pricing:item.pricing,asOf:item.updated_at};
 }
 const represented=unified?COMPANIES.filter(c=>calculated.companies[c]):[p.company],companyProfiles=Object.fromEntries(represented.map(c=>[c,quoteProfile(settings.companies[c])]));
 const revision=(existing?.revision||0)+1,{quoteDate,validUntil}=quoteDates(torontoDate(),companyProfiles[represented[0]]);
 const previous=existing?(await getQuote(db,id)).snapshot:null;
 const snapshot={...calculated,schemaVersion:unified?3:2,simpleDetails:true,company:unified?null:p.company,fieldSalesCustomerId:customer.id,customerRepresentativeId:representative?.id||null,
  customer,representative,customerName:customer.name,contact:representative?.name||'',email:representative?.email||customer.email,
  phone:representative?.phone||customer.phone,jobsite:{id:site.id,name:site.name,address:site.address},
  quoteDate,validUntil,expectedClose:'',salesRep:text(p.salesRep||actor.display_name||actor.username||actor.id,200),shippingMethod:text(p.shippingMethod,100),
  billToAddress:billingText(customer.billing),shipToAddress:site.address,
  note:text(p.note,10000),companyProfiles,revision};
 if(existing){await db.query('UPDATE field_sales_quotes SET revision=$2,jobsite_id=$3,customer_id=$4,representative_id=$5,company=$6,updated_at=now() WHERE id=$1',[id,revision,site.id,customer.id,representative?.id||null,unified?null:p.company]);}
 else {await db.query('INSERT INTO field_sales_quotes(id,jobsite_id,company,customer_id,representative_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,site.id,unified?null:p.company,customer.id,representative?.id||null,actor.id]);}
 if(unified){
  const row=(await db.query('SELECT quote_number FROM field_sales_quotes WHERE id=$1',[id])).rows[0];
  snapshot.documents=Object.fromEntries(represented.map((company,i)=>{
   const ref=previous?.documents?.[company]||(previous?.company===company?{id,number:`FS-${company}-${String(row.quote_number).padStart(6,'0')}`}:{id:!existing&&i===0?id:randomUUID(),number:`FS-${company}-${String(row.quote_number).padStart(6,'0')}`});
   return [company,{...ref,validUntil:quoteDates(quoteDate,companyProfiles[company]).validUntil}];
  }));
  snapshot.sourceQuotes=previous?.sourceQuotes||[];
 }
 await db.query('INSERT INTO field_sales_quote_revisions(quote_id,revision,snapshot,created_by) VALUES($1,$2,$3,$4)',[id,revision,JSON.stringify(snapshot),actor.id]);
 return {quote:await getQuote(db,id)};
}

function orderConfig(settings,company) {
 const config={...settings.companies[company]},group=customerGroup(company);
 delete config.customerFormId;delete config.customerStatusId;
 for(const key of ['subsidiaryId','salesOrderFormId','currencyId','locationId']){
  if(!/^[1-9]\d*$/.test(String(config[key]||''))){throw fail(`Configure ${company} ${key} in Field Sales Settings before creating Sales Orders.`,409);}
 }
 const subsidiaries=group==='MBBS'?[config.subsidiaryId]:['MBT','MBR'].map(c=>settings.companies[c]?.subsidiaryId);
 if(subsidiaries.some(id=>!/^[1-9]\d*$/.test(String(id||'')))){throw fail('Configure both MBT and MBR subsidiaries for their shared customer.',409);}
 return {...config,customerSubsidiaries:[...new Set(subsidiaries.map(String))]};
}

export async function confirmQuote(db,actor,p,settings,enabled,directory) {
 const id=uuid(p.id),row=(await db.query('SELECT * FROM field_sales_quotes WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!row){throw fail('Quote not found.',404);}
 if(row.parent_quote_id){throw fail('This company document belongs to a combined quote. Confirm the parent quote.',409);}
 if(Number(p.revision)!==row.revision){throw fail('Confirm the current saved quote revision.',409);}
 if(row.confirmation){return {quote:await getQuote(db,id)};}
 const quote=await getQuote(db,id),s=quote.snapshot;
 if(!row.company&&s.schemaVersion!==3){throw fail('Review this legacy quote before creating Sales Orders.',409);}
 if(!settings.salesOrderPostingEnabled||!enabled){throw fail('Sales Order posting is not enabled. Saved quotes and PDFs remain available.',409);}
 if(!s.lines.length){throw fail('Add at least one item before confirmation.');}
 const companies=COMPANIES.filter(c=>s.companies[c]),groups=[...new Set(companies.map(customerGroup))];
 const {customer}=await directory.forOrder(s.fieldSalesCustomerId,row.jobsite_id,s.customerRepresentativeId,groups,p.netsuiteCustomers,p.customerRevision);
 const confirmation={confirmedBy:required(p.confirmedBy,'Customer who confirmed',250),confirmedAt:required(p.confirmedAt,'Confirmation time',40),note:text(p.note,5000),actorId:String(actor.id),revision:row.revision,evidenceIds:[]};
 if(!Number.isFinite(Date.parse(confirmation.confirmedAt))){throw fail('Enter a valid confirmation time.');}
 if(!Array.isArray(p.evidenceIds||[])||(p.evidenceIds||[]).length>10){throw fail('Attach up to 10 confirmation files.');}
 for(const eid of [...new Set(p.evidenceIds||[])]){
  if(!(await db.query('SELECT 1 FROM field_sales_quote_evidence WHERE id=$1 AND quote_id=$2 AND revision=$3 AND actor_id=$4',[uuid(eid),id,row.revision,actor.id])).rowCount){throw fail('Attach confirmation evidence to this saved quote revision.');}
  confirmation.evidenceIds.push(eid);
 }
 const payloads=[];
 for(const company of companies){
  const config=orderConfig(settings,company),group=customerGroup(company);
  if(s.companies[company].taxBps!==config.taxBps){throw fail('Tax settings changed. Save and review a new quote revision.',409);}
  const lines=s.lines.filter(l=>l.company===company);
  for(const line of lines){if(!(await db.query('SELECT 1 FROM field_sales_catalog WHERE company=$1 AND item_id=$2 AND active',[company,line.itemId])).rowCount){throw fail('An item is inactive. Review the quote before confirmation.',409);}}
  const linkedId=customer.netsuiteCustomers[group];
  const externalId=`field-sales-order-${s.documents?.[company]?.id||id}`;
  payloads.push({quoteId:id,revision:row.revision,company,number:quote.number,externalId,
   customerId:s.fieldSalesCustomerId,customerExternalId:customerExternalId(s.fieldSalesCustomerId,group),linkedCustomerId:linkedId,
   customer:s.customer,representative:s.representative,accountGroup:group,config,jobsite:s.jobsite,billToAddress:s.billToAddress,shipToAddress:s.shipToAddress,useCustomerBilling:s.simpleDetails===true,
   shippingMethod:s.shippingMethod,salesRep:s.salesRep,note:s.note,lines,totals:s.companies[company],confirmation});
 }
 await db.query('UPDATE field_sales_quotes SET confirmation=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify(confirmation)]);
 for(const payload of payloads){await db.query(`INSERT INTO field_sales_order_jobs(id,quote_id,revision,customer_id,account_group,payload,external_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),id,row.revision,s.fieldSalesCustomerId,payload.accountGroup,JSON.stringify(payload),payload.externalId]);}
 return {quote:await getQuote(db,id)};
}

export async function copyQuote(db,actor,p,settings,resolveSite,directory) {
 const original=await getQuote(db,p.id),s=original.snapshot;
 if(!s.company&&s.schemaVersion!==3){throw fail('Select and review each company from this legacy quote before saving a copy.',409);}
 const result=await saveCompanyQuote(db,actor,{...s,id:uuid(p.newId),revision:0,jobsiteId:original.jobsite_id,quoteDate:torontoDate(),validUntil:undefined},settings,resolveSite,directory);
 await db.query('UPDATE field_sales_quotes SET copied_from=$2 WHERE id=$1',[result.quote.id,original.id]);return result;
}
