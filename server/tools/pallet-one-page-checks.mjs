import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const root = process.cwd(), output = path.resolve('test-artifacts/pallet-one-page');
fs.mkdirSync(output, { recursive: true });
function run(name, args, { cwd = root, failure = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 15e6 });
  const log = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(output, name + '.log'), log);
  assert.ifError(result.error);
  if (failure) { assert.notEqual(result.status, 0, name + ' survived'); assert.match(log, /not ok/); }
  else { assert.equal(result.status, 0, log.match(/^not ok[^]*?^  \.\.\./gm)?.join('\n') || log.slice(-10000)); }
  const tests = Number(log.match(/# pass (\d+)/)?.[1] || 0);
  console.log(`${name}: ${failure ? 'killed' : 'passed'} (${tests} passed tests)`);
  return tests;
}
const options = ['--test', '--test-force-exit', '--test-timeout=90000', '--test-concurrency=1'];
const integration = 'test/mbt/integration/return-pallet-one-page.test.js';
const browser = 'test/mbt/e2e/pallet-one-page.test.js';
const files = JSON.parse(fs.readFileSync('tools/pallet-one-page-files.json', 'utf8'));
for (const file of files.filter(name => name.endsWith('.js'))) { run('syntax-' + path.basename(file), ['--check', file]); }
run('new-tests-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/pallet-one-page-eslint.config.mjs', '--max-warnings=0', integration, browser, 'test/mbt/unit/return-pallet-yard-reference.test.js', 'tools/pallet-one-page-checks.mjs']);
if (process.argv.includes('--static-only')) { process.exit(0); }
const accepted = run('acceptance', [...options, integration, browser]);
const regressions = ['unit', 'integration'].flatMap(group => fs.readdirSync(`test/mbt/${group}`)
  .filter(file => /^return-.*\.test\.js$/.test(file) && file !== 'return-pallet-one-page.test.js')
  .map(file => `test/mbt/${group}/${file}`));
const regressionCount = run('return-regressions', [...options, ...regressions, 'test/mbt/integration/stock-return-draft-insert.test.js']);
const mutations = [
  ['search-rerenders-input', 'public/operator.js', '      refreshReturnCustomerResults();\n      try {', '      render();\n      try {', browser, 'search preserves'],
  ['photos-required-again', 'src/return-repository.js', '  await verifyReturnPhotos([', '  if (hasPallet && !palletPhotos.length) throw new Error("PALLET photo required");\n  await verifyReturnPhotos([', integration, 'pallet submission accepts'],
  ['local-phone-country-code', 'src/return-customer-directory.js', '.replace(/^1(?=\\d{10}$)/, "")', '', integration, 'customer phone search'],
  ['two-columns', 'public/operator.css', 'grid-template-columns: repeat(3, minmax(0, 1fr));\n  grid-template-rows: minmax(0, 1fr) auto;', 'grid-template-columns: repeat(2, minmax(0, 1fr));\n  grid-template-rows: minmax(0, 1fr) auto;', browser, 'fits 1366']
];
const mutant = path.join(output, 'mutant');
try {
  for (const folder of ['src', 'public', 'test/support']) { fs.cpSync(folder, path.join(mutant, folder), { recursive: true }); }
  for (const file of [integration, browser, 'package.json']) { fs.mkdirSync(path.dirname(path.join(mutant, file)), { recursive: true }); fs.copyFileSync(file, path.join(mutant, file)); }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(mutant, 'node_modules'), 'dir');
  for (const [name, file, before, after, suite, pattern] of mutations) {
    const target = path.join(mutant, file), original = fs.readFileSync(target, 'utf8');
    assert.equal(original.split(before).length, 2, name);
    try { fs.writeFileSync(target, original.replace(before, after)); run(name, [...options, `--test-name-pattern=${pattern}`, suite], { cwd: mutant, failure: true }); }
    finally { fs.writeFileSync(target, original); }
  }
} finally { fs.rmSync(mutant, { recursive: true, force: true }); }
const report = { passed: true, acceptance: accepted, regressions: regressionCount, mutantsKilled: mutations.length,
  sourceHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])) };
fs.writeFileSync('test-artifacts/pallet-one-page-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
