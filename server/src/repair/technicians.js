import * as d from '../../public/repair/domain.js';
export function attachTechnicians(c){
 const {api,query,transaction}=c;
 const allowed=actor=>d.requireAllowed(d.canWorkshop(actor)||d.canViewCosts(actor));
 api.technicians=async actor=>{allowed(actor);return (await query('SELECT id,name,source FROM repair_technicians WHERE active ORDER BY name,id')).rows;};
 api.cacheTechnicians=async rows=>{
  if(!Array.isArray(rows)||rows.length>500)throw d.fail('Invalid technician directory.');
  const entries=rows.map(row=>({id:d.reference(row.id),name:d.text(row.name,'Technician',200),active:row.active!==false,source:row.source==='netsuite'?'netsuite':'wor'}));
  if(new Set(entries.map(row=>row.id)).size!==entries.length)throw d.fail('Duplicate technician directory entries.');
  await transaction(async()=>{await query("SELECT pg_advisory_xact_lock(hashtext('repair_technician_directory'))");await query('UPDATE repair_technicians SET active=false');
   for(const row of entries)await query('INSERT INTO repair_technicians(id,name,active,source) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active,source=EXCLUDED.source,refreshed_at=now()',[row.id,row.name,row.active,row.source]);});
 };
 c.selectTechnicians=async ids=>{
  if(!Array.isArray(ids)||ids.length<1||ids.length>3||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw d.fail('Choose one to three different technicians.');
  ids.forEach(d.reference);const rows=(await query('SELECT id,name FROM repair_technicians WHERE id=ANY($1::text[]) AND active FOR SHARE',[ids])).rows;
  if(rows.length!==ids.length)throw d.fail('Choose a current technician from the NetSuite directory.');
  return ids.map(id=>rows.find(row=>row.id===id));
 };
 c.usageTechnician=async(job,id,previous)=>{
  if(id)return (await c.selectTechnicians([id]))[0];
  if(previous)return previous;
  const people=job.data.performers||[];if(people.length===1)return people[0];
  if(people.length>1)throw d.fail('Choose the technician who used these parts.');
  return null;
 };
}
