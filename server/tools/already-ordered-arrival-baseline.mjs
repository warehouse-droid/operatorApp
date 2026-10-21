import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const out='test-artifacts/already-ordered-arrival-20261020';
function result(name){
  const text=readFileSync(`${out}/${name}.log`,'utf8');
  const count=key=>Number([...text.matchAll(new RegExp('^# '+key+' (\\d+)$','gm'))].at(-1)?.[1]);
  assert(Number.isSafeInteger(count('tests'))&&count('tests')>0,'Incomplete '+name+' run');
  const failures=[...text.matchAll(/^not ok \d+ - (.+)\n  ---\n([\s\S]*?)\n  \.\.\./gm)].map(([,test,body])=>({
    test,location:body.match(/location: (.+)/)?.[1],failureType:body.match(/failureType: (.+)/)?.[1],
    error:body.match(/error: ([^\n]+)/)?.[1],assertion:body.match(/at TestContext\.<anonymous> \(([^\n]+)\)/)?.[1]
  }));
  assert.equal(failures.length,count('fail'),'Unparsed failure in '+name);
  return {tests:count('tests'),passed:count('pass'),failed:count('fail'),failures};
}
const baseline=result('baseline'),current=result('legacy');
assert.equal(current.tests,baseline.tests,'Legacy test count changed');
for(const failed of current.failures)assert.deepEqual(failed,baseline.failures.find(row=>row.test===failed.test),'New or changed legacy failure');
writeFileSync(out+'/baseline-comparison.json',JSON.stringify({baseline,current,newFailures:0},null,2));
console.log(JSON.stringify({legacyTests:current.tests,passed:current.passed,baselineFailures:current.failed,newFailures:0}));
