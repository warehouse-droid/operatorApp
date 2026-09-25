import {readFile} from 'node:fs/promises';
const mutations={
 hash:['src/netsuite-order-webhook-queue-policy.js','return 0;','return String(left.payloadHash) < String(right.payloadHash) ? -1 : 1;'],
 missing:['src/operator-load-state.js','const missing = outstanding.filter','const missing = [].filter'],
 claims:['src/operator-load-state-repository.js','claim.active=true','claim.active=false'],
 observed:['src/operator-netsuite-posting-service.js','observedTransaction: failureDetails(error).observedTransaction || observedTransaction','observedTransaction: undefined'],
 completed:['src/operator-load-state.js','requiredQuantity(line) - positive(line.loaded_qty)','requiredQuantity(line)'],
 repair_rollback:['tools/sob120541-repair.mjs','rollback:!apply','rollback:false'],
 repair_item:['tools/sob120541-repair.mjs',"assert.equal(Number(actual.find(row=>Number(row.orderLine)===line.orderLine)?.item?.id),line.item,'IF item must match the approved line');",'void actual;']
};
export async function load(url,context,next){
 const mutation=mutations[process.env.LOAD_FOLLOWUP_MUTANT];
 if(mutation&&url.endsWith('/'+mutation[0])){
  const source=await readFile(new URL(url),'utf8');if(!source.includes(mutation[1]))throw new Error('Mutation target missing');
  return {format:'module',shortCircuit:true,source:source.replace(mutation[1],mutation[2])};
 }
 return next(url,context);
}
