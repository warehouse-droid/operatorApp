import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const out = resolve('test-artifacts/special-unit-identity-20261005');
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) rmSync(out + '/' + entry, { recursive: true, force: true });
const source = 'src/special-stock-netsuite-adapter.js';
const own = 'test/mbt/unit/special-unit-identity.test.js';
const existing = readdirSync('test/mbt/unit').filter(name => /^special.*\.test\.js$/.test(name)
  && name !== 'special-unit-identity.test.js').sort().map(name => 'test/mbt/unit/' + name);
const text = readFileSync(source, 'utf8');
const base = readFileSync('/baseline/src/special-stock-netsuite-adapter.js', 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const counts = log => Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
  [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
const failures = log => [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
function run(label, command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 30000000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(out + '/' + label + '.log', log);
  assert.ok(result.status !== null, label + ': ' + result.error);
  console.log(JSON.stringify({ label, exit: result.status, ...counts(log) }));
  return { status: result.status, log, counts: counts(log), failures: failures(log) };
}
function copyTree(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  for (const directory of ['src', 'public', 'test', 'tools', 'migrations']) cpSync(directory, path + '/' + directory, { recursive: true });
  for (const file of ['package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']) cpSync(file, path + '/' + file);
  symlinkSync('/app/node_modules', path + '/node_modules');
  return path;
}
const baselineRoot = copyTree('/tmp/special-unit-identity-baseline');
writeFileSync(baselineRoot + '/' + source, base);
const baseline = run('baseline', process.execPath, ['--test', '--test-concurrency=1', ...existing], baselineRoot);
assert.ok(baseline.counts.tests > 0);
const red = run('red', process.execPath, ['--test', own], baselineRoot);
assert.equal(red.status, 1);
assert.ok(red.failures.includes('SPREQ-000032 resolves SQFT from the native self link and preserves complete line values'));
assert.ok(red.failures.includes('property: native self links resolve exactly across supported UOM label fields'));

const tests = run('regressions', '/app/node_modules/.bin/c8', ['--all=false', '--check-coverage=false', '--include=' + source,
  '--temp-directory=' + out + '/c8', '--report-dir=' + out + '/coverage', '--reporter=json', '--reporter=text',
  process.execPath, '--test', '--test-concurrency=1', ...existing, own]);
const newFailures = tests.failures.filter(name => !baseline.failures.includes(name));
writeFileSync(out + '/baseline.json', JSON.stringify(baseline, null, 2));
assert.deepEqual(newFailures, [], 'New regression failures');
const focused = run('focused', process.execPath, ['--test', own]);
assert.equal(focused.status, 0);

const typeArgs = ['--noEmit', '--allowJs', '--checkJs', '--strict', '--skipLibCheck', '--types', 'node',
  '--target', 'ES2022', '--module', 'NodeNext', source];
const types = run('types', '/app/node_modules/.bin/tsc', typeArgs);
assert.equal(types.status, 0);
assert.equal(run('syntax', process.execPath, ['--check', source]).status, 0);
const lint = new ESLint({ overrideConfigFile: resolve('tools/special-workflow-native-eslint.config.mjs') });
const lintFiles = [source, own, 'tools/special-unit-identity-20261005/gauntlet.mjs',
  'tools/special-unit-identity-20261005/verify-live.mjs'];
const lintResults = await lint.lintFiles(lintFiles);
writeFileSync(out + '/lint.json', JSON.stringify(lintResults, null, 2));
assert.equal(lintResults.reduce((total, result) => total + result.errorCount + result.warningCount, 0), 0);

// Compare the pristine source with the saved live adapter to identify added executable lines.
const currentLines = text.split('\n');
const changed = [];
const diff = spawnSync('diff', ['-U0', '/baseline/' + source, source], { encoding: 'utf8' });
assert.equal(diff.status, 1, 'Expected the adapter to differ from its live baseline');
let line = 0;
for (const entry of diff.stdout.split('\n')) {
  const hunk = entry.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (hunk) line = Number(hunk[1]);
  else if (entry.startsWith('+') && !entry.startsWith('+++')) {
    const code = currentLines[line - 1];
    if (code.trim() && !/^(?:\s*\*|\s*\/\*|\s*\/\/|\s*}\s*$)/.test(code)) changed.push(line);
    line += 1;
  } else if (entry.startsWith(' ')) line += 1;
}
const report = Object.values(JSON.parse(readFileSync(out + '/coverage/coverage-final.json', 'utf8')))
  .find(file => file.path.endsWith('/' + source));
assert.ok(report);
const uncovered = changed.filter(line => !Object.entries(report.statementMap).some(([key, statement]) =>
  statement.start.line <= line && statement.end.line >= line && report.s[key] > 0));
writeFileSync(out + '/changed-lines.json', JSON.stringify({ changed, uncovered }, null, 2));
assert.deepEqual(uncovered, []);

const mutants = [
  ['wrong-native-unit', '  return number;\n}\n\n/** REST transaction units', '  return typeId;\n}\n\n/** REST transaction units'],
  ['foreign-units-type', 'Number(match[1]) !== typeId', 'false'],
  ['accept-zero-unit', 'number <= 0) {', 'number < 0) {'],
  ['unsafe-unit', 'Number(match[1]) !== typeId || !Number.isSafeInteger(number) || number <= 0) {', 'Number(match[1]) !== typeId || number <= 0) {'],
  ['explicit-precedence', 'const explicit = unit.internalId ?? unit.id;', 'const explicit = unit.id ?? unit.internalId;']
];
const mutationRoot = '/tmp/special-unit-identity-mutants';
mkdirSync(mutationRoot + '/src', { recursive: true });
mkdirSync(mutationRoot + '/test/mbt/unit', { recursive: true });
cpSync(own, mutationRoot + '/' + own);
cpSync('package.json', mutationRoot + '/package.json');
symlinkSync('/app/node_modules', mutationRoot + '/node_modules');
const mutations = [];
for (const [name, original, replacement] of mutants) {
  assert.equal(text.split(original).length, 2, name + ' replacement must be unique');
  writeFileSync(mutationRoot + '/' + source, text.replace(original, replacement));
  const full = run('mutation-' + name, process.execPath, ['--test', own], mutationRoot);
  const property = run('property-mutation-' + name, process.execPath, ['--test', '--test-name-pattern=property:', own], mutationRoot);
  assert.equal(full.status, 1, name + ' survived the regression suite');
  assert.equal(property.status, 1, name + ' survived the generated cases');
  mutations.push({ name, killed: true, propertyKilled: true });
}
writeFileSync(mutationRoot + '/' + source, text);
assert.equal(sha(readFileSync(source)), sha(text), 'Mounted source changed during mutation');
const health = run('suite-health', process.execPath, ['--test', '--test-concurrency=1', own, ...existing.toReversed()]);
assert.deepEqual(health.failures.toSorted(), tests.failures.toSorted());

const files = [source, own, 'test/special-unit-identity-spec.md', 'tools/special-unit-identity-20261005/gauntlet.mjs',
  'tools/special-unit-identity-20261005/run.py', 'tools/special-unit-identity-20261005/verify-live.mjs',
  'tools/special-unit-identity-20261005/deploy.py', 'tools/special-unit-identity-20261005/baseline/src/special-stock-netsuite-adapter.js'];
assert.equal(run('secrets', process.execPath, ['test/support/scan-diff-secrets.mjs', ...files]).status, 0);
const summary = {
  sourceHash: sha(text), baselineHash: sha(base), baseline: baseline.counts, baselineFailures: baseline.failures,
  regressions: tests.counts, focused: focused.counts, newFailures, types: 'pass', lint: 'pass',
  changedLines: { covered: changed.length, total: changed.length }, mutations,
  properties: { count: 3, examplesEach: 100, mutationKills: mutations.length }, suiteHealth: health.counts,
  red: red.counts, manifest: Object.fromEntries(files.map(file => [file, sha(readFileSync(file))])),
  tools: Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check'].map(name =>
    [name, JSON.parse(readFileSync('/app/node_modules/' + name + '/package.json')).version]))
};
writeFileSync(out + '/summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
