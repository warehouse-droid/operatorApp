import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const out = 'test-artifacts/som06964-release-20261015';
const frontend = 'public/dispatch.js', policy = 'src/dispatch-fulfilled-so-policy.js', preview = 'src/scm-dependency-preview-service.js';
const feTest = 'test/dispatch/frontend/dispatch-status-independence.test.js', beTest = 'test/dispatch/integration/dispatch-status-independence.test.js';
const mutants = [
  ['external-ui-lock', frontend, 'return order.dispatchPlanningRestricted === true || (order.dispatchCompletionStatus',
    'return order.operatorStatus === "loaded" || order.dispatchPlanningRestricted === true || (order.dispatchCompletionStatus', feTest],
  ['ignore-ui-delivery', frontend, 'order.dispatchCompletionStatus === "completed"\n    && order.dispatchFulfilledSalesPlanningEligible',
    'false\n    && order.dispatchFulfilledSalesPlanningEligible', feTest],
  ['retain-accounting-completion', policy, 'if (!state) return {};', 'if (!state || !state.locallyCompleted) return {};', beTest],
  ['clear-real-delivery', policy, 'if (state.locallyCompleted) return', 'if (false) return', beTest],
  ['restore-operator-block', preview, '    receivingActivity: receivingRefs.length', '    operatorActivity: { refs: memberRefs },\n    receivingActivity: receivingRefs.length', beTest],
  ['ignore-driver-activity', preview, 'driverActivity: jobIds.length ? { jobIds } : null,', 'driverActivity: null,', beTest]
];
const results = [];
for (const [name, file, before, after, testFile] of mutants) {
  const root = mkdtempSync('/tmp/dispatch-status-mutant-');
  try {
    for (const folder of ['src', 'public']) cpSync(folder, root + '/' + folder, { recursive: true });
    for (const path of ['package.json', feTest, beTest, 'test/support/sales-order-cargo-fixture.mjs', 'test/dispatch/support/fulfilled-so-fixture.js']) {
      mkdirSync(dirname(root + '/' + path), { recursive: true }); cpSync(path, root + '/' + path);
    }
    for (const folder of ['node_modules', 'migrations']) symlinkSync(resolve(folder), root + '/' + folder);
    const source = readFileSync(root + '/' + file, 'utf8');
    assert.equal(source.split(before).length, 2, name);
    writeFileSync(root + '/' + file, source.replace(before, after));
    const run = (test, pattern) => spawnSync(process.execPath, ['--test', ...(pattern ? ['--test-name-pattern=' + pattern] : []), test],
      { cwd: root, env: process.env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const main = run(testFile), log = main.stdout + main.stderr;
    writeFileSync(`${out}/mutant-${name}.log`, log);
    const killed = main.status === 1 && /ERR_ASSERTION|ERR_TEST_FAILURE/u.test(log) && !/ERR_MODULE_NOT_FOUND|SyntaxError/u.test(log);
    const property = run(feTest, '^property:'), propertyLog = property.stdout + property.stderr;
    writeFileSync(`${out}/mutant-${name}-property.log`, propertyLog);
    results.push({ name, killed, exit: main.status, propertyKilled: property.status === 1 && /Property failed/u.test(propertyLog) });
    writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2) + '\n');
    assert.equal(killed, true, name + ' survived: ' + log.slice(-1600));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify(results));
