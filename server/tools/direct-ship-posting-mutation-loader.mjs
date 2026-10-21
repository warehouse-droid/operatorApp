import assert from 'node:assert/strict';
export async function load(url,context,nextLoad) {
 const result=await nextLoad(url,context);
 const mutation=JSON.parse(process.env.DIRECT_SHIP_MUTATION_JSON);
 if(url.endsWith('/'+mutation.file)){
  const source=String(result.source);
  assert.equal(source.split(mutation.before).length-1,1,'Mutation must match exactly one source location');
  return {...result,source:source.replace(mutation.before,mutation.after)};
 }
 return result;
}
