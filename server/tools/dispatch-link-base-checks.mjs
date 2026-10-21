import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';
const integration='test/dispatch/integration/dispatch-link-base.test.js';
const property='test/dispatch/property/dispatch-link-base.test.js';
const browser='test/dispatch/frontend/dispatch-link-base.browser.test.mjs';
const files = [integration,property,browser,
  'test/dispatch/integration/dispatch-po-count.test.js',
  'test/dispatch/unit/dispatch-po-count.test.js',
  'test/dispatch/integration/order-dependency-multi-to-extension.red.test.js',
  'test/dispatch/integration/order-dependency-quantity-replay.red.test.js',
  'test/dispatch/integration/to-dependency-packing-independent.test.js',
  'test/dispatch/integration/dispatch-special-po-lifecycle.test.js',
  'test/dispatch/unit/dispatch-special-po-lifecycle.test.js',
  'test/dispatch/property/dispatch-special-po-lifecycle.test.js',
  'test/dispatch/property/dispatch-po-route-residual.property.test.js',
  'test/dispatch/property/order-dependency-quantity.property.test.js',
  'test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js',
  'test/dispatch/frontend/dispatch-po-ref-link-search.test.js',
  'test/dispatch/frontend/billed-order-po-link.test.js',
  'test/dispatch/unit/dispatch-group-member-po.test.js',
  'test/dispatch/unit/historical-group-pickups.test.js',
  'test/dispatch/unit/dispatch-po-route-residual.red.test.js',
  'test/dispatch/unit/dispatch-po-line-destinations.test.js',
  'test/dispatch/integration/dispatch-po-pickup-yard.test.js',
  'test/dispatch/integration/dispatch-required-pickups-save.test.js',
  'test/dispatch/integration/dispatch-po-split-link-target.test.js',
  'test/dispatch/frontend/dispatch-group-pickup-card.test.js',
  'test/dispatch/frontend/scm-dependency-atomic-ui.red.test.js',
  'test/dispatch/frontend/dispatch-link-dialog-stability.browser.test.mjs',
  'test/dispatch/unit/dispatch-activity-allocation-scope.test.js',
  'test/dispatch/unit/dispatch-executed-order-review.test.js'];
const results=[];
for(const file of files.sort((a,b)=>a.localeCompare(b))) {
  const result=await isolatedRun(file,{prefix:'link-base'});
  results.push(result);console.log(JSON.stringify(result));
}
writeFileSync('test-artifacts/regressions.json',JSON.stringify(results,null,2));
const baseline=JSON.parse(readFileSync('test-artifacts/baseline-regressions.json','utf8'));
for(const result of results) {
  if(result.exit===0) continue;
  const previous=baseline.find(entry=>entry.file===result.file);
  assert.ok(previous,`New failing suite: ${result.file}`);
  assert.deepEqual(result,previous,`Regression changed from deployed baseline: ${result.file}`);
}
console.log(JSON.stringify({regressionsPassed:true,tests:results.reduce((sum,result)=>sum+result.tests,0),
  passed:results.reduce((sum,result)=>sum+result.pass,0),unchangedBaselineFailures:results.reduce((sum,result)=>sum+result.fail,0)}));
await import('./dispatch-link-base-quality.mjs');
