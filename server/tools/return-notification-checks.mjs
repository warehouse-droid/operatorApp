import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const root = process.cwd();
const output = path.resolve('test-artifacts/return-notification');
fs.mkdirSync(output, { recursive: true });
const modules = fs.readdirSync('src').filter(name => name.startsWith('return-notification-')).map(name => `src/${name}`);
const tests = ['test/mbt/unit/return-notification.test.js', 'test/mbt/unit/return-notification-ui.test.js', 'test/mbt/integration/return-notification.test.js'];
const nodeTests = ['--test', '--test-force-exit', '--test-timeout=90000', '--test-concurrency=1'];
const changed = [...modules, 'src/server.js', 'public/operator.js', 'public/operator.html', 'public/operator.css',
  'public/control.js', 'public/admin.html', 'public/return-notifications.js', 'migrations/311_return_customer_notifications.sql'];
function run(name, args, cwd = root, expectFailure = false) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 20e6 });
  const text = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(output, `${name}.log`), text);
  assert.ifError(result.error);
  if (expectFailure) { assert.notEqual(result.status, 0, `${name}: mutant survived`); }
  else {
    const failures = text.match(/^not ok[^]*?^  \.\.\./gm);
    assert.equal(result.status, 0, `${name} failed:\n${failures ? failures.join('\n') : text.slice(-12000)}`);
  }
  console.log(`${name}: ${expectFailure ? 'killed' : 'passed'} ${text.match(/# tests \d+/)?.[0] || ''}`);
  return text;
}

const hashes = Object.fromEntries(changed.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
run('acceptance', [...nodeTests, ...tests]);
for (const [index, file] of tests.toReversed().entries()) { run(`acceptance-order-${index}`, [...nodeTests, file]); }
const regressions = ['unit', 'integration'].flatMap(group => fs.readdirSync(`test/mbt/${group}`)
  .filter(name => /^return-.*\.test\.js$/.test(name) && !name.startsWith('return-notification'))
  .map(name => `test/mbt/${group}/${name}`));
run('return-regressions', [...nodeTests, ...regressions, 'test/mbt/integration/stock-return-draft-insert.test.js']);
// This old source harness predates the existing selected-editor CSS layout.
// Compare its failure with this feature's CSS removed, without changing its assertions.
const harnessBaseline = path.join(output, 'harness-baseline');
try {
  for (const file of ['src/operator-return-ui-harness.js', 'src/photo-upload.js', 'public/operator.js',
    'public/operator.css', 'public/operator.html', 'public/i18n.js', 'public/service-worker.js']) {
    fs.mkdirSync(path.dirname(path.join(harnessBaseline, file)), { recursive: true });
    fs.copyFileSync(file, path.join(harnessBaseline, file));
  }
  fs.copyFileSync('package.json', path.join(harnessBaseline, 'package.json'));
  const css = path.join(harnessBaseline, 'public/operator.css');
  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').split('/* Customer confirmation after NetSuite return posting. */')[0]);
  const results = [harnessBaseline, root].map(cwd => spawnSync(process.execPath, ['src/operator-return-ui-harness.js'], { cwd, encoding: 'utf8', maxBuffer: 2e6 }));
  const signatures = results.map(value => `${value.status}:${value.stderr.match(/expected: (.+),/m)?.[1]}`);
  assert.equal(signatures[0], signatures[1], 'No new legacy UI harness failure');
  assert.ok(signatures[0].includes('return-selected-editor'), 'Review any changed baseline assertion');
  console.log(`operator-return-harness: pre-existing CSS assertion in baseline and candidate: ${signatures[0]}`);
} finally { fs.rmSync(harnessBaseline, { recursive: true, force: true }); }
run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/return-notification-eslint.config.mjs', '--max-warnings=0',
  ...modules, ...tests, 'public/return-notifications.js', 'tools/return-notification-checks.mjs']);
run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--strict', 'false', '--types', 'node', '--noEmit', '--skipLibCheck', '--target', 'es2023', '--module', 'nodenext',
  'src/return-notification-domain.js', 'src/return-notification-settings.js', 'src/return-notification-transport.js']);
for (const file of ['src/server.js', 'public/operator.js', 'public/control.js', 'public/return-notifications.js']) { run(`syntax-${path.basename(file)}`, ['--check', file]); }
const findings = [...modules, ...tests, 'public/return-notifications.js'].flatMap(file => scanTextForSecrets(fs.readFileSync(file, 'utf8'), file));
assert.deepEqual(findings, []);
console.log('secret scan: passed; no dependencies added');
run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--include=src/return-notification-*.js',
  '--include=public/return-notifications.js', `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`,
  '--reporter=text', '--reporter=json-summary', 'node', ...nodeTests, ...tests]);

const mutants = [
  ['unposted', 'src/return-notification-domain.js', "!['succeeded', 'manual_linked'].includes(record.netSuiteSyncStatus)", 'false', tests[0]],
  ['wrong-reference', 'src/return-notification-domain.js', 'value.reference}`).join', "'WRONG'}`).join", tests[0]],
  ['credential-leak', 'src/return-notification-settings.js', 'publicSettings(saved);', '({ ...publicSettings(saved), apiKey: input.apiKey });', tests[0]],
  ['duplicate-send', 'src/return-notification-service.js', "existing.status !== 'failed'", "existing.status === 'failed'", tests[2]],
  ['unknown-resend', 'src/return-notification-service.js', "SET status='uncertain',updated_at=now()", "SET status='failed',updated_at=now()", tests[2]],
  ['audit-key-leak', 'src/server.js', '|api[_ -]?key|credential', '|credential', tests[1]],
  ['ui-missing-input', 'public/return-notifications.js', '<input type="text"', '<textarea type="text"', tests[1]]
];
const mutantDirectory = path.join(output, 'mutant');
try {
  fs.mkdirSync(mutantDirectory, { recursive: true });
  for (const directory of ['src', 'public', 'test/mbt/unit', 'test/mbt/integration']) {
    fs.cpSync(directory, path.join(mutantDirectory, directory), { recursive: true });
  }
  fs.copyFileSync('package.json', path.join(mutantDirectory, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(mutantDirectory, 'node_modules'), 'dir');
  for (const [name, file, original, replacement, targetTest] of mutants) {
    const destination = path.join(mutantDirectory, file);
    const source = fs.readFileSync(destination, 'utf8');
    assert.ok(source.includes(original), `mutation anchor missing: ${name}`);
    fs.writeFileSync(destination, source.replace(original, replacement));
    try { run(`mutation-${name}`, [...nodeTests, targetTest], mutantDirectory, true); }
    finally { fs.writeFileSync(destination, source); }
  }
} finally { fs.rmSync(mutantDirectory, { recursive: true, force: true }); }
const coverage = JSON.parse(fs.readFileSync(path.join(output, 'coverage/coverage-summary.json'), 'utf8'));
if (process.env.PLAYWRIGHT_BROWSERS_PATH) { run('browser', ['tools/return-notification-browser.mjs']); }
const report = { passed: true, node: process.version, acceptanceFiles: tests.length, regressionFiles: regressions.length + 1,
  mutantsKilled: mutants.length, coverage: coverage.total, sourceHashes: hashes };
fs.writeFileSync('test-artifacts/return-notification-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
