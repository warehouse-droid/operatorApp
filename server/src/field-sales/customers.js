import { fail,required,text,uuid } from '../../public/field-sales/domain.js';

const fields=`c.*,
 COALESCE((SELECT jsonb_agg(t ORDER BY t.name) FROM field_sales_customer_types t JOIN field_sales_customer_type_links l ON l.type_id=t.id WHERE l.customer_id=c.id),'[]') AS types,
 COALESCE((SELECT jsonb_agg(r ORDER BY r.name,r.id) FROM field_sales_customer_representatives r WHERE r.customer_id=c.id),'[]') AS representatives,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.id,'name',j.name,'address',j.address) ORDER BY j.address) FROM field_sales_jobsites j JOIN field_sales_customer_sites l ON l.jobsite_id=j.id WHERE l.customer_id=c.id),'[]') AS jobsites,
 COALESCE((SELECT jsonb_object_agg(a.account_group,COALESCE(a.netsuite_id,'')) FROM field_sales_customer_accounts a WHERE a.customer_id=c.id),'{}') AS "netsuiteCustomers"`;
const hydrate=c=>({...c,typeIds:c.types.map(t=>t.id)});
const checkRevision=(row,p)=>{if(row&&row.revision!==Number(p.revision)){throw fail('This customer record changed. Review the latest version before saving.',409,'FIELD_SALES_CONFLICT');}};
const bounded=(v,max,label)=>{if(!Array.isArray(v)||v.length>max){throw fail(`${label} must contain at most ${max} entries.`);}return v;};
function email(value){const e=text(value,250);if(e&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)){throw fail('Enter a valid email address.');}return e;}
export function customerGroup(company){return company==='MBBS'?'MBBS':'MBT_MBR';}
export const customerExternalId=(id,group)=>`field-sales-customer-${uuid(id)}-${group.toLowerCase()}`;

export function createCustomerDirectory(db) {
 const one=async(sql,p)=>(await db.query(sql,p)).rows[0];
 async function get(id) {
  const c=await one(`SELECT ${fields} FROM field_sales_customers c WHERE c.id=$1`,[uuid(id)]);
  if(!c){throw fail('Customer not found.',404);}return hydrate(c);
 }
 async function list(p={}) {
  const rows=await db.query(`SELECT ${fields} FROM field_sales_customers c WHERE ($1 OR NOT c.archived)
   AND (c.name ILIKE $2 OR c.email ILIKE $2 OR c.phone ILIKE $2 OR EXISTS(SELECT 1 FROM field_sales_customer_representatives r WHERE r.customer_id=c.id AND (r.name ILIKE $2 OR r.email ILIKE $2 OR r.phone ILIKE $2)))
   AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM field_sales_customer_sites l WHERE l.customer_id=c.id AND l.jobsite_id=$3))
   ORDER BY c.name,c.id LIMIT 200`,[p.archived==='all',`%${text(p.search,150)}%`,p.jobsiteId?uuid(p.jobsiteId):null]);
  return {items:rows.rows.map(hydrate)};
 }
 async function types(){return (await db.query('SELECT * FROM field_sales_customer_types ORDER BY name')).rows;}
 async function saveType(p) {
  const id=uuid(p.id),current=await one('SELECT * FROM field_sales_customer_types WHERE id=$1 FOR UPDATE',[id]);checkRevision(current,p);
  const name=required(p.name,'Customer type',100);
  if(await one('SELECT 1 FROM field_sales_customer_types WHERE lower(name)=lower($1) AND id<>$2',[name,id])){throw fail('This customer type already exists.',409);}
  try {await db.query(`INSERT INTO field_sales_customer_types(id,name,archived) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2,archived=$3,revision=field_sales_customer_types.revision+1`,[id,name,Boolean(p.archived)]);}
  catch(e){if(e.code==='23505'){throw fail('This customer type already exists.',409);}throw e;}
  return {customerType:await one('SELECT * FROM field_sales_customer_types WHERE id=$1',[id])};
 }
 async function representatives(id,rows) {
  const seen=new Set();
  for(const r of bounded(rows,50,'Representatives')) {
   const rid=uuid(r.id);if(seen.has(rid)){throw fail('Representative IDs must be unique.');}seen.add(rid);
   const old=await one('SELECT customer_id FROM field_sales_customer_representatives WHERE id=$1',[rid]);
   if(old&&old.customer_id!==id){throw fail('This representative belongs to another customer.');}
   await db.query(`INSERT INTO field_sales_customer_representatives(id,customer_id,name,role,phone,email,archived) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(id) DO UPDATE SET name=$3,role=$4,phone=$5,email=$6,archived=$7 WHERE field_sales_customer_representatives.customer_id=$2`,[rid,id,required(r.name,'Representative name',200),text(r.role,100),text(r.phone,80),email(r.email),Boolean(r.archived)]);
  }
  await db.query('UPDATE field_sales_customer_representatives SET archived=true WHERE customer_id=$1 AND NOT(id=ANY($2::uuid[]))',[id,[...seen]]);
 }
 async function mappings(id,p) {
  for(const group of ['MBBS','MBT_MBR']) {
   if(!Object.hasOwn(p,group)){continue;}const value=text(p[group],40)||null;
   if(value&&(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value)))){throw fail('Choose a valid NetSuite customer.');}
   if(value&&!await one('SELECT 1 FROM netsuite_customers WHERE netsuite_id=$1::bigint AND active AND currency=\'CAD\'',[value])){throw fail('Choose an active CAD NetSuite customer.');}
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`customer-account:${id}:${group}`]);
   const old=await one('SELECT * FROM field_sales_customer_accounts WHERE customer_id=$1 AND account_group=$2',[id,group]);
   if((old?.netsuite_id||null)===value){continue;}
   if(await one(`SELECT 1 FROM field_sales_order_jobs WHERE customer_id=$1 AND account_group=$2 AND state<>'done'`,[id,group])){throw fail('Finish the pending Sales Order before changing its customer link.',409);}
   await db.query(`INSERT INTO field_sales_customer_accounts(customer_id,account_group,external_id,netsuite_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(customer_id,account_group) DO UPDATE SET netsuite_id=$4,reference=null,updated_at=now()`,[id,group,customerExternalId(id,group),value]);
  }
 }
 async function save(actor,p) {
  const id=uuid(p.id),current=await one('SELECT * FROM field_sales_customers WHERE id=$1 FOR UPDATE',[id]);checkRevision(current,p);
  const bill=Object.fromEntries(['line1','line2','city','province','postalCode','country'].map(k=>[k,text(p.billing?.[k],k==='line1'||k==='line2'?250:100)]));bill.country||='CA';
  const typeIds=[...new Set(bounded(p.typeIds||[],20,'Customer types').map(uuid))];
  for(const tid of typeIds){if(!await one('SELECT 1 FROM field_sales_customer_types t WHERE t.id=$1 AND (NOT t.archived OR EXISTS(SELECT 1 FROM field_sales_customer_type_links l WHERE l.type_id=t.id AND l.customer_id=$2))',[tid,id])){throw fail('Select an active customer type.');}}
  await db.query(`INSERT INTO field_sales_customers(id,name,email,phone,billing,note,archived,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT(id) DO UPDATE SET name=$2,email=$3,phone=$4,billing=$5,note=$6,archived=$7,revision=field_sales_customers.revision+1,updated_at=now()`,[id,required(p.name,'Customer name',250),email(p.email),text(p.phone,80),JSON.stringify(bill),text(p.note,5000),Boolean(p.archived),actor.id]);
  await db.query('DELETE FROM field_sales_customer_type_links WHERE customer_id=$1',[id]);
  for(const tid of typeIds){await db.query('INSERT INTO field_sales_customer_type_links(customer_id,type_id) VALUES($1,$2)',[id,tid]);}
  await representatives(id,p.representatives||[]);await mappings(id,p.netsuiteCustomers||{});
  return {customer:await get(id)};
 }
 async function link(actor,p,site) {
  const c=await get(p.customerId);if(c.archived&&p.linked!==false){throw fail('This customer is archived.');}
  if(p.linked===false){await db.query('DELETE FROM field_sales_customer_sites WHERE customer_id=$1 AND jobsite_id=$2',[c.id,site.id]);}
  else {await db.query('INSERT INTO field_sales_customer_sites(customer_id,jobsite_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[c.id,site.id,actor.id]);}
  return {customer:await get(c.id)};
 }
 async function selected(customerId,siteId,representativeId) {
  const c=await get(customerId);if(c.archived){throw fail('This customer is archived.');}
  if(!c.jobsites.some(j=>j.id===siteId)){throw fail('Link this customer to the selected jobsite first.');}
  const representative=representativeId?c.representatives.find(r=>r.id===uuid(representativeId)&&!r.archived):null;
  if(representativeId&&!representative){throw fail('Select an active representative belonging to this customer.');}
  return {customer:c,representative};
 }
 async function forOrder(customerId,siteId,representativeId,groups,choices,revision) {
  const row=await one('SELECT * FROM field_sales_customers WHERE id=$1 FOR UPDATE',[uuid(customerId)]);
  if(!row){throw fail('Customer not found.',404);}
  if(choices!==undefined){
   if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).some(group=>!groups.includes(group))){throw fail('Choose existing NetSuite customers for the companies on this quote.');}
   checkRevision(row,{revision});
  }
  // Serialize confirmation with directory relinking and publisher validation.
  for(const group of [...groups].sort()){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`customer-account:${customerId}:${group}`]);}
  const {customer}=await selected(customerId,siteId,representativeId),links={};
  for(const group of groups){
   const id=text(choices===undefined?customer.netsuiteCustomers[group]:choices[group],40);
   if(!id){throw fail(`Link an existing ${group==='MBBS'?'MBBS':'MBT / MBR'} NetSuite customer before creating Sales Orders. Create the customer in NetSuite first.`,409);}
   links[group]=id;
  }
  await mappings(customerId,links);
  if(groups.some(group=>links[group]!==customer.netsuiteCustomers[group])){await db.query('UPDATE field_sales_customers SET revision=revision+1,updated_at=now() WHERE id=$1',[customerId]);}
  return selected(customerId,siteId,representativeId);
 }
 async function visitContacts(rows,siteId) {
  const snapshots=[],seen=new Set();
  for(const row of bounded(rows||[],30,'Visit contacts')) {
   if(seen.has(row.customerId)){throw fail('Select each contacted customer once.');}seen.add(row.customerId);
   const {customer:c}=await selected(row.customerId,siteId);
   const reps=[];for(const id of [...new Set(bounded(row.representativeIds||[],50,'Contacted representatives'))]){reps.push((await selected(c.id,siteId,id)).representative);}
   snapshots.push({customerId:c.id,name:c.name,representatives:reps});
  }
  return snapshots;
 }
 return {get,list,types,saveType,save,link,selected,forOrder,visitContacts};
}
