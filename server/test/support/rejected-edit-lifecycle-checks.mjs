import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const target = path.resolve('public/dispatch.js');
const testFile = 'test/dispatch/frontend/dispatch-rejected-edit-lifecycle.test.js';
const source = await readFile(target, 'utf8');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'rejected-edit-checks-'));
const mutations = [
  ['assignment rollback retires splits', text => text.replace(
    'if (assignmentConflict) {\n    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked), { reconcileLifecycle: false });',
    'if (assignmentConflict) {\n    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked));')],
  ['dependency rollback retires splits', text => text.replace(
    'if (dependencySequenceWarning) {\n    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked), { reconcileLifecycle: false });',
    'if (dependencySequenceWarning) {\n    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked));')],
  ['stop override rollback retires splits', text => text.replace(
    'if (overrideConflict) {\n    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked), { reconcileLifecycle: false });',
    'if (overrideConflict) {\n    if (rollbackPacked) applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked));')],
  ['disable deliberate undo transitions', text => text.replace(
    'function applyHistorySnapshot(snapshot, { reconcileLifecycle = true } = {})',
    'function applyHistorySnapshot(snapshot, { reconcileLifecycle = false } = {})')],
  ['ignore rollback lifecycle flag', text => text.replace(
    'if (reconcileLifecycle) reconcileGlobalOrderLifecycleTransition(orders, snapshot.orders || []);',
    'reconcileGlobalOrderLifecycleTransition(orders, snapshot.orders || []);')]
];

const mode = process.argv[2] || 'mutations';
if (mode === 'mutations') {
  const results = [];
  for (const [name, mutate] of mutations) {
    const changed = mutate(source);
    assert.notEqual(changed, source, `Mutation missed: ${name}`);
    const filename = path.join(temporary, 'dispatch.js');
    await writeFile(filename, changed);
    const runs = {};
    for (const [scope, flags] of [['all', []], ['properties', ['--test-name-pattern=PROPERTY:']]]) {
      const result = spawnSync(process.execPath, ['--test', ...flags, testFile], {
        env: { ...process.env, DISPATCH_REJECTION_SOURCE: filename }, encoding: 'utf8', timeout: 120000
      });
      assert.ok(result.status !== null && result.status !== 0, `Surviving mutant ${name} (${scope})`);
      assert.match(result.stdout, /AssertionError|Property failed|ERR_ASSERTION/u, 'Mutation must fail on a behavioral assertion');
      runs[scope] = { killed: true, exitCode: result.status };
    }
    results.push({ name, ...runs });
  }
  console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(source).digest('hex'), results }));
} else if (mode === 'coverage') {
  const directory = path.join(temporary, 'coverage');
  const result = spawnSync('node_modules/.bin/c8', [
    '--all=false', '--check-coverage=false', '--include=public/dispatch.js', '--reporter=json', `--report-dir=${directory}`,
    '--temp-directory=' + path.join(temporary, 'raw'), process.execPath, '--test', testFile
  ], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reports = JSON.parse(await readFile(path.join(directory, 'coverage-final.json'), 'utf8'));
  const report = reports[target];
  assert.ok(report, 'Actual browser implementation was not covered');
  const changedLines = source.split('\n').flatMap((line, index) =>
    line.includes('function applyHistorySnapshot(snapshot, { reconcileLifecycle')
    || line.includes('if (reconcileLifecycle) reconcileGlobalOrderLifecycleTransition')
    || line.includes('applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked), { reconcileLifecycle: false })') ? [index + 1] : []);
  assert.equal(changedLines.length, 5);
  const covered = changedLines.filter(line => Object.entries(report.statementMap).some(([key, range]) =>
    range.start.line <= line && range.end.line >= line && report.s[key] > 0));
  assert.deepEqual(covered, changedLines, 'Changed executable lines were missed');
  const changedBranches = Object.entries(report.branchMap).filter(([, branch]) =>
    changedLines.includes(branch.loc.start.line));
  assert.ok(changedBranches.length > 0, 'Changed branch coverage was not recorded');
  for (const [key, branch] of changedBranches) {
    assert.ok(report.b[key].every(count => count > 0), `Untested changed branch at line ${branch.loc.start.line}`);
  }
  console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(source).digest('hex'), changedLines, covered,
    count: covered.length, changedBranches: changedBranches.map(([key, branch]) => ({ line: branch.loc.start.line, counts: report.b[key] })) }));
} else {
  throw new Error('Expected mutations or coverage');
}
