import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
const mode = process.argv[2];
const out = 'test-artifacts/special-so-link-sqft-20261006';
mkdirSync(out, { recursive: true });
const browserTest = 'test/mbt/unit/special-manual-so-ui.browser.test.js';
const focused = ['test/mbt/integration/special-manual-so-link.test.js', 'test/mbt/unit/special-sqft-draft.test.js', browserTest];
const existing = ['unit', 'property', 'integration', 'adversarial'].flatMap(folder =>
  readdirSync('test/mbt/' + folder).filter(file => file.startsWith('special-') && file.endsWith('.test.js')
    && !focused.includes(`test/mbt/${folder}/${file}`)).map(file => `test/mbt/${folder}/${file}`));

function run(label, files) {
  let log = '', status = 0;
  for (const hostname of ['mbbs-special-review-db', 'mbbs-special-updates-db-20261002']) {
    const group = files.filter(file => (readFileSync(file, 'utf8').includes('mbbs-special-updates-db-20261002')
      ? 'mbbs-special-updates-db-20261002' : 'mbbs-special-review-db') === hostname);
    if (!group.length) continue;
    const url = new URL(process.env.DATABASE_URL); url.hostname = hostname;
    const covered = label === 'focused' && !['red', 'red-browser'].includes(mode);
    const args = ['--test', '--test-concurrency=1', ...group];
    const result = spawnSync(covered ? '/app/node_modules/.bin/c8' : process.execPath,
      covered ? ['--all=false', '--check-coverage=false', '--include=src/special-stock-request-repository.js',
        '--include=src/special-stock-pricing-domain.js', '--temp-directory=' + out + '/c8', '--report-dir=' + out + '/coverage',
        '--reporter=json', '--reporter=text', process.execPath, ...args] : args,
      { encoding: 'utf8', timeout: 500000, maxBuffer: 50000000, env: { ...process.env, DATABASE_URL: url.href } });
    log += (result.stdout || '') + (result.stderr || '');
    status = status || result.status;
  }
  writeFileSync(`${out}/${mode}-${label}.log`, log);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, [...log.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0)]));
  const failures = [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
  const summary = { mode, label, status, ...counts, failures };
  writeFileSync(`${out}/${mode}-${label}.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  assert.ok(counts.tests > 0, log.slice(-3000));
  return summary;
}

if (mode === 'red-browser') {
  const red = run('focused', [browserTest]);
  assert.equal(red.fail, 2, 'Both UI regressions must fail on the captured deployed source');
} else if (mode === 'baseline') {
  const baseline = existsSync(out + '/baseline-existing.json')
    ? JSON.parse(readFileSync(out + '/baseline-existing.json', 'utf8')) : run('existing', existing);
  console.log(JSON.stringify({ baselineRecorded: true, baselineFailures: baseline.failures }));
} else if (mode === 'red') {
  const red = run('focused', focused);
  assert.ok(red.fail > 0, 'The new regression tests must fail on the captured deployed source');
  const baseline = existsSync(out + '/baseline-existing.json')
    ? JSON.parse(readFileSync(out + '/baseline-existing.json', 'utf8')) : run('existing', existing);
  console.log(JSON.stringify({ baselineRecorded: true, baselineFailures: baseline.failures }));
} else {
  const result = run('focused', focused);
  assert.equal(result.fail, 0, 'Focused regressions failed; see persisted log');
  const after = run('existing', existing);
  const before = JSON.parse(readFileSync(`${out}/baseline-existing.json`, 'utf8'));
  assert.deepEqual(after.failures.filter(name => !before.failures.includes(name)), [], 'Existing suite gained failures');
  const staticCheck = spawnSync(process.execPath, ['tools/special-so-link-sqft-20261006/static.mjs'],
    { encoding: 'utf8', timeout: 240000, maxBuffer: 20000000 });
  writeFileSync(out + '/static-run.log', staticCheck.stdout + staticCheck.stderr);
  assert.equal(staticCheck.status, 0, 'Static/coverage checks failed; see static-run.log');
  const mutations = spawnSync(process.execPath, ['tools/special-so-link-sqft-20261006/mutations.mjs'],
    { encoding: 'utf8', timeout: 240000, maxBuffer: 20000000 });
  writeFileSync(out + '/mutation-run.log', mutations.stdout + mutations.stderr);
  assert.equal(mutations.status, 0, 'Mutation checks failed; see mutation-run.log');
  const health = run('focused-reversed', [...focused].reverse());
  assert.equal(health.fail, 0);
  const hashes = Object.fromEntries(['src/special-stock-request-repository.js', 'src/special-stock-pricing-domain.js',
    'public/sales-special-stock-requests.js'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  writeFileSync(out + '/verified-hashes.json', JSON.stringify(hashes, null, 2));
  writeFileSync(out + '/summary.json', JSON.stringify({ completed: true, focused: result, existing: after,
    baseline: before, newFailures: [], reversedFocused: health, static: JSON.parse(readFileSync(out + '/static.json', 'utf8')),
    mutations: JSON.parse(readFileSync(out + '/mutations.json', 'utf8')), sourceHashes: hashes }, null, 2));
}
