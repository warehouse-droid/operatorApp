import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { inTaskScope } from './scopes.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out = 'test-artifacts/return-pallet-balance-sync-20261008';
const task = 'tools/return-pallet-balance-sync-20261008';
const files = JSON.parse(readFileSync(task + '/files.json'));
const tests = [
  'test/mbt/unit/return-credit-memo.test.js', 'test/mbt/integration/return-credit-memo.test.js',
  'test/mbt/unit/return-batch-ra-domain.test.js', 'test/mbt/integration/return-batch-ra.test.js',
  'test/mbt/unit/return-ra-workflow.test.js', 'test/mbt/integration/return-ra-workflow.test.js',
  'test/mbt/unit/return-ra-client.test.js', 'test/mbt/integration/return-failed-draft.test.js',
  'test/mbt/unit/return-rest-units.test.js', 'test/mbt/unit/return-stored-orderline.test.js',
  'test/mbt/integration/return-stored-orderline.test.js', 'test/mbt/integration/stock-return-draft-insert.test.js',
  'test/mbt/unit/operator-netsuite-posting-policy.red.test.js',
  'test/mbt/integration/operator-netsuite-posting-policy-repository.red.test.js',
  'test/mbt/unit/feature-gate-catalog.test.js', 'test/mbt/integration/feature-gate-admin-http.test.js',
  'test/mbt/integration/return-pallet-balance-sync.test.js'
];
mkdirSync(out, { recursive: true });
export function run(label, args, { accepted = [0], cwd = process.cwd(), env = {} } = {}) {
  const logPath = resolve(out, label + '.log');
  const fd = openSync(logPath, 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout: 180000 }); }
  finally { closeSync(fd); }
  const log = readFileSync(logPath, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, [...log.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)$`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0)]));
  console.log(JSON.stringify({ label, exit: result.status, ...counts }));
  assert.ok(accepted.includes(result.status), `${label}: ${log.slice(-6000)}`);
  return { exit: result.status, ...counts, log };
}

function staticChecks() {
  const baseline = resolve(out, 'baseline');
  for (const directory of ['node_modules', 'tools']) {
    const target = baseline + '/' + directory;
    if (!existsSync(target)) { symlinkSync(resolve(directory), target); }
  }
  const lintFiles = files.filter(file => file.endsWith('.js'));
  const lintArgs = [resolve('node_modules/eslint/bin/eslint.js'), '--config', resolve(task + '/eslint.config.mjs'), '--format=json'];
  const before = run('lint-baseline', [...lintArgs, ...lintFiles.filter(file => existsSync(baseline + '/' + file))], { cwd: baseline, accepted: [0, 1] });
  const after = run('lint-final', [...lintArgs, ...lintFiles], { accepted: [0, 1] });
  const messages = (log, root) => JSON.parse(log).flatMap(file => {
    const relative = file.filePath.replace(root + '/', '');
    return file.messages.filter(message => inTaskScope(relative, message.line, readFileSync(file.filePath, 'utf8')))
      .map(message => relative + ':' + message.ruleId + ':' + message.message
        .replace(/complexity of \d+/, 'complexity above limit').replace(/line \d+ column \d+/g, 'line N column N'));
  });
  const remaining = messages(before.log, baseline);
  const added = messages(after.log, process.cwd()).filter(message => {
    const index = remaining.indexOf(message);
    if (index < 0) { return true; }
    remaining.splice(index, 1); return false;
  });
  writeFileSync(out + '/lint-new.json', JSON.stringify(added, null, 2));
  assert.deepEqual(added, []);
  run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--strict', '--noEmit', '--skipLibCheck',
    '--target', 'es2023', '--module', 'nodenext', 'src/return-credit-memo.js', 'src/return-batch-ra-domain.js', 'src/operator-netsuite-posting-policy.js']);
  for (const file of lintFiles) { run('syntax-' + file.replaceAll('/', '-'), ['--check', file]); }
}

async function regressionChecks() {
  const { runNodeTestFilesIsolated } = await import('../../test/support/test-database-isolation.mjs');
  assert.equal(await runNodeTestFilesIsolated(tests.map(file => resolve(file)), { label: 'Return CM regression' }), 0);
}

const mode = process.argv[2];
if (mode === 'static') { staticChecks(); }
if (mode === 'regression') { await regressionChecks(); }
if (mode === 'coverage') {
  for (const directory of ['coverage', 'c8']) { rmSync(out + '/' + directory, { recursive: true, force: true }); }
  run('coverage-tests', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    ...files.filter(file => file.endsWith('.js')).map(file => '--include=' + file), '--reporter=json', '--reporter=json-summary',
    '--temp-directory=' + out + '/c8', '--report-dir=' + out + '/coverage', 'node', '--test', '--test-concurrency=1', ...tests.filter(file => !file.includes('feature-gate-'))]);
}
if (mode === 'versions') {
  const versions = Object.fromEntries(['c8', 'fast-check', 'typescript', 'eslint', '@playwright/test'].map(name =>
    [name, JSON.parse(readFileSync('node_modules/' + name + '/package.json')).version]));
  const sources = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  writeFileSync(out + '/source-state.json', JSON.stringify({ node: process.version, versions, sources,
    dependencyLock: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex') }, null, 2));
  console.log(JSON.stringify({ node: process.version, versions }));
}
