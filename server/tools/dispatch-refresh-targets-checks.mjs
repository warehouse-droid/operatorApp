import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'espree';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';

const browserTest = 'test/dispatch/frontend/dispatch-refresh-targets.browser.test.mjs';
const propertyTest = 'test/dispatch/frontend/dispatch-refresh-targets.test.js';
const coTest = 'test/dispatch/frontend/dispatch-freshness.browser.test.mjs';
const evidence = 'test-artifacts';
const source = readFileSync('public/dispatch.js', 'utf8');
function run(name, args, options = {}) {
  const result = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000, ...options });
  writeFileSync(`${evidence}/${name}.log`, result.stdout + result.stderr);
  assert.equal(result.status, 0, name);
}

process.env.DISPATCH_REFRESH_PHASE = 'verified';
const browserResult = await isolatedRun(browserTest, { prefix: 'refresh-targets' });
assert.equal(browserResult.exit, 0, 'new browser regressions');
process.env.NODE_V8_COVERAGE = '/app/test-artifacts/refresh-targets-v8';
const propertyResult = await isolatedRun(propertyTest, { prefix: 'refresh-targets' });
delete process.env.NODE_V8_COVERAGE;
assert.equal(propertyResult.exit, 0, 'target identity properties');
console.log(JSON.stringify({ browser: browserResult, properties: propertyResult }));

process.env.DISPATCH_FRESHNESS_COVERAGE = '1';
process.env.DISPATCH_FRESHNESS_PHASE = 'refresh-targets-verified';
run('regressions', ['tools/dispatch-freshness-checks.mjs', 'refresh-targets']);
delete process.env.DISPATCH_FRESHNESS_COVERAGE;
const regressions = JSON.parse(readFileSync('test-artifacts/refresh-targets.json', 'utf8'));
const previous = JSON.parse(readFileSync('/workspace/server/test-artifacts/dispatch-freshness-20261019/results/final.json', 'utf8'));
for (const row of regressions.results) {
  const old = previous.results.find(item => item.file === row.file);
  assert.equal(row.exit, old.exit, row.file);
  assert.deepEqual(row.failures, old.failures, row.file);
}
const key = row => JSON.stringify({ ...row, message: row.message.replace(/on line \d+ column \d+/gu, 'at existing declaration') });
const baselineLint = new Set(previous.diagnostics.filter(row => row.file === 'public/dispatch.js').map(key));
assert.ok(regressions.diagnostics.filter(row => row.file === 'public/dispatch.js').every(row => baselineLint.has(key(row))), 'new runtime lint');
console.log(JSON.stringify({ regressions: regressions.results.length, newFailures: 0 }));

run('full-day', ['--test', 'test/dispatch/frontend/dispatch-full-day.browser.test.mjs']);
const replay = JSON.parse(readFileSync('test-artifacts/full-day-replay/latest.json', 'utf8'));
assert.equal(replay.status, 'passed');
assert.equal(replay.consistencyChecks.length, 51);
console.log(JSON.stringify({ fullDay: 'passed', consistencyChecks: 51 }));

const temporary = mkdtempSync('/tmp/dispatch-refresh-targets-mutants-');
const mutants = [
  ['unfiltered-event-identities', 'const targets = dispatchRefreshableOrderRefs(refs, requiredRefs);', 'const targets = refs;', browserTest],
  ['retained-failure-banner', 'if (previousFailure && routeNotice === previousFailure) routeNotice = "";', 'if (false) routeNotice = "";', browserTest],
  ['hidden-real-error', 'routeNotice = `Order-pool refresh failed: ${error.message}`;', 'routeNotice = "";', browserTest],
  ['missing-numeric-alias', 'requested.has(key) || requested.has(dispatchOrderRefKey(order.netsuiteId))', 'requested.has(key)', propertyTest],
  ['missing-assigned-card', '...orderCatalog, ...assignedOrderEvidenceById.values()', '...orderCatalog', propertyTest],
  ['retired-card-returned', 'if (!key || isAuthoritativelyRetiredOrderRef(key)) continue;', 'if (!key) continue;', propertyTest],
  ['missing-structural-cards', 'for (const ref of requiredRefs) {', 'for (const ref of []) {', propertyTest],
  ['missing-new-co', 'payload.coRef && payload.cancelled !== true ? [payload.coRef] : []', '[]', coTest],
  ['detached-pressed-card', 'assignment.load ? render({ save: false }) : renderDispatchOrderPoolPatch()', 'render({ save: false })', coTest]
];
const mutations = [];
try {
  for (const directory of ['src', 'public']) cpSync(directory, `${temporary}/${directory}`, { recursive: true });
  cpSync('test/dispatch/support', `${temporary}/test/dispatch/support`, { recursive: true });
  mkdirSync(`${temporary}/test/dispatch/frontend`, { recursive: true });
  for (const file of [browserTest, propertyTest, coTest]) cpSync(file, `${temporary}/${file}`);
  cpSync('package.json', `${temporary}/package.json`);
  symlinkSync('/app/node_modules', `${temporary}/node_modules`);
  symlinkSync('/app/test-artifacts', `${temporary}/test-artifacts`);
  for (const [name, original, replacement, file] of mutants) {
    assert.equal(source.split(original).length, 2, name);
    writeFileSync(`${temporary}/public/dispatch.js`, source.replace(original, replacement));
    process.env.DISPATCH_REFRESH_PHASE = `mutant-${name}`;
    process.env.DISPATCH_FRESHNESS_PHASE = `refresh-targets-mutant-${name}`;
    const result = await isolatedRun(file, { cwd: temporary, prefix: `refresh-targets-mutant-${name}` });
    assert.notEqual(result.exit, 0, `survived: ${name}`);
    assert.ok(result.failures.length, `must fail an assertion: ${name}`);
    mutations.push({ name, killed: true, failures: result.failures });
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
writeFileSync(`${evidence}/refresh-targets-mutations.json`, JSON.stringify(mutations, null, 2));

const coverage = coverageLibrary.createCoverageMap(JSON.parse(readFileSync('test-artifacts/refresh-targets/verified/coverage.json', 'utf8')));
for (const name of readdirSync('test-artifacts/freshness-browser/refresh-targets-verified')) {
  if (name.endsWith('-coverage.json')) coverage.merge(JSON.parse(readFileSync(`test-artifacts/freshness-browser/refresh-targets-verified/${name}`, 'utf8')));
}
for (const name of readdirSync('test-artifacts/refresh-targets-v8')) {
  if (!name.endsWith('.json')) continue;
  for (const entry of JSON.parse(readFileSync(`test-artifacts/refresh-targets-v8/${name}`, 'utf8')).result || []) {
    if (entry.url !== 'dispatch-refresh-targets-vm:public/dispatch.js') continue;
    const converter = v8ToIstanbul('/app/public/dispatch.js', 0, { source });
    await converter.load();
    converter.applyCoverage([{ functionName: '', isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }, ...entry.functions.slice(1)]);
    coverage.merge(converter.toIstanbul());
  }
}
const changed = JSON.parse(readFileSync('test-artifacts/refresh-targets-changed-lines.json', 'utf8'));
const actual = coverage.fileCoverageFor('/app/public/dispatch.js').getLineCoverage();
const tokens = parse(source, { ecmaVersion: 'latest', sourceType: 'script', tokens: true, loc: true }).tokens;
const executable = new Set(tokens.filter(token => token.type !== 'Punctuator').map(token => token.loc.start.line));
const lines = changed.filter(line => executable.has(line) && Object.hasOwn(actual, line));
const missing = lines.filter(line => actual[line] === 0);
assert.deepEqual(missing, [], 'uncovered changed lines');
const result = { browser: browserResult, properties: propertyResult,
  regressions: { suites: regressions.results.length, pass: regressions.results.reduce((n, row) => n + row.pass, 0), unchangedFailures: regressions.results.filter(row => row.exit) },
  mutations, changedLineCoverage: { executable: lines.length, covered: lines.length - missing.length, missing },
  replay: { actions: replay.actions.length, consistencyChecks: replay.consistencyChecks.length,
    slowActions: replay.actions.filter(row => row.slow), runtimeHashes: replay.runtimeHashes, artifact: replay.artifact },
  limitations: ['Synthetic orders and source-event injection; production data was never used in tests.',
    'The 503 response is a controlled backend failure; order loading, eligibility, authentication and database reads use the real application.',
    'No backend implementation, dependency or schema changes; backend type checks were not repeated.'] };
writeFileSync('test-artifacts/refresh-targets-evidence.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ mutationsKilled: mutations.length, coverage: result.changedLineCoverage }));
