import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const root = process.cwd();
const output = path.resolve('test-artifacts');
const file = 'src/shared-json-read.js';
const newTests = ['test/mbt/unit/shared-json-read.test.js', 'test/mbt/unit/shared-json-read-http.test.js'];
const tests = [...newTests, 'test/mbt/unit/reconciliation-blockers.test.js', 'test/mbt/integration/reconciliation-blockers.test.js',
  'test/mbt/unit/dispatch-bin-accessible-assignment.test.js', 'test/mbt/integration/dispatch-assignment-bin-scan.test.js'];
const evidence = { specApproval: 'not obtained (autonomous run)', tier: 3,
  red: { tests: 8, passed: 1, failed: 7, note: 'One initial HTTP failure was a test-client issue: fetch adds Cache-Control: no-cache to conditional requests. Replaced that transport with raw HTTP; retained the 304 expectation and added the baseline 304 assertion.' },
  skipped: { repositoryWideSuite: 'Six directly related suites run; unrelated application suites omitted on the shared host.',
    legacyServerTypes: 'Strict types cover the new module; legacy server syntax, lint baseline and the actual route are checked.',
    dependencyAudit: 'No dependencies added or changed.',
    clientDisconnectStress: 'No cancellation coupling was introduced; pending work belongs to the shared read, not a client.' },
  versions: { node: process.version }, sourceHashes: {} };
evidence.harnessCorrections = ['Enabled the already installed Node type definitions explicitly for TypeScript 7.', 'Moved mutation copies into the disposable artifact directory because test container source is read-only.'];

function run(name, args, { cwd = root, allowed = [0] } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 25e6, timeout: 180000 });
  assert.ifError(result.error);
  const text = result.stdout + result.stderr;
  writeFileSync(path.join(output, `${name}.log`), text);
  if (!allowed.includes(result.status)) { console.log(text.slice(-6500)); }
  assert.ok(allowed.includes(result.status), `${name}: exit ${result.status}`);
  return text;
}

const source = readFileSync(file, 'utf8');
const server = readFileSync('src/server.js', 'utf8');
const baseline = path.join(output, 'lint-baseline');
mkdirSync(path.join(baseline, 'src'), { recursive: true });
mkdirSync(path.join(baseline, 'tools'));
symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'));
for (const entry of readdirSync('tools', { withFileTypes: true })) {
  if (entry.isFile()) { copyFileSync(path.join('tools', entry.name), path.join(baseline, 'tools', entry.name)); }
}
copyFileSync('package.json', path.join(baseline, 'package.json'));
copyFileSync('eslint.mbt.config.js', path.join(baseline, 'eslint.mbt.config.js'));
const originalHandler = '    res.json(await listDispatchPlannedAssignments({ includeSnapshots: req.query.includeSnapshots !== "false" }));';
const changedHandler = '    const response = await readPlannedAssignmentsResponse(req.query.includeSnapshots !== "false");\n    res.set("Content-Type", "application/json; charset=utf-8");\n    res.set("ETag", response.etag).send(response.body);';
assert.ok(server.includes(changedHandler));
writeFileSync(path.join(baseline, 'src/server.js'), server
  .replace('import { createSharedJsonRead } from "./shared-json-read.js";\n', '')
  .replace('const readPlannedAssignmentsResponse = createSharedJsonRead(listDispatchPlannedAssignments);\n\n', '')
  .replace(changedHandler, originalHandler));
function lintMessages(name, directory) {
  return JSON.parse(run(name, [path.join(root, 'node_modules/eslint/bin/eslint.js'), '--config', 'tools/return-ra-eslint.config.mjs', '--format=json', 'src/server.js'], { cwd: directory, allowed: [0, 1] }))
    .flatMap(entry => entry.messages.map(message => `${message.ruleId}:${message.message.replace(/complexity of \d+/g, 'complexity above limit').replace(/line \d+ column \d+/g, 'line N column N')}`));
}
try {
  const before = lintMessages('lint-before', baseline);
  const after = lintMessages('lint-after', root);
  const remaining = [...before];
  const added = after.filter(message => { const index = remaining.indexOf(message); if (index < 0) { return true; } remaining.splice(index, 1); return false; });
  assert.deepEqual(added, []);
  evidence.lint = { baseline: before.length, final: after.length, added: added.length };
} finally { rmSync(baseline, { recursive: true, force: true }); }
run('lint-new', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/shared-json-read-eslint.config.mjs', '--max-warnings=0', file, ...newTests, 'tools/reconciliation-run-5825-checks.mjs']);
run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--strict', '--noEmit', '--skipLibCheck', '--types', 'node', '--target', 'es2023', '--module', 'nodenext', file]);
run('server-syntax', ['--check', 'src/server.js']);
evidence.static = { strictModuleTypes: 'passed', syntax: 'passed', newSourceLint: 'passed' };
console.log('CHECK static passed');
const suite = run('suite', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=true', '--lines=100', '--statements=100', '--functions=100', '--branches=100', `--include=${file}`, `--temp-directory=${output}/v8`, `--report-dir=${output}/coverage`, '--reporter=json-summary', 'node', '--test', '--test-concurrency=1', ...tests]);
evidence.suite = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(suite.match(new RegExp(`# ${key} (\\d+)`))?.[1])]));
evidence.coverage = JSON.parse(readFileSync(`${output}/coverage/coverage-summary.json`, 'utf8')).total;
evidence.routeCoverage = 'Actual server route extracted and executed by real Express HTTP tests, including 200, 304, full/light modes and 500/recovery.';
console.log(`CHECK suite ${JSON.stringify(evidence.suite)}`);
const faults = [
  ['duplicate-work', 'if (existing) { return existing; }', 'if (false && existing) { return existing; }', true],
  ['stale-success', '.finally(() => pending.delete(includeSnapshots))', '.finally(() => {})', true],
  ['mixed-modes', 'const existing = pending.get(includeSnapshots);', 'const existing = pending.values().next().value;', false],
  ['wrong-json', 'JSON.stringify(rows)', 'JSON.stringify([])', true],
  ['wrong-etag', 'body.length.toString(16)', '(body.length + 1).toString(16)', false],
  ['poisoned-retry', '.finally(() => pending.delete(includeSnapshots))', '.then(value => { pending.delete(includeSnapshots); return value; })', false]
];
evidence.mutation = [];
const mutant = path.join(output, 'mutant');
mkdirSync(mutant, { recursive: true });
for (const name of [file, 'src/server.js', ...newTests, 'package.json']) {
  mkdirSync(path.dirname(path.join(mutant, name)), { recursive: true });
  copyFileSync(name, path.join(mutant, name));
}
symlinkSync(path.join(root, 'node_modules'), path.join(mutant, 'node_modules'));
try {
  for (const [name, from, to, property] of faults) {
    assert.ok(source.includes(from));
    writeFileSync(path.join(mutant, file), source.replace(from, to));
    const result = run(`mutant-${name}`, ['--test', '--test-concurrency=1', ...newTests], { cwd: mutant, allowed: [1] });
    assert.match(result, /ERR_ASSERTION|ERR_TEST_FAILURE/);
    if (property) { run(`property-mutant-${name}`, ['--test', '--test-name-pattern=property:', newTests[0]], { cwd: mutant, allowed: [1] }); }
    evidence.mutation.push({ name, killed: true, propertyOnlyKilled: property });
    writeFileSync(path.join(mutant, file), source);
  }
} finally { rmSync(mutant, { recursive: true, force: true }); }
console.log(`CHECK mutation ${faults.length}/${faults.length} killed`);
const reordered = run('suite-reversed', ['--test', '--test-concurrency=1', ...tests.toReversed()]);
evidence.reorderedSuite = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(reordered.match(new RegExp(`# ${key} (\\d+)`))?.[1])]));
for (const name of [file, 'src/server.js', ...newTests]) {
  const content = readFileSync(name, 'utf8');
  evidence.sourceHashes[name] = createHash('sha256').update(content).digest('hex');
  assert.deepEqual(scanTextForSecrets(content, name), []);
}
for (const name of ['c8', 'typescript', 'eslint', 'fast-check']) {
  evidence.versions[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
}
evidence.completedAt = new Date().toISOString();
writeFileSync(`${output}/run-5825-checks-summary.json`, JSON.stringify(evidence, null, 2));
console.log(`CHECK summary ${JSON.stringify(evidence)}`);
