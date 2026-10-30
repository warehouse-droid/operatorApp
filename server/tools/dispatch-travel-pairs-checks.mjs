import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';

const artifact = '/app/test-artifacts';
function run(label, args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
  writeFileSync(`${artifact}/${label}.log`, (result.stdout || '') + (result.stderr || ''));
  assert.ok(result.status === 0 || result.status === 1, `${label}: ${result.error || result.stderr}`);
  const counts = Object.fromEntries(['tests', 'pass', 'fail'].map(name => [name,
    Number(result.stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1])]));
  counts.failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
  assert.ok(counts.tests > 0, `${label}: no test results`);
  return counts;
}

const contractFile = 'test/dispatch/frontend/dispatch-planner-performance.contract.test.js';
const baselineTest = readFileSync(contractFile, 'utf8')
  .replace('new URL("../../../public/dispatch.js", import.meta.url)', `new URL('file://${artifact}/baseline-dispatch.js')`)
  .replace('new URL("../../../src/server.js", import.meta.url)', "new URL('file:///app/src/server.js')")
  .replace('import("./dispatch-performance-recording.js")', 'import("/app/test/dispatch/frontend/dispatch-performance-recording.js")');
writeFileSync(`${artifact}/baseline-contract.mjs`, baselineTest);
const baseline = run('baseline', ['--test', `${artifact}/baseline-contract.mjs`]);
const files = [
  'test/dispatch/frontend/dispatch-travel-pairs.test.js',
  'test/dispatch/frontend/dispatch-start-travel-boundary.test.js',
  contractFile,
  'test/dispatch/frontend/dispatch-actual-arrival-repair.test.js',
  'test/dispatch/frontend/dispatch-required-pickups.test.js'
];
const regression = run('regression', ['--test', '--test-concurrency=1', ...files]);
assert.deepEqual(regression.failures, baseline.failures, 'Unexpected failures compared with captured deployed source');
assert.equal(regression.tests, 80);
console.log('CHECK regression: ' + JSON.stringify(regression));
console.log('CHECK deployed-source baseline: ' + JSON.stringify(baseline));

const source = readFileSync('public/dispatch.js', 'utf8');
const names = ['travelLegEndpointMatchesVisit', 'travelLegMatchesVisitPair', 'travelLegForVisitPair'];
const scoped = names.map(name => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  assert.ok(start >= 0 && end > 0);
  return source.slice(start, start + end + 1);
}).join('\n');
const globals = Object.fromEntries(['resolveStopPlace', 'normalizedPlaceKey', 'samePhysicalAddress',
  'interStopForecastLegs', 'forecastRecordForStop', 'interStopExecutionEvidenceForLoad'].map(name => [name, 'readonly']));
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals },
  rules: { 'no-undef': 'error', 'no-unused-vars': 'error', 'no-unreachable': 'error',
    'no-constant-condition': 'error', 'no-constant-binary-expression': 'error', eqeqeq: 'error' }
}] });
const results = await lint.lintText(scoped + `\nglobalThis.travelPairDisplay = { ${names.join(', ')} };`);
assert.equal(results.reduce((sum, row) => sum + row.errorCount + row.warningCount, 0), 0,
  JSON.stringify(results.flatMap(row => row.messages)));
console.log('CHECK syntax and changed-helper lint: passed');

const sourceHashes = Object.fromEntries(['public/dispatch.js', 'public/dispatch.html']
  .map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
console.log('DISPATCH_PAIR_EVIDENCE=' + JSON.stringify({
  passed: true, at: new Date().toISOString(), sourceHashes, newFailures: 0,
  regression, baseline, focusedTests: 11, syntax: 'passed', lint: 'passed',
  files, red: { tests: 10, pass: 3, fail: 7 },
  scope: 'Actual UI visit, travel matching, card, preview, and timing-detail functions; separate stops preserved.',
  limits: 'No full browser layout run; no backend route or saved plan changes.', node: process.version
}));
