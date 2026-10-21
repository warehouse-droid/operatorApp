import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import coverage from 'istanbul-lib-coverage';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
const out = resolve('test-artifacts/linked-group-plan-save-20261001');
const own = ['test/mbt/integration/linked-group-plan-save.test.js', 'test/mbt/property/linked-group-plan-save.property.test.js'];
const regressions = ['test/mbt/unit/link-to-group.test.js', 'test/mbt/integration/link-to-group.test.js',
  'test/mbt/integration/link-to-group-http.test.js', 'test/dispatch/unit/goa-co-planning.test.js',
  'test/dispatch/integration/goa-co-planning.test.js', 'test/dispatch/integration/co-direct-to.test.js',
  'test/dispatch/integration/co-supply-reference.test.js', 'test/dispatch/integration/dispatch-retired-confirm.test.js'];
const file = 'src/server.js';
const source = readFileSync(file, 'utf8');
const hash = createHash('sha256').update(source).digest('hex');
const failureNames = log => [...new Set([...log.matchAll(/^(?:not ok \d+ - (.+)|✖ (.+) \([\d.]+ms\))$/gm)]
  .map(match => match[1] || match[2]))].sort();
const baselineFailures = failureNames(readFileSync(out + '/regressions-baseline.log', 'utf8'));

function run(label, args, { cwd = process.cwd(), failures = [], mutant = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 30000000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(out + '/' + label + '.log', log);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
    [...log.matchAll(new RegExp('^(?:#|ℹ) ' + key + ' (\\d+)$', 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0)]));
  console.log(JSON.stringify({ label, status: result.status, ...counts }));
  if (mutant) {
    assert.ok(result.status === 1 && counts.fail > 0 && /ERR_ASSERTION|AssertionError|Property failed/u.test(log), label + ': mutant survived');
  } else {
    assert.deepEqual(failureNames(log), failures, label + ': new test failures: ' + log.slice(-3000));
    assert.equal(result.status, failures.length ? 1 : 0, label + ': ' + log.slice(-3000));
  }
  return counts;
}

run('syntax-final', ['--check', file]);
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {
    process: 'readonly', Buffer: 'readonly', console: 'readonly', fetch: 'readonly',
    URL: 'readonly', URLSearchParams: 'readonly', structuredClone: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
    setImmediate: 'readonly', performance: 'readonly', AbortController: 'readonly'
  } }, rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'no-redeclare': 'error', 'no-unreachable': 'error', 'no-constant-condition': 'error', 'no-duplicate-imports': 'error' }
}] });
const findings = async text => (await lint.lintText(text, { filePath: file }))[0].messages
  .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
const beforeFindings = await findings(readFileSync(out + '/before/' + file, 'utf8'));
const finalFindings = await findings(source);
const newFindings = finalFindings.filter(finding => {
  const index = beforeFindings.indexOf(finding);
  if (index < 0) { return true; }
  beforeFindings.splice(index, 1);
  return false;
});
assert.deepEqual(newFindings, [], 'New runtime lint findings');
run('new-files-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--max-warnings=0',
  ...own, 'tools/linked-group-plan-save-check.mjs', 'tools/linked-group-plan-save-live.mjs',
  'tools/linked-group-plan-save-order.mjs', 'tools/linked-group-plan-save-full.mjs']);
const forward = run('focused-final', ['tools/linked-group-plan-save-order.mjs', ...own, ...regressions], { failures: baselineFailures });
const reverse = run('focused-reverse', ['tools/linked-group-plan-save-order.mjs', ...[...own, ...regressions].reverse()], { failures: baselineFailures });
run('coverage-final', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', '--include=src/server.js', '--reporter=json',
  '--report-dir=' + out + '/coverage', '--temp-directory=' + out + '/v8',
  'node', 'tools/linked-group-plan-save-order.mjs', ...own]);
const comparison = JSON.parse(readFileSync(out + '/candidate-diffs.json'))[file];
assert.equal(comparison.sourceHash, hash);
const changed = new Set();
for (const match of comparison.diff.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)) {
  for (let line = Number(match[1]); line < Number(match[1]) + Number(match[2] ?? 1); line += 1) { changed.add(line); }
}
const measured = coverage.createCoverageMap(JSON.parse(readFileSync(out + '/coverage/coverage-final.json')))
  .fileCoverageFor(resolve(file)).getLineCoverage();
const executable = [...changed].filter(line => Object.hasOwn(measured, line));
const uncovered = executable.filter(line => !measured[line]);
assert.deepEqual(uncovered, [], 'Unexecuted changed lines');
const coverageResult = { total: executable.length, covered: executable.length, uncovered };
writeFileSync(out + '/changed-lines.json', JSON.stringify(coverageResult, null, 2));

const directory = '/tmp/linked-group-mutants-' + process.pid;
mkdirSync(directory);
for (const folder of ['src', 'public', 'test']) { cpSync(folder, directory + '/' + folder, { recursive: true }); }
cpSync('package.json', directory + '/package.json');
mkdirSync(directory + '/tools');
cpSync('tools/linked-group-plan-save-order.mjs', directory + '/tools/linked-group-plan-save-order.mjs');
symlinkSync(resolve('node_modules'), directory + '/node_modules', 'dir');
const mutants = [
  { name: 'ignore-persisted-group',
    from: 'const comparisonPlan = await dispatchOrderStructureComparisonPlan(previousPlan, nextPlan);',
    to: 'const comparisonPlan = previousPlan;' },
  { name: 'trust-incoming-members',
    from: '...established.rows.map((row) => row.full_order)',
    to: '...(nextPlan.orders || []).filter(order => groupRefs.includes(order.id))' },
  { name: 'override-existing-snapshot',
    from: '&& !previousRefs.has(String(order.id || "").trim())',
    to: '&& true' },
  { name: 'restore-co-source-membership',
    from: '.filter((ref) => structuralRefs.has(ref)).sort()',
    to: '.sort()' }
];
const mutationResults = [];
try {
  for (const mutant of mutants) {
    assert.equal(source.split(mutant.from).length, 2, mutant.name + ': ambiguous mutation');
    writeFileSync(directory + '/' + file, source.replace(mutant.from, mutant.to));
    run('mutant-' + mutant.name, ['tools/linked-group-plan-save-order.mjs', ...own], { cwd: directory, mutant: true });
    run('property-mutant-' + mutant.name, ['--test', '--test-name-pattern=properties:', own[1]], { cwd: directory, mutant: true });
    mutationResults.push({ name: mutant.name, killed: true, propertyKilled: true });
  }
} finally {
  rmSync(directory, { recursive: true });
}
assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), hash, 'Source drift');
const diff = comparison.diff;
assert.equal(/(?:AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(diff), false, 'Secret in diff');
const result = { passed: true, sourceHashes: { [file]: hash }, forward, reverse, baselineFailures,
  runtimeLint: { existing: finalFindings.length, added: 0 }, newFileLint: { added: 0 },
  coverage: coverageResult, mutationResults, secrets: { passed: true, newDependencies: 0 },
  tools: { node: process.version, ...Object.fromEntries(['eslint', 'c8', 'fast-check'].map(name =>
    [name, JSON.parse(readFileSync('node_modules/' + name + '/package.json')).version])) } };
writeFileSync(out + '/checks.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
