import { suggestedRate } from '../../public/field-sales/pricing.js';
import { randomUUID } from 'node:crypto';
import { calculateQuote, fail, required, text, uuid, torontoWindow } from '../../public/field-sales/domain.js';

export async function getQuote(db, id, revision) {
  if(!revision){const alias=(await db.query('SELECT parent_quote_id FROM field_sales_quotes WHERE id=$1',[uuid(id)])).rows[0];if(alias?.parent_quote_id){return getQuote(db,alias.parent_quote_id);}}
  const q=await db.query(`SELECT q.*,r.snapshot,r.created_at AS revision_created_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',v.revision,'createdAt',v.created_at) ORDER BY v.revision DESC) FROM field_sales_quote_revisions v WHERE v.quote_id=q.id),'[]') AS versions,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('company',j.company,'state',j.state,'error',j.error,'revision',j.revision)) FROM field_sales_posting_jobs j WHERE j.quote_id=q.id AND j.revision=COALESCE($2::integer,q.revision)),'[]') AS posting,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('company',j.company,'state',j.state,'error',j.error,'revision',j.revision)) FROM field_sales_posting_jobs j WHERE j.quote_id=q.id AND j.state NOT IN ('done','superseded')),'[]') AS issues,
    (SELECT to_jsonb(o)-'payload'-'lease_token' FROM field_sales_order_jobs o WHERE o.quote_id=q.id ORDER BY company LIMIT 1) AS "order",
    COALESCE((SELECT jsonb_agg(to_jsonb(o)-'payload'-'lease_token' ORDER BY company) FROM field_sales_order_jobs o WHERE o.quote_id=q.id),'[]') AS orders,
    COALESCE((SELECT jsonb_agg(a.id) FROM field_sales_quotes a WHERE a.parent_quote_id=q.id),'[]') AS aliases,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'company',a.company,'revision',v.revision,'number','FS-'||a.company||'-'||lpad(a.quote_number::text,6,'0')) ORDER BY a.quote_number,v.revision DESC) FROM field_sales_quotes a JOIN field_sales_quote_revisions v ON v.quote_id=a.id WHERE a.parent_quote_id=q.id),'[]') AS related_versions,
    COALESCE((SELECT jsonb_agg(e) FROM field_sales_estimates e WHERE e.quote_id=q.id),'[]') AS estimates
    FROM field_sales_quotes q JOIN field_sales_quote_revisions r ON r.quote_id=q.id AND r.revision=COALESCE($2::integer,q.revision) WHERE q.id=$1`,[uuid(id),revision?Number(revision):null]);
  if(!q.rowCount) {throw fail('Quote not found.',404);}
  const row=q.rows[0],company=row.snapshot.schemaVersion===2?row.snapshot.company:row.company;
  return {...row,number:`FS-${company?`${company}-`:''}${String(row.quote_number).padStart(6,'0')}`,selected_revision:revision?Number(revision):row.revision};
}
export async function saveQuote(db, actor, p, settings, resolveSite) {
  const id=uuid(p.id), existing=(await db.query('SELECT * FROM field_sales_quotes WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(existing && Number(p.revision)!==existing.revision) {throw fail('This quote changed. Keep your draft and review the latest revision.',409,'FIELD_SALES_CONFLICT');}
  const site=await resolveSite(p.jobsiteId || existing?.jobsite_id);
  const calculated=calculateQuote(p,settings.companies);
  for(const [company,totals] of Object.entries(calculated.companies)){if(p.expectedTaxBps&&p.expectedTaxBps[company]!==totals.taxBps){throw fail('The tax policy changed while this draft was on your device. Review the quote with the current policy.',409,'FIELD_SALES_POLICY_CHANGED');}}
  for(const line of calculated.lines) {
    const item=(await db.query('SELECT * FROM field_sales_catalog WHERE company=$1 AND item_id=$2 AND active',[line.company,line.itemId])).rows[0];
    if(!item) {throw fail(`Select an active ${line.company} catalog item for ${line.description}.`);}
    const rate=suggestedRate(item,line.quantity);
    line.unit=item.unit;line.unitId=item.pricing?.unitId||null;
    line.catalogPrice={unitRate:rate,pricing:item.pricing,asOf:item.updated_at};
  }
  const revision=(existing?.revision||0)+1;
  const snapshot={...calculated,jobsite:{id:site.id,name:site.name,address:site.address},customerName:required(p.customerName,'Customer or prospect name',250),customerId:text(p.customerId,40),contact:text(p.contact,500),email:text(p.email,250),validUntil:text(p.validUntil,10),note:text(p.note,10000),companyProfiles:settings.companies,revision};
  if(snapshot.customerId && !/^\d+$/.test(snapshot.customerId)) {throw fail('Select a valid NetSuite customer.');}
  if(snapshot.validUntil){torontoWindow(snapshot.validUntil);}
  if(existing) {await db.query('UPDATE field_sales_quotes SET revision=$2,jobsite_id=$3,updated_at=now() WHERE id=$1',[id,revision,site.id]);}
  else {await db.query('INSERT INTO field_sales_quotes(id,jobsite_id,created_by) VALUES($1,$2,$3)',[id,site.id,actor.id]);}
  await db.query('INSERT INTO field_sales_quote_revisions(quote_id,revision,snapshot,created_by) VALUES($1,$2,$3,$4)',[id,revision,JSON.stringify(snapshot),actor.id]);
  return {quote:await getQuote(db,id)};
}
export async function enqueueQuote(db, p, settings, postingEnabled) {
  const id=uuid(p.id),q=(await db.query('SELECT * FROM field_sales_quotes WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!q) {throw fail('Quote not found.',404);}
  if(Number(p.revision)!==q.revision) {throw fail('Only the current quote revision can be published.',409);}
  const quote=await getQuote(db,id),s=quote.snapshot;
  if(quote.posting.some(j=>j.state==='superseded')){throw fail('Save a new quote revision after reconciling the previous publication.',409);}
  if(!s.customerId) {throw fail('Link an existing NetSuite customer before posting.');}
  if(!settings.postingEnabled || !postingEnabled) {throw fail('NetSuite quote posting is not enabled.',409);}
  if(!s.lines.length) {throw fail('Add at least one item before posting.');}
  const busy=await db.query(`SELECT 1 FROM field_sales_posting_jobs WHERE quote_id=$1 AND revision<>$2 AND state NOT IN ('done','superseded') LIMIT 1`,[id,q.revision]);
  if(busy.rowCount) {throw fail('Finish or resolve the previous publication before posting another revision.',409);}
  const represented=new Set(Object.keys(s.companies));
  for(const e of quote.estimates) {if(!e.closed) {represented.add(e.company);}}
  const payloads=[];
  for(const company of represented) {
    const cfg=settings.companies[company]||{}, totals=s.companies[company];
    if(totals&&totals.taxBps!==cfg.taxBps){throw fail(`The ${company} tax policy changed. Save a new quote revision before publishing.`,409);}
    for(const field of ['subsidiaryId','formId','taxCodeId','closedStatusId','currencyId']) {if(!/^\d+$/.test(String(cfg[field]||''))) {throw fail(`Configure ${company} ${field} before posting.`);}}
    const customer=await db.query('SELECT 1 FROM netsuite_customer_subsidiaries WHERE customer_netsuite_id=$1::bigint AND subsidiary_netsuite_id=$2::bigint AND active',[s.customerId,cfg.subsidiaryId]);
    if(!customer.rowCount) {throw fail(`The customer is not available to the ${company} subsidiary.`);}
    const externalId=`field-sales-${id}-${company.toLowerCase()}`;
    const link=quote.estimates.find(e=>e.company===company);
    if(totals&&link?.closed&&!/^\d+$/.test(String(cfg.openStatusId||''))){throw fail(`Configure ${company} open estimate status before restoring its items.`);}
    payloads.push({company,externalId,quoteId:id,revision:q.revision,number:quote.number,customerId:s.customerId,jobsite:s.jobsite,validUntil:s.validUntil,note:s.note,config:cfg,lines:s.lines.filter(l=>l.company===company),totals:totals||{subtotalMinor:0,taxMinor:0,totalMinor:0},close:!totals,expectedRemoteHash:link?.remote_hash||null});
  }
  // No outbox work is created until every company has passed local preflight.
  for(const payload of payloads) {
    await db.query('INSERT INTO field_sales_estimates(quote_id,company,external_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,payload.company,payload.externalId]);
    await db.query(`INSERT INTO field_sales_posting_jobs(id,quote_id,revision,company,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(quote_id,revision,company) DO NOTHING`,[randomUUID(),id,q.revision,payload.company,JSON.stringify(payload)]);
  }
  return {quote:await getQuote(db,id)};
}
