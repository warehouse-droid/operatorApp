import assert from 'node:assert/strict';
export const mutants = {
  conversion:['src/inventory-workflow-domain.js','(values[unit.key] ?? 0)*Number(item[unit.factor])','(values[unit.key] ?? 0)', 'domain'],
  ownership:['src/inventory-workflow-domain.js'," || sheet.owner_id!==actor.id",'', 'domain'],
  incomplete:['src/count-sheet-repository.js','sheet.counted!==sheet.total || !sheet.total','!sheet.total','count'],
  unknown_retry:['src/inventory-damage-service.js','if(uncertain) {throw','if(false) {throw','damage'],
  acknowledged:['src/inventory-damage-service.js','!acknowledged && !error.damageWriteAcknowledged && ','','damage']
};
export async function load(url,context,nextLoad) {
  const result=await nextLoad(url,context);
  const name=process.env.INVENTORY_MUTANT,mutant=mutants[name];
  if(!mutant || !url.endsWith('/'+mutant[0])) {return result;}
  const source=String(result.source);
  assert.equal(source.split(mutant[1]).length,2,'Mutation anchor must occur once');
  process.stderr.write(`INVENTORY_MUTATION_APPLIED:${name}\n`);
  return {...result,source:source.replace(mutant[1],mutant[2])};
}
