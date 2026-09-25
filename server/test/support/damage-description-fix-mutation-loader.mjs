import assert from 'node:assert/strict';
export const mutants={
  overlong:['description:marker(report)','description:`${report.item_name} ${marker(report)}`'],
  identity:['return `DMG:${report.id}`;','return "DMG";'],
  legacy:[' || description.includes(`[Damage report ${report.id}]`)','']
};
export async function load(url,context,nextLoad) {
  const result=await nextLoad(url,context);
  const name=process.env.DAMAGE_DESCRIPTION_MUTANT,mutant=mutants[name];
  if(!mutant || !url.endsWith('/src/inventory-damage-service.js')) return result;
  const source=String(result.source);
  assert.equal(source.split(mutant[0]).length,2,'Mutation anchor must occur once');
  process.stderr.write(`DAMAGE_DESCRIPTION_MUTATION_APPLIED:${name}\n`);
  return {...result,source:source.replace(...mutant)};
}
