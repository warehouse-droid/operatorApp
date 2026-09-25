import {recencyCutoff,SERVICE_CATEGORY_PATTERN,SERVICE_WORK} from '../../public/field-sales/lead-policy.js';

// PostgreSQL 18 validates without throwing on malformed City dates. Compare ISO days, not import times.
/** @param {string} expression */
const validDate=expression=>`CASE WHEN btrim(${expression}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T)' AND pg_input_is_valid(left(btrim(${expression}),10),'date') THEN left(btrim(${expression}),10) END`;
export const sourceDateSql=`CASE WHEN s.source='permit' THEN COALESCE(${validDate("s.data#>>'{raw,ISSUED_DATE}'")},${validDate("s.data#>>'{raw,APPLICATION_DATE}'")},${validDate("s.data->>'date'")}) ELSE ${validDate("s.data->>'date'")} END`;
/** @param {Record<string,unknown>} filters @param {unknown[]} args @param {Date} [now] */
export function leadSourceFilter(filters,args,now=new Date()) {
  const bind=/** @param {unknown} value */ (value)=>{args.push(value);return `$${args.length}`;},source=String(filters.source||'all').trim().slice(0,200),since=recencyCutoff(filters.recencyMonths,now),clauses=['s.present'];
  if(source==='recommended'){clauses.push("COALESCE((s.data->>'rank')::integer,0)>=20");}
  else if(source!=='all'&&source!=='manual'){clauses.push(`s.source=${bind(source)}`);}
  const specific=['milestone','permitStatus','category'].some(key=>Boolean(filters[key]));
  for(const [key,field] of [['milestone','milestone'],['permitStatus','status'],['category','category']]){if(filters[key]){clauses.push(`s.data->>'${field}'=${bind(String(filters[key]).trim().slice(0,200))}`);}}
  const restrictWork=source!=='manual'&&filters.includeMinor!=='true'&&(source==='recommended'||source==='permit'||filters.recencyMonths!==undefined);
  if(restrictWork){clauses.push(`NOT (s.source='permit' AND (COALESCE(s.data->>'minor','false')='true'
    OR lower(COALESCE(s.data->>'category','')) ~ ${bind(SERVICE_CATEGORY_PATTERN)}
    OR lower(btrim(COALESCE(s.data#>>'{raw,WORK}','')))=ANY(${bind(SERVICE_WORK)}::text[])
    OR (lower(btrim(COALESCE(s.data->>'category','')))='drain and site service' AND lower(btrim(COALESCE(s.data#>>'{raw,WORK}','')))='inside and outside drains')))`);}
  if(since&&source!=='manual'){clauses.push(`${sourceDateSql}>=${bind(since)}`);}
  const where=clauses.join(' AND '),exists=`EXISTS(SELECT 1 FROM field_sales_sources s WHERE s.jobsite_id=j.id AND ${where})`;
  let gate='';
  if(source==='manual'){gate=specific?exists:'';}
  else if(source!=='all'||specific||since||restrictWork){
    const alternatives=[exists];
    if(source==='all'&&!specific){alternatives.push('j.manual');if(!since){alternatives.push('NOT EXISTS(SELECT 1 FROM field_sales_sources current_source WHERE current_source.jobsite_id=j.id AND current_source.present)');}}
    gate=`(${alternatives.join(' OR ')})`;
  }
  return {where,gate,joinGate:gate.replace(exists,'matched.jobsite_id IS NOT NULL')};
}
