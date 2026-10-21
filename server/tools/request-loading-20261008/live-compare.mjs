/* global sourceFiles, candidateView, candidateStageView, priorityExpression, indexDefinition, inlinePlanningIndex */
import {register} from 'node:module';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pool,closeDb} from '/app/src/db.js';
// sourceFiles and candidateView are supplied from the captured release, not the live filesystem.
const hooks=`const sources=${JSON.stringify(sourceFiles)};
export async function resolve(specifier,context,next){
 const candidate=specifier.includes('?requestCandidate=1') || context.parentURL?.includes('?requestCandidate=1');
 const result=await next(specifier.replace('?requestCandidate=1',''),{...context,parentURL:context.parentURL?.replace('?requestCandidate=1','')});
 if(candidate && result.url.startsWith('file:///app/src/') && !result.url.endsWith('/db.js')) result.url+='?requestCandidate=1';
 return result;
}
export async function load(url,context,next){
 const clean=url.replace('?requestCandidate=1','');
 if(url!==clean && sources[clean]) return {format:'module',source:sources[clean],shortCircuit:true};
 return next(clean,context);
}`;
register('data:text/javascript,'+encodeURIComponent(hooks),import.meta.url);
pool.options.max=1;
pool.options.options='-c jit=off -c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=2000 -c application_name=mbbs_request_loading_compare';
const originalQuery=pool.query.bind(pool);let optimized=false;let queries=[];
const views={dispatch_effective_order_completion_events:candidateView};
try {
 await originalQuery('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const settings=(await originalQuery("SELECT current_setting('transaction_read_only') AS read_only")).rows[0];
 if(settings.read_only!=='on'){throw Error('Read-only transaction required');}
 for(const name of ['dispatch_order_completion_status','special_stock_workflow_stages'])
  {views[name]=(await originalQuery('SELECT pg_get_viewdef($1::regclass,true) AS sql',[name])).rows[0].sql.replace(/;\s*$/,'');}
 views.special_stock_workflow_stages=candidateStageView;
 const ctes=Object.entries(views).map(([name,sql])=>`${name} AS (${sql.replace(/public\.(dispatch_effective_order_completion_events|dispatch_order_completion_status|special_stock_workflow_stages)/g,'$1')})`).join(',\n');
 pool.query=async(sql,params)=>{
  const started=performance.now();const key=sql.replace(/'(?:''|[^'])*'/g,"'?'").replace(/\s+/g,' ').slice(0,190);
  if(optimized && /\b(dispatch_effective_order_completion_events|dispatch_order_completion_status|special_stock_workflow_stages)\b/.test(sql)) {
   sql=/^\s*WITH\b/i.test(sql)?sql.replace(/^\s*WITH\s+(RECURSIVE\s+)?/i,(_,recursive)=>`WITH ${recursive||''}${ctes},\n`):`WITH ${ctes}\n${sql}`;
  }
  if(optimized && inlinePlanningIndex && sql.includes('dispatch_snapshot_planning_refs(snapshot.orders,snapshot.trucks)')) {
   const expression=indexDefinition.replace(/;\s*$/,'').replace(/\borders\b/g,'snapshot.orders').replace(/\btrucks\b/g,'snapshot.trucks');
   sql=sql.replace('dispatch_snapshot_planning_refs(snapshot.orders,snapshot.trucks)',()=>`(${expression})`);
  }
  if(optimized && inlinePlanningIndex){sql=sql.replaceAll('dispatch_completion_evidence_priority(event.completion_evidence_type)',()=>`(${priorityExpression.replace(/\bevidence_type\b/g,'event.completion_evidence_type')})`);}
  const result=await originalQuery(sql,params);queries.push({sql:key,ms:performance.now()-started});return result;
 };
 const baseline={special:await import('/app/src/special-stock-request-repository.js'),regular:await import('/app/src/stock-request-repository.js'),alerts:await import('/app/src/special-stock-alerts.js')};
 const candidate={special:await import('/app/src/special-stock-request-repository.js?requestCandidate=1'),regular:await import('/app/src/stock-request-repository.js?requestCandidate=1'),alerts:await import('/app/src/special-stock-alerts.js?requestCandidate=1')};
 const yards=[1,28,15,26];
 const cases=[
 ['special-sales',m=>m.special.listSpecialStockCases({audience:'sales',authorizedStoreLocationIds:yards,limit:60})],
 ['special-scm',m=>m.special.listSpecialStockCases({audience:'scm',limit:60})],
 ['regular-sales',m=>m.regular.listSalesStockRequests({authorizedDestinationLocationIds:yards,bucket:'pending',limit:100})],
 ['regular-scm',m=>m.regular.listScmStockRequests({queue:'request',limit:100})],
 ['special-scm-alerts',m=>m.alerts.getSpecialStockAlertCounts()],
 ['special-stage',m=>m.special.listSpecialStockCases({audience:'scm',stage:'confirmed',limit:20})],
 ['special-empty-search',m=>m.special.listSpecialStockCases({audience:'sales',authorizedStoreLocationIds:yards,search:'TEST-NONEXISTENT-REQUEST-LOAD',limit:60})],
 ['special-pagination',m=>m.special.listSpecialStockCases({audience:'scm',offset:30,limit:10})],
 ['regular-sales-completed',m=>m.regular.listSalesStockRequests({authorizedDestinationLocationIds:yards,bucket:'completed',limit:100})],
 ['regular-scm-closed',m=>m.regular.listScmStockRequests({queue:'closed',limit:100})]
 ];
 function canonical(v){if(v instanceof Date){return v.toJSON();}if(Array.isArray(v)){return v.map(canonical);}if(v&&typeof v==='object'){return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));}return v;}
 const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
 for(const [label,read] of cases){
  const values=[];
  for(const [version,modules] of [['before',baseline],['candidate',candidate]]){
   optimized=version==='candidate';queries=[];const started=performance.now();const value=await read(modules);values.push(value);
   console.log(JSON.stringify({kind:'measurement',label,version,ms:Math.round(performance.now()-started),rows:Array.isArray(value)?value.length:null,bytes:Buffer.byteLength(JSON.stringify(value)),hash:hash(value),queryCount:queries.length,slowest:queries.sort((a,b)=>b.ms-a.ms).slice(0,3)}));
  }
  const same=hash(values[0])===hash(values[1]);console.log(JSON.stringify({kind:'equivalence',label,same}));if(!same){throw Error('Output mismatch: '+label);}
 }
 await originalQuery('ROLLBACK');
}finally{await closeDb();}
