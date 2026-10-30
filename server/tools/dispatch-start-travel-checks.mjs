import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { browserGuard, guardNames, runtimePath, runtimeSource, source, sourceFunction } from '../test/support/dispatch-start-travel-fixture.mjs';

const output = path.dirname(runtimePath);
mkdirSync(output, { recursive: true });
const incidentFile = 'test/dispatch/frontend/dispatch-start-travel-boundary.test.js';
const files = [
  incidentFile,
  'test/dispatch/frontend/dispatch-repeat-pickup-visits.red.test.js',
  'test/dispatch/frontend/dispatch-required-pickups.test.js',
  'test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js',
  'test/dispatch/unit/dispatch-activity-allocation-scope.test.js',
  'test/dispatch/unit/executed-prefix-historical-reflexivity.test.js',
  'test/dispatch/unit/dispatch-weight-save.test.js',
  'test/dispatch/unit/dispatch-executed-order-review.test.js',
  'test/dispatch/unit/dispatch-executed-order-incidents.test.js',
  'test/dispatch/property/dispatch-executed-order-review.test.js',
  'test/dispatch/property/dispatch-repeat-pickup-visits.property.test.js',
  'test/dispatch/adversarial/dispatch-repeat-pickup-visits.adversarial.test.js'
];
const baselineFailures = [
  'RP-08 sequence, timing, capacity, labels, and tooltips use visit-scoped orders',
  'RP-05 active travel protects its destination while allowing work after it'
].sort();

function run(label, args, { env = {}, allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000,
    maxBuffer: 16 * 1024 * 1024
  });
  writeFileSync(path.join(output, label + '.log'), (result.stdout || '') + (result.stderr || ''));
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${(result.stdout || '').slice(-6000)}\n${result.stderr || result.error || ''}`);
  }
  return result;
}

function counts(stdout) {
  const get = name => Number(stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1]);
  const failures = [...stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
  return { tests: get('tests'), pass: get('pass'), fail: get('fail'), failures };
}

// Node sorts multiple test-file arguments; run files separately to enforce order.
const shuffled = [...files].sort((left, right) =>
  createHash('sha256').update('20261022' + left).digest('hex')
    .localeCompare(createHash('sha256').update('20261022' + right).digest('hex')));
const regression = counts(run('regression', ['--test', '--test-concurrency=1', ...files], { allowFailure: true }).stdout);
assert.deepEqual(regression.failures, baselineFailures, 'New failures or a changed baseline');
assert.equal(regression.tests, 96);
const reordered = { tests: 0, pass: 0, fail: 0, failures: [] };
for (const [index, file] of shuffled.entries()) {
  const result = counts(run('reordered-' + index, ['--test', file], { allowFailure: true }).stdout);
  reordered.tests += result.tests;
  reordered.pass += result.pass;
  reordered.fail += result.fail;
  reordered.failures.push(...result.failures);
}
reordered.failures.sort();
assert.deepEqual(reordered, regression);
console.log('CHECK regression: ' + JSON.stringify(regression));

const focused = counts(run('incident', ['--test', incidentFile]).stdout);
assert.equal(focused.tests, 14);
assert.equal(focused.fail, 0);
browserGuard([]);
run('syntax', ['--check', 'public/dispatch.js']);

const globals = { driverJobStatuses: 'readonly' };
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  files: ['**/*.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals },
  rules: { eqeqeq: 'error', 'no-undef': 'error', 'no-unreachable': 'error',
    'no-unused-vars': 'error', 'no-dupe-args': 'error', 'no-constant-condition': 'error',
    'no-constant-binary-expression': 'error', 'no-var': 'error', 'prefer-const': 'error' }
}] });
const lintResults = await lint.lintText(runtimeSource + '\nglobalThis.dispatchTravelGuard = { ' + guardNames.join(', ') + ' };',
  { filePath: 'public/dispatch-travel-guard.js' });
assert.equal(lintResults.reduce((sum, row) => sum + row.errorCount + row.warningCount, 0), 0,
  JSON.stringify(lintResults.flatMap(row => row.messages)));

const typed = `// @ts-check
/** @typedef {{id: string, type: string, location?: string, orderId?: string}} RouteStop */
/** @typedef {{id: string, stops: RouteStop[]}} RouteLoad */
/** @typedef {{status?: string, load_id?: string, loadId?: string, stop_type?: string, stopType?: string, stop_id?: string, stopId?: string, job_id?: string, jobId?: string, order_refs?: string[], orderRefs?: string[]}} Activity */
/** @type {Activity[]} */
let driverJobStatuses = [];
` + runtimeSource
  .replace('function executionStatusFromRecord(record)', '/** @param {Activity | null | undefined} record @returns {string} */\nfunction executionStatusFromRecord(record)')
  .replace('function loadDriverActivityRecords(load)', '/** @param {RouteLoad | null | undefined} load @returns {Activity[]} */\nfunction loadDriverActivityRecords(load)')
  .replace('function stopDriverActivityRecords(foundOrLoad, stopValue = null)', '/** @param {any} foundOrLoad @param {RouteStop | null} stopValue */\nfunction stopDriverActivityRecords(foundOrLoad, stopValue = null)')
  .replace('function stopHasDriverActivity(foundOrLoad, stopValue = null)', '/** @param {any} foundOrLoad @param {RouteStop | null} stopValue */\nfunction stopHasDriverActivity(foundOrLoad, stopValue = null)')
  .replace('function physicalActivityPositionChanged(load, nextStops = [])', '/** @param {RouteLoad} load @param {RouteStop[]} nextStops @returns {boolean} */\nfunction physicalActivityPositionChanged(load, nextStops = [])')
  .replace('const stopIds = (stops) =>', 'const stopIds = (/** @type {RouteStop[]} */ stops) =>')
  .replace('function dispatchEditableRouteBoundary(load)', '/** @param {RouteLoad} load @returns {number} */\nfunction dispatchEditableRouteBoundary(load)')
  .replace('function isPhysicalDriverActivityRecord(record', '/** @param {any} record */\nfunction isPhysicalDriverActivityRecord(record')
  .replace('function driverActivityDetails(record', '/** @param {any} record @returns {any} */\nfunction driverActivityDetails(record');
const typePath = path.join(output, 'dispatch-travel-types.js');
writeFileSync(typePath, typed);
run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
  '--target', 'es2022', '--types', 'node', typePath]);
console.log('CHECK syntax, scoped lint, typed route fields: passed');

const coverageConfig = path.join(output, 'coverage-config.json');
const coverageDir = path.join(output, 'coverage');
writeFileSync(coverageConfig, JSON.stringify({ all: false, 'check-coverage': false,
  include: ['test-artifacts/**/dispatch-travel-runtime.js', 'test-artifacts/dispatch-travel-runtime.js'],
  exclude: [], reporter: ['json', 'json-summary'], 'report-dir': coverageDir,
  'temp-directory': path.join(output, '.c8') }));
run('coverage', ['node_modules/c8/bin/c8.js', '--config', coverageConfig, process.execPath, '--test', incidentFile]);
const coverage = JSON.parse(readFileSync(path.join(coverageDir, 'coverage-final.json'), 'utf8'));
const runtimeCoverage = Object.values(coverage).find(entry => entry.path === runtimePath);
assert.ok(runtimeCoverage, 'Coverage did not include the actual extracted production guard');
const changedNames = ['driverActivityDetails', 'dispatchEditableRouteBoundary'];
const ranges = changedNames.map(name => {
  const start = runtimeSource.indexOf(`function ${name}(`);
  return { first: runtimeSource.slice(0, start).split('\n').length,
    last: runtimeSource.slice(0, start + sourceFunction(name).length).split('\n').length };
});
const changedStatements = Object.entries(runtimeCoverage.statementMap)
  .filter(([, location]) => ranges.some(range => location.start.line >= range.first && location.start.line <= range.last));
const uncovered = changedStatements.filter(([id]) => !runtimeCoverage.s[id]);
assert.deepEqual(uncovered, [], 'Uncovered changed guard statements');
const coverageSummary = { statements: changedStatements.length, covered: changedStatements.length - uncovered.length,
  scope: 'actual extracted production details parser and route boundary functions' };
console.log('CHECK coverage: ' + JSON.stringify(coverageSummary));

const mutations = [
  ['blanket-lock', 'targetIndex = firstPickupIndex;', 'targetIndex = stops.length - 1;'],
  ['unlock-destination', 'targetIndex = firstPickupIndex;', 'targetIndex = firstPickupIndex - 1;'],
  ['wrong-load', '&& jobParts[2] === encodeURIComponent(String(load.id || ""))', ''],
  ['inter-stop-leg', '&& !jobParts[6]', ''],
  ['wrong-yard', '&& jobParts[5] === encodeURIComponent(String(stops[firstPickupIndex].location || ""))', ''],
  ['ignore-physical', 'stopHasDriverActivity(load, stop) ? Math.max(maximum, index) : maximum', 'stopHasDriverActivity(load, stop) ? maximum : maximum']
];
const mutationResults = [];
for (const [name, before, after] of mutations) {
  assert.equal(source.split(before).length, 2, 'Mutation anchor must be unique: ' + name);
  const mutantPath = path.join(output, name + '.js');
  writeFileSync(mutantPath, source.replace(before, after));
  const options = { env: { DISPATCH_TRAVEL_SOURCE: mutantPath }, allowFailure: true };
  const full = run('mutant-' + name, ['--test', incidentFile], options);
  const properties = run('mutant-property-' + name, ['--test', '--test-name-pattern=^property:', incidentFile], options);
  assert.notEqual(full.status, 0, 'Surviving mutation: ' + name);
  assert.ok(counts(full.stdout).fail > 0, 'Mutant must fail an assertion: ' + name);
  mutationResults.push({ name, killed: true, propertyKilled: properties.status !== 0 });
}
assert.equal(run('restored', ['--test', incidentFile]).status, 0);
console.log('CHECK mutations: ' + JSON.stringify(mutationResults));

const sourceHashes = Object.fromEntries(['public/dispatch.js', 'public/dispatch.html']
  .map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
const evidence = {
  passed: true, at: new Date().toISOString(), specApproval: 'not obtained (autonomous run)',
  sourceHashes, newFailures: 0, regression, reordered: true, shuffledFileOrder: shuffled, focused,
  coverage: coverageSummary, syntax: 'passed', lint: 'passed', types: 'passed',
  mutations: { total: mutations.length, killed: mutationResults.filter(row => row.killed).length,
    propertyKilled: mutationResults.filter(row => row.propertyKilled).length, results: mutationResults },
  versions: Object.fromEntries(['typescript', 'eslint', 'fast-check', 'c8']
    .map(name => [name, JSON.parse(readFileSync('node_modules/' + name + '/package.json', 'utf8')).version])),
  node: process.version,
  limits: [
    'Full application and browser layout suites omitted: only the existing planning guard and asset version change.',
    'Types apply to extracted route fields; existing legacy parsing boundaries retain any.',
    'Physical activity mutation is covered by scenario tests; suffix/encoding properties alone do not cover physical evidence.',
    'No live dispatch plan or driver record is rewritten by this fix.'
  ]
};
console.log('DISPATCH_TRAVEL_EVIDENCE=' + JSON.stringify(evidence));
