import { createHash } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { fail, text, required, uuid, isAdmin, requireFieldSales, assertRouteOwner, normalizeAddress, torontoWindow, OUTCOMES, STAGES, COMPANIES } from '../../public/field-sales/domain.js';
import { getQuote } from './quotes.js';
import { createCustomerDirectory } from './customers.js';
import { saveCompanyQuote,saveCompanyQuotes,confirmQuote,copyQuote } from './company-quotes.js';
import { publicationState,reconcilePublication } from './reconciliation.js';
import { sourceEvidence } from '../../public/field-sales/lead-policy.js';
import { leadSourceFilter,sourceDateSql } from './lead-filters.js';

export function canonical(value) {
  if(Array.isArray(value)) {return value.map(canonical);}
  if(value && typeof value==='object') {return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));}
  return value;
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function changed(current,p) { if(current && Number(p.revision)!==current.revision) {throw fail('This record changed. Keep your edit and review the latest version.',409,'FIELD_SALES_CONFLICT');} }
function priority(value) { const n=Number(value||0);if(!Number.isInteger(n)||n<0||n>3){throw fail('Priority must be between 0 and 3.');}return n; }
function coordinates(p) {
  const latitude=p.latitude==null||p.latitude===''?null:Number(p.latitude),longitude=p.longitude==null||p.longitude===''?null:Number(p.longitude);
  if(latitude!==null&&(!Number.isFinite(latitude)||Math.abs(latitude)>90)||longitude!==null&&(!Number.isFinite(longitude)||Math.abs(longitude)>180)){throw fail('Invalid map coordinates.');}
  return {latitude,longitude};
}
export function createFieldSalesRepository(db = {query,transaction:withTransaction}, options={}) {
  const tx=db.transaction||withTransaction;
  const directory=createCustomerDirectory(db);
  const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
  async function settings() { return (await one('SELECT * FROM field_sales_settings WHERE singleton')) || {revision:0,data:{}}; }
  async function audit(actor,action,id,detail={}) { await db.query('INSERT INTO field_sales_audit(actor_id,action,target_id,detail) VALUES($1,$2,$3,$4)',[String(actor.id),action,String(id||''),JSON.stringify(detail)]); }
  async function resolveSite(id) {
    let row;
    for(let i=0;i<20;i++) {row=await one('SELECT * FROM field_sales_jobsites WHERE id=$1',[uuid(id)]);if(!row){throw fail('Jobsite not found.',404);}if(!row.merged_into){return row;}id=row.merged_into;}
    throw fail('Jobsite merge chain needs review.',409);
  }
  async function getRoute(id) { const r=await one('SELECT *,plan_date::text AS date FROM field_sales_routes WHERE id=$1',[uuid(id)]);if(!r){throw fail('Route not found.',404);}return r; }
  async function saveSettings(actor,p) {
    if(!isAdmin(requireFieldSales(actor))){throw fail('Admin access is required.',403);}
    return tx(async()=>{
      const current=await one('SELECT * FROM field_sales_settings WHERE singleton FOR UPDATE');changed(current,p);
      const data={salesOrderPostingEnabled:false,...current.data,...p.data,postingEnabled:false,companies:{...current.data.companies,...p.data?.companies}};
      for(const key of ['enabled','importsEnabled','postingEnabled','salesOrderPostingEnabled']){if(typeof data[key]!=='boolean'){throw fail(`Invalid ${key}.`);}}
      for(const company of COMPANIES) {
        const c=data.companies?.[company];
        if(!c||!Number.isInteger(c.taxBps)||c.taxBps<0||c.taxBps>10000){throw fail(`Invalid ${company} tax policy.`);}
        delete c.customerFormId;delete c.customerStatusId;
        for(const key of ['name','address','phone','taxNumber','terms','subsidiaryId','formId','salesOrderFormId','termsId','pickupMethodId','deliveryMethodId','taxCodeId','closedStatusId','openStatusId','currencyId','locationId']){if(c[key]!==undefined){c[key]=text(c[key],key==='terms'?10000:1000);}}
      }
      for(const c of Object.values(data.companies)){if(c.validityDays!==undefined&&(!Number.isInteger(c.validityDays)||c.validityDays<0||c.validityDays>3650)){throw fail('Quote validity must be 0–3650 days.');}if(c.visible){c.visible=Object.fromEntries(['expires','expectedClose','salesRep','shippingMethod','signature','barcode'].map(k=>[k,c.visible[k]!==false]));}}
      if(data.outcomes && (!Array.isArray(data.outcomes)||!data.outcomes.length||data.outcomes.length>40||data.outcomes.some(v=>typeof v!=='string'||!v.trim()||v.length>100)||new Set(data.outcomes.map(v=>v.trim())).size!==data.outcomes.length)){throw fail('Provide between 1 and 40 distinct, nonempty visit outcomes (up to 100 characters each).');}
      if(data.outcomes){data.outcomes=data.outcomes.map(v=>v.trim());}
      await db.query('UPDATE field_sales_settings SET data=$1,revision=revision+1,updated_at=now(),updated_by=$2 WHERE singleton',[JSON.stringify(data),actor.id]);
      await audit(actor,'settings.update','settings');return settings();
    });
  }
  async function saveSite(actor,p) {
    const id=uuid(p.id),current=await one('SELECT * FROM field_sales_jobsites WHERE id=$1 FOR UPDATE',[id]);changed(current,p);
    if(current?.merged_into){throw fail('This jobsite was merged; open its current record.',409);}
    const v={...current,...p},address=required(v.address,'Address',500),name=required(v.name||address,'Name',250);
    const moved=current&&normalizeAddress(current.address)!==normalizeAddress(address);
    const c=coordinates(moved&&!Object.hasOwn(p,'latitude')&&!Object.hasOwn(p,'longitude')?{}:v);
    const stage=v.observedStage||v.observed_stage||'Unknown';if(!STAGES.includes(stage)){throw fail('Invalid construction observation.');}
    const contacts=Array.isArray(v.contacts)?v.contacts.slice(0,30).map(x=>({name:text(x.name,200),company:text(x.company,200),phone:text(x.phone,80),email:text(x.email,200),role:text(x.role,100)})):[];
    const ward=text(v.ward,5);if(ward&&(!/^\d{1,2}$/.test(ward)||Number(ward)<1||Number(ward)>25)){throw fail('Choose a Toronto ward between 1 and 25.');}
    const args=[id,name,address,normalizeAddress(address),c.latitude,c.longitude,text(v.district,100),ward?ward.padStart(2,'0'):'',text(v.wardName||v.ward_name,100),text(v.postalPrefix||v.postal_prefix,3).toUpperCase(),priority(v.priority),stage,JSON.stringify(contacts),actor.id,Boolean(v.archived)];
    await db.query(`INSERT INTO field_sales_jobsites(id,name,address,address_key,latitude,longitude,district,ward,ward_name,postal_prefix,priority,observed_stage,contacts,created_by,archived,manual,overridden)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,true)
      ON CONFLICT(id) DO UPDATE SET name=$2,address=$3,address_key=$4,latitude=$5,longitude=$6,district=$7,ward=$8,ward_name=$9,postal_prefix=$10,priority=$11,observed_stage=$12,contacts=$13,archived=$15,overridden=true,revision=field_sales_jobsites.revision+1,updated_at=now()`,args);
    return {jobsite:await resolveSite(id)};
  }
  async function saveRoute(actor,p) {
    const id=uuid(p.id),current=await one('SELECT * FROM field_sales_routes WHERE id=$1 FOR UPDATE',[id]);
    if(current){assertRouteOwner(actor,current);}changed(current,p);
    const ownerId=text(p.ownerId||current?.owner_id||actor.id);
    if(ownerId!==String(actor.id)&&!isAdmin(actor)){throw fail('Only an admin can assign another rep.',403);}
    const owner=await one(`SELECT id FROM operators WHERE id=$1 AND active AND (role IN ('field_sales','admin') OR roles && ARRAY['field_sales','admin']::text[])`,[ownerId]);
    if(!owner){throw fail('Choose an active Field Sales rep.');}
    const date=required(p.date,'Plan date',10),window=torontoWindow(date,p.period||'afternoon',p.startTime,p.endTime);
    if(!Array.isArray(p.stops)||p.stops.length>250){throw fail('A route supports up to 250 stops.');}
    const completed=(current?.data.stops||[]).filter(s=>s.status==='completed'),seen=new Set(),stops=[];
    for(const raw of p.stops) {
      const stopId=uuid(raw.id);if(seen.has(stopId)){throw fail('Each route stop must have a unique ID.');}seen.add(stopId);
      const old=completed.find(s=>s.id===stopId);if(old){stops.push(old);continue;}
      const site=await resolveSite(raw.jobsiteId),c=coordinates(Object.hasOwn(raw,'latitude')||raw.address&&raw.address!==site.address?raw:site),stay=Number(raw.stayMinutes??15);
      if(!Number.isFinite(stay)||stay<0||stay>1440){throw fail('Visit duration must be between 0 and 1440 minutes.');}
      const stop={id:stopId,jobsiteId:site.id,address:required(raw.address||site.address,'Stop address',500),name:site.name,...c,stayMinutes:stay,status:['planned','arrived','skipped'].includes(raw.status)?raw.status:'planned',note:text(raw.note,2000)};
      if(raw.followupId){stop.followupId=uuid(raw.followupId);}stops.push(stop);
    }
    stops.unshift(...completed.filter(old=>!seen.has(old.id)));
    const status=p.status||current?.status||'planned';if(!['planned','active','paused','completed'].includes(status)){throw fail('Invalid route status.');}
    if(status==='active') {
      await db.query('SELECT id FROM operators WHERE id=$1 FOR UPDATE',[ownerId]);
      const active=await one(`SELECT id FROM field_sales_routes WHERE owner_id=$1 AND status='active' AND id<>$2`,[ownerId,id]);
      if(active){throw fail('Pause your active route before starting another.',409);}
    }
    const place=v=>v?{address:text(v.address,500),...coordinates(v)}:null;
    const data={period:p.period||'afternoon',...window,windowEnd:window.end,areas:(Array.isArray(p.areas)?p.areas:[]).slice(0,40).map(v=>text(v,200)),origin:place(p.origin),end:place(p.end),allowTolls:Boolean(p.allowTolls),stops};
    await db.query(`INSERT INTO field_sales_routes(id,owner_id,plan_date,name,status,data) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET owner_id=$2,plan_date=$3,name=$4,status=$5,data=$6,revision=field_sales_routes.revision+1,updated_at=now()`,[id,ownerId,date,required(p.name||`${date} ${data.period}`,'Route name',200),status,JSON.stringify(data)]);
    return {route:await getRoute(id)};
  }
  async function recordVisit(actor,p,s) {
    const id=uuid(p.id),site=await resolveSite(p.jobsiteId),outcome=required(p.outcome,'Visit outcome',100);
    if(!(s.outcomes||OUTCOMES).includes(outcome)){throw fail('Choose a configured visit outcome.');}
    if(!Number.isFinite(Date.parse(p.occurredAt))){throw fail('A valid visit time is required.');}
    const stage=p.observedStage||'Unknown';if(!STAGES.includes(stage)){throw fail('Invalid construction observation.');}
    let route=null,stop=null;
    if(p.routeId) {
      route=await one('SELECT * FROM field_sales_routes WHERE id=$1 FOR UPDATE',[uuid(p.routeId)]);
      if(!route){throw fail('Route not found.',404);}assertRouteOwner(actor,route);
      stop=route.data.stops.find(candidate=>candidate.id===p.stopId);if(!stop||(await resolveSite(stop.jobsiteId)).id!==site.id){throw fail('The selected stop does not belong to this jobsite.');}
      if(stop.status==='completed'){throw fail('This stop is already completed. Add another stop for a new visit.',409);}
      stop.status='completed';stop.visitId=id;stop.completedAt=p.occurredAt;
      await db.query('UPDATE field_sales_routes SET data=$2,revision=revision+1,updated_at=now() WHERE id=$1',[route.id,JSON.stringify(route.data)]);
    }
    await db.query(`INSERT INTO field_sales_visits(id,jobsite_id,route_id,stop_id,actor_id,outcome,note,observed_stage,occurred_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,site.id,route?.id||null,stop?.id||null,actor.id,outcome,text(p.note,10000),stage,p.occurredAt,JSON.stringify({address:stop?.address||site.address,location:p.location?coordinates(p.location):null,contacts:await directory.visitContacts(p.contacts,site.id)})]);
    if(stage!=='Unknown'){await db.query('UPDATE field_sales_jobsites SET observed_stage=$2,revision=revision+1,updated_at=now() WHERE id=$1',[site.id,stage]);}
    if(stop?.followupId){await db.query('UPDATE field_sales_followups SET completed_at=now() WHERE id=$1 AND owner_id=$2',[stop.followupId,actor.id]);}
    if(p.revisitDate) {
      torontoWindow(p.revisitDate);
      await db.query(`INSERT INTO field_sales_followups(id,jobsite_id,visit_id,owner_id,due_date,priority,note) VALUES($1,$2,$3,$4,$5,$6,$7)`,[p.followupId?uuid(p.followupId):id,site.id,id,actor.id,p.revisitDate,priority(p.revisitPriority),text(p.revisitNote||p.note,2000)]);
    }
    return {visitId:id,route:route?await getRoute(route.id):null};
  }
  async function mergeSites(p) {
    const from=await resolveSite(p.fromId),to=await resolveSite(p.toId);if(from.id===to.id){throw fail('Choose two different jobsites.');}
    await db.query('SELECT id FROM field_sales_jobsites WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[from.id,to.id]]);
    if((await resolveSite(from.id)).id!==from.id || (await resolveSite(to.id)).id!==to.id){throw fail('A jobsite was merged concurrently. Reload and review.',409);}
    await db.query('INSERT INTO field_sales_customer_sites(customer_id,jobsite_id,created_by) SELECT customer_id,$2,created_by FROM field_sales_customer_sites WHERE jobsite_id=$1 ON CONFLICT DO NOTHING',[from.id,to.id]);
    await db.query('DELETE FROM field_sales_customer_sites WHERE jobsite_id=$1',[from.id]);
    for(const table of ['field_sales_sources','field_sales_notes','field_sales_visits','field_sales_followups','field_sales_quotes']){await db.query(`UPDATE ${table} SET jobsite_id=$2 WHERE jobsite_id=$1`,[from.id,to.id]);}
    await db.query('UPDATE field_sales_jobsites SET merged_into=$2,revision=revision+1,updated_at=now() WHERE id=$1',[from.id,to.id]);
    return {jobsite:await resolveSite(to.id)};
  }
  async function command(actor,c) {
    requireFieldSales(actor);uuid(c.id);const kind=required(c.kind,'Command',60),p=c.payload||{};
    return tx(async()=>{
      const hash=digest({kind,payload:p});
      await db.query('INSERT INTO field_sales_commands(id,actor_id,kind,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[c.id,actor.id,kind,hash]);
      const receipt=await one('SELECT * FROM field_sales_commands WHERE id=$1 FOR UPDATE',[c.id]);
      if(receipt.actor_id!==String(actor.id)||receipt.payload_hash!==hash){throw fail('This command ID was already used for different work.',409);}
      if(receipt.response){return receipt.response;}
      const s=(await settings()).data;if(!s.enabled){throw fail('Field Sales is disabled.',409);}
      // Row locks cannot protect a not-yet-created UUID. Serialize creates and
      // edits before reading ownership/revision so an upsert cannot bypass them.
      if(['jobsite.save','route.save','quote.save','customer.save','customerType.save'].includes(kind)){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${kind}:${uuid(p.id)}`]);}
      let result;
      switch(kind) {
        case 'jobsite.save':result=await saveSite(actor,p);break;
        case 'jobsite.merge':result=await mergeSites(p);break;
        case 'note.add': {const site=await resolveSite(p.jobsiteId);await db.query('INSERT INTO field_sales_notes(id,jobsite_id,actor_id,body) VALUES($1,$2,$3,$4)',[uuid(p.id),site.id,actor.id,required(p.body,'Note',10000)]);result={noteId:p.id};break;}
        case 'route.save':result=await saveRoute(actor,p);break;
        case 'visit.record':result=await recordVisit(actor,p,s);break;
        case 'followup.complete': {const f=await one('SELECT * FROM field_sales_followups WHERE id=$1 FOR UPDATE',[uuid(p.id)]);if(!f){throw fail('Follow-up not found.',404);}assertRouteOwner(actor,f);await db.query('UPDATE field_sales_followups SET completed_at=now() WHERE id=$1',[p.id]);result={followupId:p.id};break;}
        case 'customer.save':result=await directory.save(actor,p);break;
        case 'customerType.save':result=await directory.saveType(p);break;
        case 'customer.link': {const site=await resolveSite(p.jobsiteId);result={...await directory.link(actor,p,site),jobsite:await getJobsite(site.id)};break;}
        case 'quote.save':result=await saveCompanyQuote(db,actor,p,s,resolveSite,directory);break;
        case 'quote.saveGroup':result=await saveCompanyQuotes(db,actor,p,s,resolveSite,directory);break;
        case 'quote.confirm':result=await confirmQuote(db,actor,p,s,options.postingEnabled===true,directory);break;
        case 'quote.copy':result=await copyQuote(db,actor,p,s,resolveSite,directory);break;
        case 'quote.order.retry': {if(!s.salesOrderPostingEnabled||!options.postingEnabled){throw fail('Sales Order posting is disabled.',409);}const q=await getQuote(db,p.id);if(!q.confirmation||q.revision!==Number(p.revision)){throw fail('Open the current accepted quote revision.',409);}const orderId=p.orderId?uuid(p.orderId):null;if(orderId&&!q.orders.some(o=>o.id===orderId)){throw fail('Sales Order not found on this quote.',404);}await db.query("UPDATE field_sales_order_jobs SET state='uncertain',next_attempt_at=now(),error=null WHERE quote_id=$1 AND state='attention' AND ($2::uuid IS NULL OR id=$2)",[q.id,orderId]);result={quote:await getQuote(db,q.id)};break;}
        case 'quote.publish':throw fail('Quotes are local. Confirm a company quote to create a Sales Order.',409);
        case 'quote.reconcile':result=await reconcilePublication(db,actor,p,options.transport);break;
        case 'quote.retry':throw fail('Estimate publication is retired. Use the confirmed Sales Order workflow.',409);
        default:throw fail('Unknown Field Sales command.');
      }
      await audit(actor,kind,p.id||p.toId,{commandId:c.id});
      await db.query('UPDATE field_sales_commands SET response=$2 WHERE id=$1',[c.id,JSON.stringify(result)]);return result;
    });
  }
  async function getJobsite(id) {
    const site=await resolveSite(id);
    const [sources,notes,visits,quotes,duplicates,addressEvidence]=await Promise.all([
      db.query('SELECT source,source_key,data,present,last_seen_at FROM field_sales_sources WHERE jobsite_id=$1 ORDER BY source,source_key',[site.id]),
      db.query('SELECT * FROM field_sales_notes WHERE jobsite_id=$1 ORDER BY created_at DESC',[site.id]),
      db.query(`SELECT v.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'url','/api/field-sales/photos/'||p.id)) FROM field_sales_photos p WHERE p.visit_id=v.id),'[]') AS photos FROM field_sales_visits v WHERE jobsite_id=$1 ORDER BY occurred_at DESC`,[site.id]),
      db.query(`SELECT q.*,(SELECT to_jsonb(j)-'payload'-'lease_token' FROM field_sales_order_jobs j WHERE j.quote_id=q.id ORDER BY company LIMIT 1) AS "order",COALESCE((SELECT jsonb_agg(to_jsonb(j)-'payload'-'lease_token' ORDER BY company) FROM field_sales_order_jobs j WHERE j.quote_id=q.id),'[]') AS orders,COALESCE((SELECT jsonb_agg(a.id) FROM field_sales_quotes a WHERE a.parent_quote_id=q.id),'[]') AS aliases,r.snapshot->>'schemaVersion' AS schema_version,r.snapshot->>'customerName' AS customer_name,r.snapshot->>'totalMinor' AS total_minor FROM field_sales_quotes q JOIN field_sales_quote_revisions r ON r.quote_id=q.id AND r.revision=q.revision WHERE jobsite_id=$1 AND q.parent_quote_id IS NULL ORDER BY updated_at DESC`,[site.id]),
      db.query('SELECT id,name,address FROM field_sales_jobsites WHERE address_key=$1 AND id<>$2 AND merged_into IS NULL LIMIT 20',[site.address_key,site.id]),
      db.query(`SELECT source,source_key,data,present,last_seen_at FROM field_sales_sources WHERE source='permit' AND present AND jobsite_id<>$1 AND address_key IN (SELECT address_key FROM field_sales_sources WHERE jobsite_id=$1 UNION SELECT $2::text) ORDER BY data->>'date' DESC LIMIT 100`,[site.id,site.address_key])
    ]);
    return {...site,customers:(await directory.list({jobsiteId:site.id,archived:'all'})).items,sources:sources.rows,notes:notes.rows,visits:visits.rows,quotes:quotes.rows,duplicates:duplicates.rows,addressEvidence:addressEvidence.rows};
  }
  function siteFilters(f={}) {
    const args=[],where=['j.merged_into IS NULL'];const add=(sql,v)=>{args.push(v);where.push(sql.replaceAll('?',`$${args.length}`));};
    if(f.archived!=='all'){add('j.archived=?',f.archived==='true');}
    if(f.search){add(`(j.address ILIKE ? OR j.name ILIKE ? OR EXISTS(SELECT 1 FROM field_sales_sources ss WHERE ss.jobsite_id=j.id AND (ss.data->>'address' ILIKE ? OR ss.data->>'description' ILIKE ?)))`,`%${text(f.search,150)}%`);}
    for(const [k,column] of [['district','district'],['ward','ward'],['postal','postal_prefix']]){if(f[k]){add(`j.${column}=ANY(?::text[])`,text(f[k],500).split(',').map(v=>k==='postal'?v.trim().toUpperCase():k==='ward'?v.trim().padStart(2,'0'):v.trim()));}}
    if(f.priority!==undefined&&f.priority!==''){add('j.priority>=?',priority(f.priority));}
    if(f.stage){add('j.observed_stage=?',text(f.stage));}
    if(f.source==='manual'){where.push('j.manual');}
    const source=leadSourceFilter(f,args,options.now?.()||new Date());if(source.gate){where.push(source.gate);}
    if(f.outcome){add('EXISTS(SELECT 1 FROM field_sales_visits v WHERE v.jobsite_id=j.id AND v.outcome=?)',text(f.outcome,100));}
    if(f.revisitBefore){torontoWindow(f.revisitBefore);add('EXISTS(SELECT 1 FROM field_sales_followups u WHERE u.jobsite_id=j.id AND u.completed_at IS NULL AND u.due_date<=?::date)',f.revisitBefore);}
    if(f.bounds) {
      const b=String(f.bounds).split(',').map(Number);if(b.length!==4||b.some(n=>!Number.isFinite(n))||b[0]>b[2]||b[1]>b[3]){throw fail('Invalid map bounds.');}
      for(const [i,sql] of ['j.longitude>=?','j.latitude>=?','j.longitude<=?','j.latitude<=?'].entries()){add(sql,b[i]);}
    }
    return {where:where.join(' AND '),baseWhere:where.filter(part=>part!==source.gate).join(' AND '),args,sourceWhere:source.where,joinGate:source.joinGate};
  }
  async function listJobsites(f={}) {
    const {baseWhere,args,sourceWhere,joinGate}=siteFilters(f),limit=Math.min(200,Math.max(1,Number(f.limit)||50)),offset=Math.max(0,Number(f.offset)||0);
    const count=await one(`${matchingSitesSql(baseWhere,sourceWhere)} SELECT count(*)::int AS total FROM candidates j LEFT JOIN matched ON matched.jobsite_id=j.id WHERE ${joinGate||'true'}`,args);
    // Match once per source, sort compact evidence, and fetch full source data only for this page.
    const rows=await db.query(`WITH candidates AS MATERIALIZED (SELECT j.* FROM field_sales_jobsites j WHERE ${baseWhere}),
      matched AS MATERIALIZED (
        SELECT DISTINCT ON (s.jobsite_id) s.jobsite_id,s.source,s.source_key,${sourceDateSql} AS evidence_date,COALESCE((s.data->>'rank')::integer,0) AS rank
        FROM field_sales_sources s JOIN candidates j ON j.id=s.jobsite_id WHERE ${sourceWhere}
        ORDER BY s.jobsite_id,evidence_date DESC NULLS LAST,rank DESC,s.source_key
      ), page AS (
        SELECT j.*,COALESCE(matched.rank,0) AS rank,matched.source AS lead_source,matched.source_key AS lead_key,matched.evidence_date AS lead_date
        FROM candidates j LEFT JOIN matched ON matched.jobsite_id=j.id WHERE ${joinGate||'true'}
        ORDER BY j.priority DESC,matched.evidence_date DESC NULLS LAST,rank DESC,j.id LIMIT $${args.length+1} OFFSET $${args.length+2}
      ) SELECT page.*,evidence.data AS lead_data,evidence.data->>'milestone' AS milestone FROM page
        LEFT JOIN field_sales_sources evidence ON evidence.source=page.lead_source AND evidence.source_key=page.lead_key
        ORDER BY page.priority DESC,page.lead_date DESC NULLS LAST,page.rank DESC,page.id`,[...args,limit,offset]);
    const items=rows.rows.map(({lead_source,lead_key,lead_data,lead_date:_leadDate,...site})=>({...site,lead:lead_data?sourceEvidence(lead_source,lead_data,lead_key):null}));
    return {total:count.total,items,offset,limit};
  }
  function matchingSitesSql(baseWhere,sourceWhere) {
    return `WITH candidates AS MATERIALIZED (SELECT j.* FROM field_sales_jobsites j WHERE ${baseWhere}),
      matched AS MATERIALIZED (SELECT DISTINCT s.jobsite_id FROM field_sales_sources s JOIN candidates j ON j.id=s.jobsite_id WHERE ${sourceWhere})`;
  }
  async function mapJobsites(f={}) {
    const {baseWhere,args,sourceWhere,joinGate}=siteFilters(f),zoom=Math.min(20,Math.max(4,Number(f.zoom)||11));
    const size=zoom>=17?0.0001:zoom>=15?0.002:zoom>=13?0.008:0.035;
    const result=await db.query(`${matchingSitesSql(`${baseWhere} AND j.latitude IS NOT NULL AND j.longitude IS NOT NULL`,sourceWhere)}
      SELECT count(*)::int AS count,avg(j.latitude) AS latitude,avg(j.longitude) AS longitude,(array_agg(j.id))[1] AS id,max(j.name) AS name,max(j.priority) AS priority
      FROM candidates j LEFT JOIN matched ON matched.jobsite_id=j.id WHERE ${joinGate||'true'} GROUP BY floor(j.latitude/${size}),floor(j.longitude/${size}) LIMIT 1500`,args);
    return result.rows;
  }
  async function listFollowups(actor) {
    return (await db.query(`SELECT f.*,f.due_date::text AS date,j.name,j.address,j.latitude,j.longitude FROM field_sales_followups f JOIN field_sales_jobsites j ON j.id=f.jobsite_id WHERE f.completed_at IS NULL AND ($1::boolean OR f.owner_id=$2) ORDER BY f.due_date,f.priority DESC`,[isAdmin(actor),actor.id])).rows;
  }
  async function facets() {
    const rows=(await db.query(`SELECT DISTINCT data->>'milestone' AS milestone,data->>'category' AS category,data->>'status' AS status,source FROM field_sales_sources WHERE present`)).rows;
    const values=(key,source)=>[...new Set(rows.filter(row=>!source||row.source===source).map(row=>row[key]).filter(Boolean))].sort();
    return {milestones:values('milestone','planning'),categories:values('category'),permitStatuses:values('status','permit')};
  }
  return {db,settings,saveSettings,command,getCustomer:directory.get,listCustomers:directory.list,listCustomerTypes:directory.types,getJobsite,resolveSite,getRoute,listJobsites,mapJobsites,listFollowups,facets,getQuote:(id,r)=>getQuote(db,id,r),publicationState:id=>publicationState(db,id,options.transport),audit,
    listRoutes:async(actor,date)=>{if(date){torontoWindow(date);}return (await db.query(`SELECT r.*,r.plan_date::text AS date,o.display_name AS owner_name FROM field_sales_routes r JOIN operators o ON o.id=r.owner_id WHERE ($1::date IS NULL OR r.plan_date=$1::date) ORDER BY r.plan_date DESC,r.created_at DESC LIMIT 200`,[date||null])).rows;},
    listReps:async()=> (await db.query(`SELECT id,display_name FROM operators WHERE active AND (role IN ('field_sales','admin') OR roles && ARRAY['field_sales','admin']::text[]) ORDER BY display_name`)).rows,
    listQuotes:async()=> (await db.query(`SELECT q.*,(SELECT to_jsonb(j)-'payload'-'lease_token' FROM field_sales_order_jobs j WHERE j.quote_id=q.id ORDER BY company LIMIT 1) AS "order",COALESCE((SELECT jsonb_agg(to_jsonb(j)-'payload'-'lease_token' ORDER BY company) FROM field_sales_order_jobs j WHERE j.quote_id=q.id),'[]') AS orders,COALESCE((SELECT jsonb_agg(a.id) FROM field_sales_quotes a WHERE a.parent_quote_id=q.id),'[]') AS aliases,r.snapshot->>'schemaVersion' AS schema_version,r.snapshot->>'customerName' AS customer_name,r.snapshot->'jobsite' AS jobsite,r.snapshot->>'totalMinor' AS total_minor FROM field_sales_quotes q JOIN field_sales_quote_revisions r ON r.quote_id=q.id AND r.revision=q.revision WHERE q.parent_quote_id IS NULL ORDER BY q.updated_at DESC LIMIT 200`)).rows
  };
}
