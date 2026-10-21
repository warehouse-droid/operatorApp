import assert from 'node:assert/strict';
export const mutants={
  validate:['validateRows(result,batch,sheet.location_id);','/* omitted response validation */'],
  yard:['fetchBalances(batch,[sheet.location_id])','fetchBalances(batch,[28])'],
  save:['await upsertInventoryBalancesBulk(rows);','/* omitted stock cache update */'],
  generation:["countSheetCommand(current,actor,{attempt:sheet.attempt,revision:sheet.revision},'line');",'/* omitted generation recheck */'],
  historical:["if(sheet.status!=='in_progress') {return sheet;}",'/* refresh even completed sheets */']
};
export async function load(url,context,nextLoad) {
  const result=await nextLoad(url,context),name=process.env.COUNT_REFRESH_MUTANT;
  if(!name || !url.endsWith('/src/count-sheet-stock-refresh.js')) {return result;}
  const [before,after]=mutants[name],source=String(result.source);
  assert.equal(source.split(before).length,2,'Mutation anchor must be unique');
  process.stderr.write(`COUNT_REFRESH_MUTATION_APPLIED:${name}\n`);
  return {...result,source:source.replace(before,after)};
}
