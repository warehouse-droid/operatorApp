import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.ok(process.env.DATABASE_URL.includes('mbbs-special-review-db'));
const out = 'test-artifacts/dispatch-contention'; mkdirSync(out, { recursive: true });
const runtime = ['public/dispatch.js', 'public/dispatch.html', 'migrations/234_dispatch_identity_lookup_indexes.sql'];
const run = (name, program, args, options = {}) => {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  writeFileSync(`${out}/${name}.txt`, result.stdout + result.stderr);
  return result;
};
const testFiles = [
  'test/dispatch/integration/dispatch-identity-indexes.test.js',
  'test/dispatch/integration/dispatch-fulfilled-so-planning.test.js',
  'test/dispatch/concurrency/dispatch-fulfilled-so-planning.test.js',
  'test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js',
  'test/dispatch/integration/order-update-lifecycle.test.js',
  'test/dispatch/integration/scm-pob03658-split-driver-lifecycle.red.test.js',
  'test/dispatch/unit/dispatch-history-mode.test.js',
  'test/dispatch/unit/dispatch-fulfilled-so-policy.test.js',
  'test/mbt/integration/special-workflow-queue-access.test.js',
  'test/dispatch/frontend/dispatch-reviewed-notice.test.js',
  'test/dispatch/frontend/dispatch-reviewed-notice-dismiss.browser.test.mjs',
  'test/dispatch/frontend/dispatch-executed-order-review.browser.test.mjs'
];
const result = process.argv.includes('--finish') ? { stdout: readFileSync(`${out}/final-tests.txt`, 'utf8') }
  : run('final-tests', 'node_modules/.bin/c8', ['--all=false', '--check-coverage=false',
  '--include=public/dispatch.js', `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`,
  '--reporter=json', process.execPath, '--test', '--test-concurrency=1', ...testFiles], {
  env: { ...process.env, DISPATCH_REVIEW_COVERAGE: `${out}/browser-coverage.json` }
});
const baselineFailure = 'POB03658: a matched parent update plus a new Driver-completed split stays out of Reconcile Review';
assert.match(readFileSync(`${out}/preexisting-po-test.txt`, 'utf8'), /DISPATCH_ACTIVE_LOAD_LOCKED/);
const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
assert.ok(failures.length <= 1 && failures.every(name => name === baselineFailure), JSON.stringify(failures));
assert.equal(Number(result.stdout.match(/^# skipped (\d+)$/m)?.[1]), 0);
const source = readFileSync('public/dispatch.js', 'utf8');
const mutations = [
  ['acknowledged-only', text => text.replace('review => review.acknowledged\n', 'review => !review.acknowledged\n')],
  ['dismissed-filter', text => text.replace('!dismissedExecutedOrderReviews.has', 'dismissedExecutedOrderReviews.has')],
  ['plan-scope', text => text.replaceAll('${executedOrderReviewPlanId}:${review.token}', '${review.token}')]
];
const mutationResults = [];
for (const [name, mutate] of mutations) {
  const changed = mutate(source); assert.notEqual(changed, source);
  const file = `/tmp/dispatch-reviewed-notice-${name}.js`; writeFileSync(file, changed);
  const test = run(`mutation-${name}`, process.execPath, ['--test', '--test-name-pattern=property:',
    'test/dispatch/frontend/dispatch-reviewed-notice.test.js'], { env: { ...process.env, DISPATCH_REVIEW_SOURCE: file } });
  assert.notEqual(test.status, 0); assert.match(test.stdout, /Property failed/);
  mutationResults.push({ name, killedByProperty: true });
}
writeFileSync(`${out}/mutations.json`, JSON.stringify(mutationResults, null, 2));
const map = coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
for (const entry of JSON.parse(readFileSync(`${out}/browser-coverage.json`))) {
  assert.equal(entry.source, source);
  const converter = v8ToIstanbul(resolve('public/dispatch.js'), 0, { source });
  await converter.load(); converter.applyCoverage(entry.functions); map.merge(converter.toIstanbul());
}
const diff = spawnSync('diff', ['-U0', `${out}/baseline/public/dispatch.js`, 'public/dispatch.js'], { encoding: 'utf8' }).stdout;
writeFileSync(`${out}/dispatch.diff`, diff);
const lines = map.fileCoverageFor(resolve('public/dispatch.js')).getLineCoverage();
const counts = { total: 0, covered: 0, uncovered: [] };
for (const match of diff.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)) {
  for (let n = Number(match[1]); n < Number(match[1]) + Number(match[2] ?? 1); n++) {
    if (!Object.hasOwn(lines, n)) continue;
    counts.total++; if (lines[n]) counts.covered++; else counts.uncovered.push(n);
  }
}
writeFileSync(`${out}/changed-lines.json`, JSON.stringify(counts, null, 2));
assert.deepEqual(counts.uncovered, []);
assert.equal(run('syntax', process.execPath, ['--check', 'public/dispatch.js']).status, 0);
const lintArgs = ['--config', 'tools/dispatch-fulfilled-so-eslint.config.mjs', '--format', 'json', '--stdin', '--stdin-filename', 'public/dispatch.js'];
const beforeLint = run('lint-baseline', 'node_modules/.bin/eslint', lintArgs, { input: readFileSync(`${out}/baseline/public/dispatch.js`, 'utf8') });
const afterLint = run('lint-current', 'node_modules/.bin/eslint', lintArgs, { input: source });
const lintFindings = output => JSON.parse(output)[0].messages.map(({ ruleId, message, nodeType }) => ({ ruleId, message, nodeType }));
assert.deepEqual(lintFindings(afterLint.stdout), lintFindings(beforeLint.stdout));
const hashes = Object.fromEntries(runtime.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/runtime-files.json`, JSON.stringify(runtime));
writeFileSync(`${out}/source-manifest.json`, JSON.stringify(hashes, null, 2));
const summary = { completed: true, tests: Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]),
  passed: Number(result.stdout.match(/^# pass (\d+)$/m)?.[1]), knownBaselineFailures: failures,
  changedLines: counts, mutations: mutationResults, newLintFindings: 0 };
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
