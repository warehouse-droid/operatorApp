import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const mode = process.argv[2];
const out = '/app/test-artifacts/scm-schedule-search-yards-20261014';
await mkdir(out, { recursive: true });
const results = {};
function run(name, args, { required = true, timeout = 900000 } = {}) {
  const result = spawnSync(process.execPath, args, { cwd: '/app', encoding: 'utf8',
    timeout, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GOMAXPROCS: '2', GOMEMLIMIT: '512MiB', GOGC: '40' } });
  const output = (result.stdout || '') + (result.stderr || '');
  results[name] = { exit: result.status, signal: result.signal };
  for (const [, label, value] of output.matchAll(/^(?:#|ℹ) (tests|pass|fail) (\d+)$/gmu)) {
    results[name][label] = (results[name][label] || 0) + Number(value);
  }
  process.stdout.write(output);
  return writeFile(`${out}/${mode}-${name}.log`, output).then(() => {
    if (required) assert.equal(result.status, 0, name);
    return result.status;
  });
}
const target = ['test/dispatch/frontend/scm-schedule-search.test.js',
  'test/mbt/integration/scm-schedule-search.test.js', 'test/mbt/unit/scm-schedule-search-policy.test.js'];
const regressions = ['test/dispatch/frontend/scm-schedule-multi-sort.test.js',
  'test/dispatch/frontend/scm-schedule-column-preferences.test.js',
  'test/dispatch/frontend/scm-schedule-status-save.test.js',
  'test/dispatch/frontend/scm-schedule-remarks-ui.red.test.js',
  'src/scm-schedule-column-filter-harness.js', 'src/scm-schedule-column-filter-integration-harness.js',
  'src/scm-order-visibility-harness.js', 'src/scm-order-visibility-integration-harness.js',
  'test/dispatch/integration/scm-direct-ship-schedule.test.js',
  'test/mbt/integration/scm-cancelled-split-schedule.test.js', 'src/sales-portal-harness.js'];
if (mode === 'red') {
  const exit = await run('red', ['--test', '--test-concurrency=1', ...target], { required: false });
  assert.notEqual(exit, 0, 'New behavior must fail against the original application');
  await run('types', ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.mbt.json', '--noEmit'], { required: false, timeout: 180000 });
  await writeFile(`${out}/baseline-types.log`, await readFile(`${out}/red-types.log`));
  await run('regressions', ['--test', '--test-concurrency=1', ...regressions], { required: false });
  await writeFile(`${out}/baseline-regressions.log`, await readFile(`${out}/red-regressions.log`));
} else if (mode === 'baseline') {
  await run('regressions', ['--test', '--test-concurrency=1', ...regressions], { required: false });
  await run('types', ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.mbt.json', '--noEmit'], { required: false });
  await run('default-suite', ['test/support/run-node-tests.mjs', 'infrastructure', 'unit', 'contracts', 'property', 'integration', 'adversarial', 'concurrency'], { required: false });
} else {
  if (mode === 'all') {
    await run('static', ['tools/scm-schedule-search-yards-20261014/static.mjs']);
    await run('tests', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
      '--include=src/scm-order-visibility.js', '--include=src/server.js',
      '--include=src/dispatch-repository.js', '--include=public/scm-schedule.js',
      '--temp-directory=/tmp/scm-schedule-search-c8', `--report-dir=${out}/coverage`,
      '--reporter=json', '--reporter=json-summary', '--reporter=text', process.execPath,
      '--test', '--test-concurrency=1', ...target]);
    await run('mutations', ['tools/scm-schedule-search-yards-20261014/mutations.mjs']);
    await run('order-check', ['--test', '--test-concurrency=1', ...[...target].reverse()]);
  } else {
    await run('tests', ['--test', '--test-concurrency=1', ...target]);
  }
  await run('regressions', ['--test', '--test-concurrency=1', ...regressions], { required: false });
  if (mode === 'all') {
    const failureNames = (log) => [...log.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1]);
    const prior = failureNames(await readFile(`${out}/baseline-regressions.log`, 'utf8'));
    const newFailures = failureNames(await readFile(`${out}/all-regressions.log`, 'utf8')).filter((name) => !prior.includes(name));
    assert.deepEqual(newFailures, [], 'No new schedule regression failures');
    results.defaultComparison = { status: 'unverified',
      reason: 'The unmodified default-suite baseline exceeded 900 seconds while aggregate-request-browser.test.js was stuck; all affected schedule regression files were run instead.' };
  }
}
await writeFile(`${out}/checks-${mode}.json`, JSON.stringify({ mode, results, node: process.version }, null, 2) + '\n');
