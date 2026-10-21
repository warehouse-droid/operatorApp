import assert from 'node:assert/strict';
export const packedMutants={
  packedZero:['inventory-packed-stock.js','return round(Math.max(0,packed-Math.max(0,fulfilled-positive(line.loaded_qty))));','return 0;'],
  fulfilledIgnored:['inventory-packed-stock.js','fulfilled-positive(line.loaded_qty)','0'],
  loadedTwice:['inventory-packed-stock.js','fulfilled-positive(line.loaded_qty)','fulfilled+positive(line.loaded_qty)'],
  inboundTransfer:['inventory-packed-stock.js',"AND l.line_stage='outbound'",''],
  completedCo:['inventory-packed-stock.js',"AND NOT (o.status='planned' AND (o.loaded_at IS NOT NULL OR COALESCE(o.details->>'sourceCompletionCleanup','') NOT IN ('','false','null')))",''],
  missingGuard:['count-sheet-reconstruction.js',"if(state.fingerprint!==expectedFingerprint)","if(false)"],
  sheetRawVariance:['count-sheet-repository.js','$5::numeric-($9::numeric-$12::numeric)','$5::numeric-$9::numeric'],
  cycleRawVariance:['inventory-repository.js','countedTotal - actualOnHand','countedTotal - normalizeNumber(conversion.quantity_on_hand)']
};
export async function load(url,context,nextLoad) {
  const result=await nextLoad(url,context),name=process.env.PACKED_COUNT_MUTANT;
  if(!name) {return result;}
  const [file,before,after]=packedMutants[name];
  if(!url.endsWith('/src/'+file)) {return result;}
  const source=String(result.source);
  assert.equal(source.split(before).length,2,'Mutation anchor must be unique');
  process.stderr.write(`PACKED_COUNT_MUTATION_APPLIED:${name}\n`);
  return {...result,source:source.replace(before,after)};
}
