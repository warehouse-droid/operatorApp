import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const root = process.cwd();
const output = path.resolve('test-artifacts');
const source = ['src/server.js', 'src/return-credit-memo.js', 'src/return-batch-ra-domain.js',
  'src/return-batch-ra-service.js', 'src/return-repository.js'];
const regression = ['test/mbt/unit/reconciliation-blockers.test.js', 'test/mbt/integration/reconciliation-blockers.test.js'];
const tests = [...regression, ...['return-credit-memo', 'return-batch-ra-domain', 'return-ra-workflow', 'return-ra-client',
  'scm-schedule-status-refresh.red'].map(name => `test/mbt/unit/${name}.test.js`),
...['return-credit-memo', 'return-batch-ra', 'return-ra-workflow', 'return-failed-draft', 'return-pallet-accounting',
  'scm-schedule-status-refresh-repository.red', 'stock-return-draft-insert'].map(name => `test/mbt/integration/${name}.test.js`)];
const evidence = { specApproval: 'not obtained (autonomous run)', red: { tests: 9, failed: 8, retainedRegression: 1 },
  versions: { node: process.version }, sourceHashes: {}, skipped: {
    repositoryWideSuite: 'Focused on all 14 related suites on the shared application host; unrelated suites not run.',
    supplyChainAudit: 'No dependency changes.', legacyTypes: 'Strict checking covers the changed domain; legacy services use syntax and integration checks.' } };

function run(name, args, { cwd = root, allowed = [0] } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 25e6, timeout: 300000 });
  assert.ifError(result.error);
  const text = result.stdout + result.stderr;
  writeFileSync(path.join(output, `${name}.log`), text);
  if (!allowed.includes(result.status)) { console.log(text.slice(-6000)); }
  assert.ok(allowed.includes(result.status), `${name} exited ${result.status}`);
  return { text, status: result.status };
}

function clone() {
  const directory = mkdtempSync(path.join(output, 'check-'));
  for (const name of ['src', 'test', 'tools', 'migrations']) { cpSync(name, path.join(directory, name), { recursive: true }); }
  for (const name of ['public', 'node_modules', 'contracts']) { symlinkSync(path.join(root, name), path.join(directory, name), 'dir'); }
  for (const name of ['package.json', 'eslint.mbt.config.js']) { cpSync(name, path.join(directory, name)); }
  mkdirSync(path.join(directory, 'data'));
  return directory;
}

function restoreBaseline(directory) {
  const patch = readFileSync('test/support/reconciliation-blockers-before.patch', 'utf8');
  for (const section of patch.split(/(?=^--- a\/)/m).filter(Boolean)) {
    const rows = section.trimEnd().split('\n');
    const file = path.join(directory, rows[0].slice(6));
    const current = readFileSync(file, 'utf8').split('\n');
    const restored = []; let cursor = 0;
    for (const row of rows.slice(2)) {
      if (row.startsWith('@@')) {
        const first = Number(row.match(/^@@ -(\d+)/)[1]) - 1;
        restored.push(...current.slice(cursor, first)); cursor = first;
      } else if (row.startsWith('+')) { restored.push(row.slice(1)); }
      else {
        assert.equal(current[cursor], row.slice(1), `${file}:${cursor + 1}`);
        if (row.startsWith(' ')) { restored.push(current[cursor]); }
        cursor++;
      }
    }
    restored.push(...current.slice(cursor)); writeFileSync(file, restored.join('\n'));
  }
}

function diagnostics(name, directory) {
  return JSON.parse(run(name, [path.join(root, 'node_modules/eslint/bin/eslint.js'), '--config',
    'tools/return-ra-eslint.config.mjs', '--format=json', ...source], { cwd: directory, allowed: [0, 1] }).text)
    .flatMap(file => file.messages.map(message => `${path.relative(directory, file.filePath)}:${message.ruleId}:${message.message.replace(/complexity of \d+/g, 'complexity above limit').replace(/line \d+ column \d+/g, 'line N column N')}`));
}

const baseline = clone();
try {
  restoreBaseline(baseline);
  const before = diagnostics('lint-before', baseline);
  const after = diagnostics('lint-final', root);
  const remaining = [...before];
  const added = after.filter(message => { const index = remaining.indexOf(message); if (index < 0) { return true; } remaining.splice(index, 1); return false; });
  assert.deepEqual(added, []);
  evidence.lint = { baseline: before.length, final: after.length, added: added.length };
} finally { rmSync(baseline, { recursive: true, force: true }); }
run('lint-tests', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--max-warnings=0', ...regression]);
run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--strict', '--noEmit', '--skipLibCheck',
  '--target', 'es2023', '--module', 'nodenext', 'src/return-batch-ra-domain.js']);
for (const file of source) { run(`syntax-${path.basename(file)}`, ['--check', file]); }
evidence.static = { strictDomainTypes: 'passed', syntaxFiles: source.length, regressionLint: 'passed' };
console.log('CHECK static passed');

const tested = run('suite', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  '--include=src/return-credit-memo.js', '--include=src/return-batch-ra-domain.js', '--include=src/return-batch-ra-service.js',
  '--include=src/return-repository.js', `--temp-directory=${output}/v8`, `--report-dir=${output}/coverage`,
  '--reporter=json', 'node', '--test', '--test-concurrency=1', ...tests]).text;
evidence.suite = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(tested.match(new RegExp(`# ${key} (\\d+)`))?.[1])]));
console.log(`CHECK suite ${JSON.stringify(evidence.suite)}`);

const coverage = JSON.parse(readFileSync(`${output}/coverage/coverage-final.json`, 'utf8'));
evidence.coverage = {};
for (const file of ['src/return-credit-memo.js', 'src/return-batch-ra-domain.js']) {
  const entry = coverage[path.join(root, file)];
  const counts = Object.values(entry.s);
  evidence.coverage[file] = { statements: counts.length, covered: counts.filter(count => count > 0).length };
}
evidence.changedLineCoverage = { files: {}, scheduler: 'Behavioral VM test and startup wiring contract; excluded from module coverage.' };
for (const section of readFileSync('test/support/reconciliation-blockers-before.patch', 'utf8').split(/(?=^--- a\/)/m).filter(Boolean)) {
  const rows = section.trimEnd().split('\n'); const file = rows[0].slice(6);
  if (file === 'src/server.js') { continue; }
  const entry = coverage[path.join(root, file)];
  assert.ok(entry, `No coverage for ${file}`);
  const changed = []; let line = 0;
  for (const row of rows.slice(2)) {
    if (row.startsWith('@@')) { line = Number(row.match(/^@@ -(\d+)/)[1]); }
    else if (row.startsWith('-')) { if (row.slice(1).trim()) { changed.push(line); } line++; }
    else if (row.startsWith(' ')) { line++; }
  }
  const uncovered = changed.filter(number => !Object.entries(entry.statementMap).some(([id, location]) =>
    location.start.line <= number && location.end.line >= number && entry.s[id] > 0));
  evidence.changedLineCoverage.files[file] = { lines: changed.length, uncovered };
  assert.deepEqual(uncovered, [], `${file} has unexecuted changed lines`);
}

const faults = [
  ['accept-unverified-fees', 'src/return-credit-memo.js', 'allowAccountingAdjustments === true && Array.isArray(rows)', 'Array.isArray(rows)', regression[0]],
  ['reject-valid-fees', 'src/return-credit-memo.js', 'allowAccountingAdjustments === true && Array.isArray(rows)', 'false && Array.isArray(rows)', regression[0]],
  ['ignore-material-change', 'src/return-credit-memo.js', 'if (expected.some(', 'if (false && expected.some(', regression[0]],
  ['retry-permanent-errors', 'src/return-repository.js', 'AND a.automatic_retry_blocked = false', '', regression[1]],
  ['retry-invalid-drafts', 'src/return-repository.js', 'AND automatic_retry_blocked = false', '', regression[1]],
  ['accept-unverified-history', 'src/return-batch-ra-service.js', '!manualTransactionId && hasVerifiedCreditMemo(batch)', 'true', regression[1]],
  ['compete-with-manual', 'src/server.js', 'if (await hasActiveScmReconciliationRun()) { return; }', '', regression[0]]
];
const mutant = clone();
evidence.mutation = [];
try {
  for (const [name, file, from, to, testFile] of faults) {
    const filename = path.join(mutant, file); const original = readFileSync(filename, 'utf8');
    assert.ok(original.includes(from), name);
    try {
      writeFileSync(filename, original.replace(from, to));
      const result = run(`mutant-${name}`, ['--test', testFile], { cwd: mutant, allowed: [1] });
      assert.match(result.text, /ERR_ASSERTION|ERR_TEST_FAILURE|RETURN_CM_VERIFICATION_FAILED/);
      evidence.mutation.push({ name, killed: true });
      if (['reject-valid-fees', 'ignore-material-change'].includes(name)) {
        run(`property-mutant-${name}`, ['--test', '--test-name-pattern=generated restocking', testFile], { cwd: mutant, allowed: [1] });
      }
    } finally { writeFileSync(filename, original); }
  }
} finally { rmSync(mutant, { recursive: true, force: true }); }
console.log(`CHECK mutation ${evidence.mutation.length}/${faults.length} killed`);

// Reverse file order in separate processes to exercise database cleanup boundaries.
let shuffledTests = 0;
for (const [index, file] of [...tests].reverse().entries()) {
  const result = run(`reordered-${index}`, ['--test', file]);
  shuffledTests += Number(result.text.match(/# tests (\d+)/)?.[1]);
}
evidence.reorderedSuite = { tests: shuffledTests, failed: 0 };
for (const file of [...source, ...regression, 'migrations/304_return_verification_retry_blocks.sql']) {
  const contents = readFileSync(file, 'utf8');
  evidence.sourceHashes[file] = createHash('sha256').update(contents).digest('hex');
  assert.deepEqual(scanTextForSecrets(contents, file), []);
}
for (const name of ['c8', 'typescript', 'eslint', 'fast-check']) {
  evidence.versions[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
}
evidence.completedAt = new Date().toISOString();
writeFileSync(`${output}/checks-summary.json`, JSON.stringify(evidence, null, 2));
console.log(`CHECK summary ${JSON.stringify(evidence)}`);
