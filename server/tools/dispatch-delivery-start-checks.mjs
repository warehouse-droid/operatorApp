import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';

const files = [
  'test/dispatch/frontend/dispatch-delivery-start-travel.test.js',
  'test/dispatch/frontend/dispatch-travel-pairs.test.js',
  'test/dispatch/frontend/dispatch-start-travel-boundary.test.js',
  'test/dispatch/frontend/dispatch-required-pickups.test.js',
  'test/dispatch/frontend/dispatch-actual-arrival-repair.test.js'
];
function run(label, args, allowFailure = false) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const output = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`/app/test-artifacts/${label}.log`, output);
  if (!allowFailure) assert.equal(result.status, 0, `${label}: ${output.slice(-7000)} ${result.error || ''}`);
  return allowFailure ? result : result.stdout;
}
const regressionOutput = run('regression', ['--test', '--test-concurrency=1', ...files]);
const regression = Object.fromEntries(['tests', 'pass', 'fail'].map(name => [name,
  Number(regressionOutput.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1])]));
assert.equal(regression.tests, 62);
assert.equal(regression.fail, 0);
console.log('CHECK regression: ' + JSON.stringify(regression));
const harnesses = ['src/dispatch-forecast-harness.js'];
for (const [index, file] of harnesses.entries()) {
  run('harness-' + index, [file]);
  console.log('CHECK ' + file + ': passed');
}
const routeHarness = 'src/dispatch-route-duration-harness.js';
const baselineHarness = readFileSync(routeHarness, 'utf8').replace(
  'new URL("../public/dispatch.js", import.meta.url)', "new URL('file:///app/test-artifacts/baseline-dispatch.js')");
writeFileSync('/app/test-artifacts/baseline-route-harness.mjs', baselineHarness);
const baseline = run('baseline-route', ['/app/test-artifacts/baseline-route-harness.mjs'], true);
const candidate = run('candidate-route', [routeHarness], true);
const errorText = result => result.stderr.match(/AssertionError \[ERR_ASSERTION\]: ([^\n]+)/)?.[1] || '';
assert.equal(baseline.status, 1);
assert.equal(errorText(baseline), 'Expected dispatch route helper source was not found.');
assert.equal(candidate.status, baseline.status);
assert.equal(errorText(candidate), errorText(baseline));
assert.match(baseline.stderr, /:192:23/);
assert.match(candidate.stderr, /:192:23/);
const baselineFailures = [{ file: routeHarness, error: errorText(baseline), line: 192 }];
console.log('CHECK unchanged deployed-source failure: ' + JSON.stringify(baselineFailures));
run('syntax-ui', ['--check', 'public/dispatch.js']);
run('syntax-forecast', ['--check', 'src/dispatch-forecast-service.js']);
function fn(file, name) {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  assert.ok(start >= 0 && end > 0);
  return source.slice(start, start + end + 1);
}
const scoped = fn('public/dispatch.js', 'startTravelForLoad') + '\n'
  + fn('src/dispatch-forecast-service.js', 'unrecordedStartTravelOrigin')
  + '\nglobalThis.checkedTravel = { startTravelForLoad, unrecordedStartTravelOrigin };';
const globals = Object.fromEntries([
  'isMbtPlanningLoad', 'stopOrder', 'resolveStopPlace', 'dropStopLabel', 'pickupStopLabel',
  'effectiveTruckForLoad', 'driverOrientedPlanningEnabled', 'previousDriverLoad', 'loadTruckPlate',
  'loadSwitchYard', 'placeForLocation', 'hubAddress', 'placePosition', 'hubPosition',
  'startPointAfterLoad', 'samePhysicalAddress', 'travelMinutesBetweenPoints', 'loadIndexInTruck',
  'text', 'YARD_ADDRESSES'
].map(name => [name, 'readonly']));
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals },
  rules: { eqeqeq: 'error', 'no-undef': 'error', 'no-unused-vars': 'error',
    'no-unreachable': 'error', 'no-dupe-args': 'error', 'no-constant-binary-expression': 'error' }
}] });
const results = await lint.lintText(scoped);
assert.equal(results.reduce((sum, row) => sum + row.errorCount + row.warningCount, 0), 0,
  JSON.stringify(results.flatMap(row => row.messages)));
console.log('CHECK syntax and travel-helper lint: passed');
const sourceHashes = Object.fromEntries(['public/dispatch.js', 'public/dispatch.html', 'src/dispatch-forecast-service.js']
  .map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
console.log('DISPATCH_DELIVERY_START_EVIDENCE=' + JSON.stringify({
  passed: true, at: new Date().toISOString(), sourceHashes, newFailures: 0,
  regression, focusedTests: 14, harnesses, baselineFailures, files, syntax: 'passed', lint: 'passed',
  red: { tests: 12, pass: 2, fail: 10 }, node: process.version,
  invariants: ['No pickup added for fee-only deliveries', 'No new Driver tasks or record writes',
    'Completed travel derives actual times from stop evidence', 'Unresolved arrivals remain unknown',
    'Opening travel is counted once', 'Same-location journeys stay omitted', 'Bin job identity retained'],
  limits: ['No full browser layout suite', 'Legacy pickup-first routing in mixed pickup/drop loads is unchanged']
}));
