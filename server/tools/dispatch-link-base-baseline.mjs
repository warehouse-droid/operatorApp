import {writeFileSync} from 'node:fs';
import {isolatedRun} from './dispatch-source-decision-checks.mjs';
const results=[];
for(const file of ['test/dispatch/frontend/dispatch-po-ref-link-search.test.js',
  'test/dispatch/integration/dispatch-special-po-lifecycle.test.js',
  'test/dispatch/integration/to-dependency-packing-independent.test.js']) {
  const result=await isolatedRun(file,{prefix:'link-base-baseline'});results.push(result);console.log(JSON.stringify(result));
}
writeFileSync('test-artifacts/baseline-regressions.json',JSON.stringify(results,null,2));
