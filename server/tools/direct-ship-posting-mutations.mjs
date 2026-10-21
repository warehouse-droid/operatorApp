import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const mutations=[
 {name:'exclude-special-item',file:'src/netsuite-fulfillable-items.js',before:"return type === 'InvtPart' || /^MBBS-Special Order$/iu.test(name);",after:"return type === 'InvtPart';"},
 {name:'allow-completed-source',file:'src/netsuite-fulfillable-items.js',before:"['C','F','G','H'].includes(status || '')",after:"[].includes(status || '')"},
 {name:'allow-wrong-po-parent',file:'src/direct-po-auto-receipt-domain.js',before:"source.sourceOrderKind !== 'PO' || Number(source.sourceNetSuiteId) !== parent",after:"source.sourceOrderKind !== 'PO'"},
 {name:'ignore-receipt-line-cap',file:'src/direct-po-auto-receipt-domain.js',before:'remainingQuantity:Number(line.remainingQuantity)',after:'remainingQuantity:Number(line.orderedQuantity)'},
 {name:'skip-before-send-so-check',file:'src/operator-netsuite-posting-netsuite-adapter.js',before:'if (step.dispatchAutoFulfillment)',after:'if (false)'},
 {name:'bypass-receiving-gate',file:'src/direct-po-auto-receipt.js',before:'if(!policy.effective)',after:'if(false)'}
];
const sourceHash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const before=Object.fromEntries(mutations.map(m=>[m.file,sourceHash(m.file)]));
const results=[];
for(const mutation of mutations){
 const registration=`import {register} from 'node:module';register(${JSON.stringify(new URL('./direct-ship-posting-mutation-loader.mjs',import.meta.url).href)});`;
 const integration=mutation.name==='bypass-receiving-gate';
 const test=integration?'test/mbt/integration/direct-ship-posting.test.js':'test/mbt/unit/direct-ship-posting.test.js';
 const run=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(registration),'--test','--test-concurrency=1',test],
  {env:{...process.env,DIRECT_SHIP_MUTATION_JSON:JSON.stringify(mutation)},encoding:'utf8',timeout:60000});
 writeFileSync('test-artifacts/direct-ship-posting-20261001/mutant-'+mutation.name+'.log',run.stdout+run.stderr);
 const behaviorFailure=/ERR_ASSERTION|AssertionError/u.test(run.stdout+run.stderr)
  || (integration && /not ok \d+ - disabled receiving gate/u.test(run.stdout)
    && /An effective, matching Operator NetSuite posting policy is required/u.test(run.stdout));
 const killed=run.status===1&&behaviorFailure;
 results.push({name:mutation.name,killed,exitCode:run.status});assert.equal(killed,true,'Mutant survived or failed for another reason: '+mutation.name);
}
assert.deepEqual(Object.fromEntries(Object.keys(before).map(file=>[file,sourceHash(file)])),before,'Workspace source must never be changed by mutations');
writeFileSync('test-artifacts/direct-ship-posting-20261001/mutations.json',JSON.stringify({passed:true,results,sourceHashes:before},null,2)+'\n');
console.log(JSON.stringify({passed:true,killed:results.length,total:mutations.length}));
