import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const original=fs.readFileSync('public/operator.js','utf8');
const mutants={
  stale_result:['const isCurrent = () => fulfillmentOrder?.netsuite_id === orderId && fulfillmentLoadRequestId === requestId;','const isCurrent = () => true;'],
  drop_journal:['async function continueOperatorWork() {','async function continueOperatorWork() { rememberFulfillmentPosting(null); rememberReceiptPosting(null);'],
  rotate_held:['retryWithNewRequest = job?.status === "failed";','retryWithNewRequest = ["failed", "attention"].includes(job?.status);'],
  stale_refresh:['const isCurrent = () => (fulfillmentOrder || selectedOrder) === order && fulfillmentLoadRequestId === requestId;','const isCurrent = () => true;']
};
const results=[];
for(const [name,[oldText,newText]] of Object.entries(mutants)) {
  assert(original.includes(oldText));
  const file='/tmp/review-'+name+'.js';fs.writeFileSync(file,original.replace(oldText,newText));
  const r=spawnSync(process.execPath,['--test','tools/incident/ui.test.mjs'],{encoding:'utf8',env:{...process.env,OPERATOR_REVIEW_SOURCE:file}});
  assert.equal(r.status,1,name+' survived');assert.match(r.stdout,/ERR_ASSERTION/);assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/);
  results.push({name,killed:true});
}
console.log(JSON.stringify({mutants:results}));
