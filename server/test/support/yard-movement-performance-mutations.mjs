import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
export const mutants={
  aliasIndex:['src/yard-movement-repository.js','LOWER(BTRIM(o.dispatch_ref))',"LOWER(BTRIM(COALESCE(o.dispatch_ref, '')))"],
  allHistory:['src/yard-movement-repository.js','${selectedOrder ? `AND LOWER(BTRIM(ref.order_ref)) IN (${selectedOrderReferencesSql()})`', '${false ? `AND LOWER(BTRIM(ref.order_ref)) IN (${selectedOrderReferencesSql()})`'],
  referenceCase:['src/yard-movement-repository.js','AND LOWER(BTRIM(ref.order_ref)) IN (${selectedOrderReferencesSql()})','AND BTRIM(ref.order_ref) IN (${selectedOrderReferencesSql()})'],
  emptyScope:['src/yard-movement-repository.js','allowedClauses.push("FALSE")','allowedClauses.push("TRUE")'],
  staleDetail:['public/yard-movement-requests.js','if (pending.get(channel) === entry) await apply(data);','await apply(data);'],
  hiddenError:['public/yard-movement-requests.js','if (pending.get(channel) === entry) throw error;','if (false) throw error;']
};
export function mutate(file,source){
  const name=process.env.YARD_PERF_MUTANT;
  if(!name || mutants[name][0]!==file) return source;
  const [,from,to]=mutants[name];
  assert.equal(source.split(from).length,2,'Unique mutation anchor required: '+name);
  process.stderr.write('YARD_PERF_MUTATION:'+name+'\n');
  return source.replace(from,to);
}
export async function load(url,context,nextLoad){
  const result=await nextLoad(url,context);
  if(process.env.YARD_PERF_OLD_FIXTURE==='1') {
    for(const file of ['src/yard-movement-repository.js','test/mbt/integration/yard-movement-po-search.test.js']) {
      if(url.endsWith('/'+file)) return {...result,source:readFileSync('/baseline/'+file,'utf8')};
    }
  }
  if(url.endsWith('/src/yard-movement-repository.js')) return {...result,source:mutate('src/yard-movement-repository.js',String(result.source))};
  return result;
}
