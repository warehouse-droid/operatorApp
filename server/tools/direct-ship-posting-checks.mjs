import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {scanUnifiedDiff,scanTextForSecrets} from '../test/support/scan-diff-secrets.mjs';
const server=path.resolve(process.env.DIRECT_SHIP_CHECK_SERVER||process.cwd());
const out=path.resolve('test-artifacts/direct-ship-posting-20261001');
const release=path.join(server,'deployments/direct-ship-posting-20261001');
const read=(base,name)=>readFileSync(path.join(base,name),'utf8');
const manifest=JSON.parse(read(release,'manifest.json'));
const digest=file=>createHash('sha256').update(readFileSync(path.join(server,file))).digest('hex');
assert.deepEqual(Object.fromEntries(Object.keys(manifest.sourceHashes).map(file=>[file,digest(file)])),manifest.sourceHashes);
assert.match(read(out,'exact-candidate.log'),/# fail 0\n/u);assert.match(read(out,'coverage.log'),/# fail 0\n/u);
assert.equal(read(out,'lint-final.log').trim(),'');
function diagnostics(name){
 const result=new Map();
 for(const line of read(out,name).split('\n')){
  if(!line.includes(': error TS')){continue;}
  const normalized=line.replace(/\(\d+,\d+\)/u,'');result.set(normalized,(result.get(normalized)||0)+1);
 }
 return result;
}
const before=diagnostics('baseline-types.log'),after=diagnostics('candidate-types.log');
const newErrors=[...after].filter(([error,count])=>count>(before.get(error)||0));assert.deepEqual(newErrors,[]);
const coverage=JSON.parse(read(out,'coverage/coverage-summary.json')).total;
for(const [key,minimum] of [['lines',95],['statements',95],['functions',95],['branches',90]]){assert.ok(coverage[key].pct>=minimum,key+' below project threshold');}
const mutations=JSON.parse(read(out,'mutations.json'));assert.equal(mutations.passed,true);assert.equal(mutations.results.length,6);
for(const [file,hash] of Object.entries(mutations.sourceHashes)){assert.equal(digest(file),hash);}
const findings=scanUnifiedDiff(read(release,'workspace.patch'));
for(const file of ['src/netsuite-fulfillable-items.js','src/direct-po-auto-receipt-domain.js','src/direct-po-auto-receipt.js','migrations/253_direct_ship_netsuite_posting.sql']){
 findings.push(...scanTextForSecrets(read(server,file),file));
}
assert.deepEqual(findings,[]);
const checks={passed:true,checkedAt:new Date().toISOString(),sourceHashes:manifest.sourceHashes,
 exactCandidateTests:Number(read(out,'exact-candidate.log').match(/# tests (\d+)/u)[1]),
 coverage:Object.fromEntries(Object.entries(coverage).map(([name,value])=>[name,value.pct])),
 mutantsKilled:6,lintPassed:true,newTypeErrors:0,existingTypeErrors:[...before.values()].reduce((a,b)=>a+b,0),secretFindings:0};
writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2)+'\n');console.log(JSON.stringify(checks));
