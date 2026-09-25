import { randomUUID } from 'node:crypto';
import { normalizePlanning,normalizePermit,normalizeAddress,fail,text } from '../../public/field-sales/domain.js';

export const CITY_PLANNING='https://services3.arcgis.com/b9WvedVPoizGfvfD/ArcGIS/rest/services/COTGEO_IBMS_AIC_POINT/FeatureServer/0';
export const CKAN='https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/';
const WHERE="APPLICATION_TYPE = 'Community planning' AND STATUS_GROUP = 'Open'";
const RESOURCES={permits:'6d0229af-bc54-46de-9c2b-26759b01dd05',addresses:'0b3756af-9caf-4f0f-ac28-9c6617adede4',postal:'8907d8ed-c515-4ce9-b674-9f8c6eefcf0d'};
export async function cityJson(target) {
  const response=await fetch(target,{signal:AbortSignal.timeout(60000),headers:{Accept:'application/json'}});
  if(!response.ok){throw new Error(`City data returned HTTP ${response.status}.`);}
  const data=await response.json();if(data.error||data.success===false){throw new Error('City data returned an API error.');}return data;
}
function url(base,p) {return `${base}?${new URLSearchParams(p)}`;}
export async function* readPlanningPages({fetchJson=cityJson}={}) {
  const before=await fetchJson(url(CITY_PLANNING,{f:'json'}));
  const {count}=await fetchJson(url(`${CITY_PLANNING}/query`,{f:'json',where:WHERE,returnCountOnly:'true'}));
  if(!Number.isInteger(count)||count<1||count>1000000){throw new Error('Unexpected planning count; preserving the previous import.');}
  const seen=new Set();
  for(let offset=0;offset<count;offset+=1000) {
    const page=await fetchJson(url(`${CITY_PLANNING}/query`,{f:'json',where:WHERE,outFields:'*',returnGeometry:'false',orderByFields:'OBJECTID',resultOffset:String(offset),resultRecordCount:'1000'}));
    const rows=(page.features||[]).map(f=>f.attributes);
    if(rows.length!==Math.min(1000,count-offset)){throw new Error('Planning page is incomplete.');}
    for(const r of rows){if(seen.has(r.OBJECTID)||r.OBJECTID==null){throw new Error('Duplicate planning page identity.');}seen.add(r.OBJECTID);}
    yield rows;
  }
  const after=await fetchJson(url(CITY_PLANNING,{f:'json'}));
  if(before.editingInfo?.lastEditDate!==after.editingInfo?.lastEditDate){throw new Error('City planning data changed during import; retry a complete snapshot.');}
}
export async function* readCkanPages(resourceId,{fetchJson=cityJson,pageSize=5000,fields}={}) {
  const metadata=await fetchJson(url(`${CKAN}resource_show`,{id:resourceId}));
  const seen=new Set();let total;
  for(let offset=0;total===undefined||offset<total;offset+=pageSize) {
    const response=await fetchJson(url(`${CKAN}datastore_search`,{resource_id:resourceId,limit:String(pageSize),offset:String(offset),sort:'_id asc',...(fields?{fields:fields.join(',')}:{})}));
    const page=response.result;
    if(!page||!Number.isInteger(page.total)||page.total<1||page.total>2000000){throw new Error('Unexpected City dataset size; preserving the previous import.');}
    total??=page.total;
    if(total!==page.total||page.records?.length!==Math.min(pageSize,total-offset)){throw new Error('City data page is incomplete or changed during import.');}
    for(const r of page.records){if(r._id==null||seen.has(r._id)){throw new Error('Duplicate City data page identity.');}seen.add(r._id);}
    yield page.records;
  }
  const after=await fetchJson(url(`${CKAN}resource_show`,{id:resourceId}));
  if(metadata.result?.metadata_modified!==after.result?.metadata_modified){throw new Error('City dataset changed during import; retry a complete snapshot.');}
}
function normalizeAddressPoint(r) {
  let geometry;try{geometry=typeof r.geometry==='string'?JSON.parse(r.geometry):r.geometry;}catch{geometry=null;}
  const [longitude,latitude]=geometry?.type==='Point'?geometry.coordinates:[];
  const municipality=text(r.MUNICIPALITY_NAME).replace(/^former\s+/i,'');
  const district={Etobicoke:'Etobicoke-York',York:'Etobicoke-York','North York':'North York',Scarborough:'Scarborough',Toronto:'Toronto and East York','East York':'Toronto and East York'}[municipality]||'';
  return {sourceKey:String(r.ADDRESS_POINT_ID),addressKey:normalizeAddress(r.ADDRESS_FULL),latitude,longitude,ward:text(r.WARD).padStart(2,'0'),wardName:text(r.WARD_NAME),district,land:r.ADDRESS_CLASS==='L'};
}
function normalizePostal(r) {
  const address=[r.STREET_NUM,r.STREET_NAME,r.STREET_TYPE,r.STREET_DIRECTION].map(v=>text(v)).filter(Boolean).join(' ');
  return {sourceKey:`${r.FOLDERRSN}:${normalizeAddress(address)}`,groupKey:`planning:${r.FOLDERRSN}`,addressKey:normalizeAddress(address),postalPrefix:text(r.POSTAL).slice(0,3).toUpperCase()};
}
export function createCityImporter(repo,{fetchJson=cityJson}={}) {
  const db=repo.db,transaction=db.transaction;
  async function stage(runId,rows) {
    const values=rows.filter(Boolean).map(data=>({key:data.sourceKey,data}));
    // Same source address can legitimately occur more than once in the City's export.
    const unique=[...new Map(values.map(v=>[v.key,v])).values()];
    await db.query(`INSERT INTO field_sales_import_stage(run_id,source_key,data) SELECT $1,x.key,x.data FROM jsonb_to_recordset($2::jsonb) AS x(key text,data jsonb) ON CONFLICT(run_id,source_key) DO UPDATE SET data=EXCLUDED.data`,[runId,JSON.stringify(unique)]);
  }
  async function apply(runId,source) {
    if(source==='addresses') {
      await db.query(`INSERT INTO field_sales_addresses(address_key,latitude,longitude,ward,ward_name,district,ambiguous)
        SELECT data->>'addressKey',avg((data->>'latitude')::float8),avg((data->>'longitude')::float8),min(data->>'ward'),min(data->>'wardName'),min(data->>'district'),
        max((data->>'latitude')::float8)-min((data->>'latitude')::float8)>0.005 OR max((data->>'longitude')::float8)-min((data->>'longitude')::float8)>0.005
        FROM field_sales_import_stage WHERE run_id=$1 AND data->>'addressKey'<>'' AND data->>'latitude' IS NOT NULL AND data->>'longitude' IS NOT NULL GROUP BY data->>'addressKey'
        ON CONFLICT(address_key) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,ward=EXCLUDED.ward,ward_name=EXCLUDED.ward_name,district=EXCLUDED.district,ambiguous=EXCLUDED.ambiguous,updated_at=now()`,[runId]);
    } else if(source==='postal') {
      await db.query(`UPDATE field_sales_jobsites j SET postal_prefix=s.data->>'postalPrefix' FROM field_sales_import_stage s WHERE s.run_id=$1 AND j.source_group=s.data->>'groupKey' AND j.address_key=s.data->>'addressKey' AND NOT j.overridden`,[runId]);
    } else {
      await db.query(`INSERT INTO field_sales_jobsites(id,source_group,name,address,address_key,latitude,longitude,district,ward,ward_name,postal_prefix)
        SELECT gen_random_uuid(),d->>'groupKey',d->>'name',d->>'address',d->>'addressKey',(d->>'latitude')::float8,(d->>'longitude')::float8,COALESCE(d->>'district',''),COALESCE(d->>'ward',''),COALESCE(d->>'wardName',''),COALESCE(d->>'postalPrefix','') FROM
        (SELECT DISTINCT ON(data->>'groupKey') data AS d FROM field_sales_import_stage WHERE run_id=$1 ORDER BY data->>'groupKey',source_key) grouped
        ON CONFLICT(source_group) DO UPDATE SET name=CASE WHEN field_sales_jobsites.overridden THEN field_sales_jobsites.name ELSE EXCLUDED.name END,
          address=CASE WHEN field_sales_jobsites.overridden THEN field_sales_jobsites.address ELSE EXCLUDED.address END,
          address_key=CASE WHEN field_sales_jobsites.overridden THEN field_sales_jobsites.address_key ELSE EXCLUDED.address_key END,
          latitude=CASE WHEN field_sales_jobsites.overridden THEN field_sales_jobsites.latitude WHEN field_sales_jobsites.source_group LIKE 'planning:%' THEN EXCLUDED.latitude ELSE COALESCE(EXCLUDED.latitude,field_sales_jobsites.latitude) END,
          longitude=CASE WHEN field_sales_jobsites.overridden THEN field_sales_jobsites.longitude WHEN field_sales_jobsites.source_group LIKE 'planning:%' THEN EXCLUDED.longitude ELSE COALESCE(EXCLUDED.longitude,field_sales_jobsites.longitude) END,
          district=CASE WHEN field_sales_jobsites.overridden OR EXCLUDED.district='' THEN field_sales_jobsites.district ELSE EXCLUDED.district END,
          ward=CASE WHEN field_sales_jobsites.overridden OR EXCLUDED.ward='' THEN field_sales_jobsites.ward ELSE EXCLUDED.ward END,
          ward_name=CASE WHEN field_sales_jobsites.overridden OR EXCLUDED.ward_name='' THEN field_sales_jobsites.ward_name ELSE EXCLUDED.ward_name END`,[runId]);
      await db.query('UPDATE field_sales_sources SET present=false WHERE source=$1',[source==='permits'?'permit':'planning']);
      await db.query(`INSERT INTO field_sales_sources(source,source_key,jobsite_id,address_key,data)
        SELECT s.data->>'source',s.source_key,COALESCE(j.merged_into,j.id),s.data->>'addressKey',s.data FROM field_sales_import_stage s JOIN field_sales_jobsites j ON j.source_group=s.data->>'groupKey' WHERE s.run_id=$1
        ON CONFLICT(source,source_key) DO UPDATE SET data=EXCLUDED.data,address_key=EXCLUDED.address_key,present=true,last_seen_at=now()`,[runId]);
    }
    if(source==='addresses'||source==='permits'){await db.query(`UPDATE field_sales_jobsites j SET latitude=a.latitude,longitude=a.longitude,ward=a.ward,ward_name=a.ward_name,district=a.district FROM field_sales_addresses a WHERE a.address_key=j.address_key AND NOT a.ambiguous AND NOT j.overridden AND (j.latitude IS NULL OR j.source_group LIKE 'address:%')`);}
  }
  async function run(source) {
    if(!['planning','permits','addresses','postal'].includes(source)){throw fail('Unknown City data source.');}
    const runId=randomUUID();
    const inserted=await db.query(`INSERT INTO field_sales_import_runs(id,source,started_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(source) WHERE state='running' DO NOTHING RETURNING id`,[runId,source]);
    if(!inserted.rowCount){return {source,state:'already_running'};}
    try {
      let count=0;
      const pages=source==='planning'?readPlanningPages({fetchJson}):readCkanPages(RESOURCES[source],{fetchJson});
      for await(const page of pages) {
        const normalizer={planning:normalizePlanning,permits:normalizePermit,addresses:normalizeAddressPoint,postal:normalizePostal}[source];
        await stage(runId,page.map(raw=>{const d=normalizer(raw);return d?{...d,addressKey:d.addressKey||normalizeAddress(d.address)}:null;}));
        count+=page.length;
        await db.query('UPDATE field_sales_import_runs SET record_count=$2 WHERE id=$1',[runId,count]);
      }
      await transaction(async()=>{
        const lease=(await db.query('SELECT state FROM field_sales_import_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
        if(lease?.state!=='running'){throw new Error('This import lease expired; preserving the newer snapshot.');}
        const staged=await db.query('SELECT 1 FROM field_sales_import_stage WHERE run_id=$1 LIMIT 1',[runId]);
        if(!staged.rowCount){throw new Error('No usable City records; preserving the previous complete import.');}
        await apply(runId,source);
        await db.query(`UPDATE field_sales_import_runs SET state='complete',completed_at=now(),record_count=$2 WHERE id=$1`,[runId,count]);
        await db.query('DELETE FROM field_sales_import_stage WHERE run_id=$1',[runId]);
      });
      return {id:runId,source,state:'complete',count};
    } catch(error) {
      await db.query(`UPDATE field_sales_import_runs SET state='failed',completed_at=now(),error=$2 WHERE id=$1`,[runId,text(error.message,2000)]);
      await db.query('DELETE FROM field_sales_import_stage WHERE run_id=$1',[runId]);
      throw error;
    }
  }
  async function tick() {
    const s=(await repo.settings()).data;if(!s.enabled||!s.importsEnabled){return;}
    // Source requests are bounded; a process crash must not leave an eternal import lease.
    await db.query(`UPDATE field_sales_import_runs SET state='failed',completed_at=now(),error='Import interrupted; last complete snapshot retained.' WHERE state='running' AND started_at<now()-interval '2 hours'`);
    for(const source of ['planning','postal','permits','addresses']) {
      const days=source==='addresses'?7:1;
      const recent=await db.query(`SELECT 1 FROM field_sales_import_runs WHERE source=$1 AND (state='running' OR started_at>now()-($2::int*interval '1 day')) LIMIT 1`,[source,days]);
      if(!recent.rowCount){await run(source);break;}
    }
  }
  return {run,tick,history:async()=> (await db.query('SELECT * FROM field_sales_import_runs ORDER BY started_at DESC LIMIT 30')).rows};
}
