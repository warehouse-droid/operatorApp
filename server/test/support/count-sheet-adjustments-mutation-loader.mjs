import assert from 'node:assert/strict';
export const mutants = {
  sign:['count-sheet-repository.js','c.quantity-c.actual_on_hand+$4::numeric','c.actual_on_hand-c.quantity+$4::numeric'],
  retainedCounts:['count-sheet-repository.js',"DELETE FROM inventory_count_sheet_counts WHERE sheet_id=$1","DELETE FROM inventory_count_sheet_counts WHERE sheet_id=$1 AND attempt=-1"],
  staleRevision:['count-sheet-repository.js','if(Number(input.revision)!==sheet.revision)','if(false)'],
  submittedTimestamp:['count-sheet-repository.js','owner_id=NULL,submitted_at=NULL,attempt=attempt+1','owner_id=NULL,attempt=attempt+1'],
  lostAdjustment:['count-sheet-repository.js','variance=EXCLUDED.variance+inventory_count_sheet_counts.adjusting','variance=EXCLUDED.variance']
};
export async function load(url,context,nextLoad) {
  const result=await nextLoad(url,context), name=process.env.COUNT_ADJUSTMENTS_MUTANT;
  if (!name) {return result;}
  const [file, from, to]=mutants[name];
  if (!url.endsWith('/src/'+file)) {return result;}
  const source=String(result.source);
  assert.equal(source.split(from).length,2,'Unique mutation anchor required');
  process.stderr.write(`COUNT_ADJUSTMENTS_MUTATION:${name}\n`);
  return {...result,source:source.replace(from,to)};
}
