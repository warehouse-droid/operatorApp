// Prove that the full-day comparison rejects a stale observer. All mutations
// are confined to a throwaway copy inside the bounded disposable container.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const root = mkdtempSync('/tmp/dispatch-consistency-mutant-');
try {
  for (const directory of ['src', 'public', 'test']) cpSync(directory, `${root}/${directory}`, { recursive: true });
  cpSync('package.json', `${root}/package.json`);
  symlinkSync('/app/node_modules', `${root}/node_modules`);
  const file = `${root}/public/dispatch.js`;
  const original = readFileSync(file, 'utf8');
  const anchor = '|| (discoverPlan && !currentPlan?.id)';
  assert.equal(original.split(anchor).length, 2, 'unique stale-observer mutation');
  writeFileSync(file, original.replace(anchor, '|| false'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This wrapper can itself run in an isolated node --test process.
  const result = spawnSync('node', ['--test', 'test/dispatch/frontend/dispatch-full-day.browser.test.mjs'], {
    cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024
  });
  const output = 'test-artifacts/backend-frontend-negative-control';
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/replay.log`, result.stdout + result.stderr);
  assert.equal(result.status, 1, 'the intentionally stale observer must fail the replay');
  const report = JSON.parse(readFileSync(`${root}/test-artifacts/full-day-replay/latest.json`, 'utf8'));
  const failure = report.consistencyChecks.find(row => row.status === 'failed');
  assert.equal(failure?.name, 'Save plan: stored content and both boards agree');
  assert.ok(failure.editorConsistentByMs > 0, 'the editor did adopt the committed plan');
  assert.equal(failure.observerConsistentByMs, undefined, 'the observer never adopted it');
  assert.notEqual(failure.expected.plan.id, 'undefined');
  assert.equal(failure.actual[1].plan.id, 'undefined');
  assert.deepEqual(report.refreshAudit.manualRefreshClicks, []);
  cpSync(`${root}/${report.artifact}`, `${output}/evidence`, { recursive: true });
  const evidence = { mutation: 'disable discovery of a newly created plan in an already-open observer',
    killed: true, failedCheck: failure.name, backendPlan: failure.expected.plan,
    staleObserver: failure.actual[1].plan, runtimeCopyRemovedInFinally: true,
    test: 'test/dispatch/frontend/dispatch-full-day.browser.test.mjs' };
  writeFileSync(`${output}/result.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  rmSync(root, { recursive: true, force: true });
}
