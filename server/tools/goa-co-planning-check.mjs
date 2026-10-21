import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
const out = resolve('test-artifacts/goa-co-planning-20261001');
mkdirSync(out, { recursive: true });
const files = ['src/sor-rental-policy.js', 'src/yard-dependency-structure.js', 'public/dispatch.js'];
const own = ['test/dispatch/unit/goa-co-planning.test.js', 'test/dispatch/integration/goa-co-planning.test.js'];
const regressions = [
  'test/dispatch/unit/sor-rental-policy.test.js',
  'test/dispatch/unit/dispatch-co-group-identity.red.test.js',
  'test/dispatch/property/dispatch-co-group-identity.property.test.js',
  'test/dispatch/frontend/dispatch-to-dependency-planning-authority.red.test.js',
  'test/dispatch/frontend/dispatch-retired-confirm.test.js',
  'test/dispatch/frontend/dispatch-co-cargo-preservation.test.js',
  'test/dispatch/frontend/dispatch-co-global-lifecycle.contract.test.js',
  'test/dispatch/frontend/dispatch-co-vrma-custom.contract.test.js',
  'test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js',
  'test/dispatch/integration/dispatch-co-cargo-preservation.test.js',
  'test/dispatch/integration/co-direct-to.test.js',
  'test/dispatch/integration/co-supply-reference.test.js',
  'test/dispatch/integration/sor-rental-repository.test.js'
];
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHashes = Object.fromEntries(files.map(file => [file, hash(file)]));
const baselineLog = readFileSync(out + '/regressions-baseline.log', 'utf8');
const baselineFailures = [...baselineLog.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();

function run(label, args, { cwd = process.cwd(), fails = false, expectedFailures = [], baselineError } = {}) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 20000000 });
  const log = (r.stdout || '') + (r.stderr || '');
  writeFileSync(out + '/' + label + '.log', log);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, [...log.matchAll(new RegExp('^# ' + key + ' (\\d+)$', 'gm'))]
      .reduce((total, match) => total + Number(match[1]), 0)]));
  console.log(JSON.stringify({ label, exitCode: r.status, ...counts }));
  if (fails) {
    assert.ok(r.status !== 0 && counts.fail > 0 && /ERR_ASSERTION|Property failed|DISPATCH_ORDER_DEPENDENCY_CONFLICT/u.test(log),
      label + ': mutant survived or failed without a behavior assertion: ' + log.slice(-2000));
  } else if (baselineError) {
    const normalize = value => value.replace(/:\d+:\d+/gu, ':LINE:COLUMN');
    assert.equal(r.status, 1, label + ': baseline failure changed');
    assert.equal(normalize(log), normalize(readFileSync(out + '/' + baselineError, 'utf8')),
      label + ': the failure must match the unchanged app');
  } else {
    const failures = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
    assert.deepEqual(failures, expectedFailures, label + ': new test failures: ' + log.slice(-5000));
    assert.equal(r.status, expectedFailures.length ? 1 : 0, label + ': ' + log.slice(-5000));
  }
  return counts;
}

for (const file of files) {run('syntax-' + file.split('/').at(-1), ['--check', file]);}
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  files: ['**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {
    document: 'readonly', window: 'readonly', location: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
    navigator: 'readonly', alert: 'readonly', confirm: 'readonly', requestAnimationFrame: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
    console: 'readonly', fetch: 'readonly', AbortController: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
    structuredClone: 'readonly', Blob: 'readonly', crypto: 'readonly', performance: 'readonly'
  } }, rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'no-redeclare': 'error', 'no-unreachable': 'error', 'no-constant-condition': 'error', 'no-duplicate-imports': 'error' }
}] });
const lintReport = {};
for (const file of files) {
  const findings = async source => (await lint.lintText(source, { filePath: file }))[0].messages
    .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
  const old = await findings(readFileSync(out + '/candidate-before/' + file, 'utf8'));
  const now = await findings(readFileSync(file, 'utf8'));
  const newFindings = now.filter(finding => {
    const index = old.indexOf(finding);
    if (index < 0) {return true;}
    old.splice(index, 1);
    return false;
  });
  assert.deepEqual(newFindings, [], file + ': new lint findings');
  lintReport[file] = { existingFindings: now.length, newFindings: 0 };
}

run('new-files-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--max-warnings=0',
  ...own, 'test/support/goa-co-browser.mjs', 'test/support/goa-co-suite-timeout-loader.mjs',
  'tools/goa-co-planning-browser.mjs', 'tools/goa-co-planning-check.mjs', 'tools/goa-co-planning-coverage.mjs',
  'tools/goa-co-planning-live.mjs', 'tools/goa-co-planning-order.mjs']);
const focused = run('focused-final', ['tools/goa-co-planning-order.mjs', ...own, ...regressions], { expectedFailures: baselineFailures });
const reverse = run('focused-reverse', ['tools/goa-co-planning-order.mjs', ...[...own, ...regressions].reverse()], { expectedFailures: baselineFailures });
if (process.argv.includes('--ordering-only')) {
  const proof = JSON.parse(readFileSync(out + '/checks.json'));
  assert.equal(proof.passed, true);
  assert.deepEqual(proof.sourceHashes, sourceHashes);
  proof.focused = focused;
  proof.reverse = reverse;
  proof.ordering = { explicit: true, forward: [...own, ...regressions], reverse: [...own, ...regressions].reverse() };
  proof.newFileLint = { passed: true, diagnostics: 0 };
  writeFileSync(out + '/checks.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ passed: true, explicitOrdering: true, focused, reverse }));
  process.exit(0);
}
run('browser-final', ['tools/goa-co-planning-browser.mjs']);
run('dependency-structure', ['src/yard-dependency-structure-harness.js']);
run('driver-order', ['src/dispatch-driver-order-harness.js'], { baselineError: 'driver-order-baseline.log' });
run('coverage-final', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  '--include=src/sor-rental-policy.js', '--include=src/yard-dependency-structure.js', '--include=public/dispatch.js',
  '--exclude=test/**', '--reporter=json', '--report-dir=' + out + '/coverage', '--temp-directory=' + out + '/v8',
  'node', '--test', '--test-concurrency=1', ...own, ...regressions], { expectedFailures: baselineFailures });
run('changed-lines', ['tools/goa-co-planning-coverage.mjs']);

const mutationDir = '/tmp/goa-co-mutations-' + process.pid;
mkdirSync(mutationDir);
for (const folder of ['src', 'public', 'test']) {cpSync(folder, mutationDir + '/' + folder, { recursive: true });}
cpSync('package.json', mutationDir + '/package.json');
symlinkSync(resolve('node_modules'), mutationDir + '/node_modules', 'dir');
const mutations = [
  { name: 'rental-route-overwrite', file: files[0],
    from: "if (clean(order.type).toUpperCase() === 'CO' || /^CO-/iu.test(clean(order.id))) {return order;}", to: '', properties: true },
  { name: 'source-delivery-alias', file: files[1],
    from: '&& (!coOrder || ownRefs.includes(ref) || /^CO-/iu.test(ref))', to: '&& true', properties: true },
  { name: 'browser-placement-block', file: files[2],
    from: 'function replenishmentPlacementBlockMessage(order, targetTruck, targetLoad, insertIndex = null) {\n  if (order?.type === "CO" || /^CO-/iu.test(String(order?.id || ""))) return "";',
    to: 'function replenishmentPlacementBlockMessage(order, targetTruck, targetLoad, insertIndex = null) {', properties: true },
  { name: 'real-delivery-check-disabled', file: 'src/order-dependency-repository.js',
    from: 'export async function validateDispatchPlanDependencies(plan = {}) {',
    to: 'export async function validateDispatchPlanDependencies(plan = {}) { return [];', properties: false },
  { name: 'catalog-route-recovery-disabled', file: 'src/dispatch-order-catalog-repository.js',
    from: 'const canonical = order.type === "CO"', to: 'const canonical = false', properties: false }
];
const mutationResults = [];
try {
  for (const mutant of mutations) {
    const target = mutationDir + '/' + mutant.file;
    const source = readFileSync(target, 'utf8');
    assert.equal(source.split(mutant.from).length, 2, mutant.name + ': ambiguous mutation');
    writeFileSync(target, source.replace(mutant.from, mutant.to));
    try {
      run('mutant-' + mutant.name, ['--test', '--test-concurrency=1', ...own], { cwd: mutationDir, fails: true });
      if (mutant.properties) {run('property-mutant-' + mutant.name,
        ['--test', '--test-name-pattern=properties', own[0]], { cwd: mutationDir, fails: true });}
      mutationResults.push({ name: mutant.name, killed: true, propertyKill: mutant.properties });
    } finally {
      writeFileSync(target, source);
    }
  }
} finally {
  rmSync(mutationDir, { recursive: true });
}
assert.deepEqual(Object.fromEntries(files.map(file => [file, hash(file)])), sourceHashes, 'Source drift');
const result = { passed: true, sourceHashes, focused, reverse, lintReport, mutationResults,
  newFileLint: { passed: true, diagnostics: 0 },
  ordering: { explicit: true, forward: [...own, ...regressions], reverse: [...own, ...regressions].reverse() },
  baselineFailures, newFailures: [],
  harnessBaselineFailures: ['driver-order: isMbtPlanningLoad is not defined'],
  coverage: JSON.parse(readFileSync(out + '/changed-lines.json')),
  browser: JSON.parse(readFileSync(out + '/browser.json')),
  tools: { node: process.version, ...Object.fromEntries(['eslint', 'c8', 'fast-check', '@playwright/test'].map(name =>
    [name, JSON.parse(readFileSync('node_modules/' + name + '/package.json')).version])) } };
writeFileSync(out + '/checks.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: true, focused, reverse, mutantsKilled: mutationResults.length }));
