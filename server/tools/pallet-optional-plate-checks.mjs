import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const output = path.resolve('test-artifacts/pallet-optional-plate');
fs.mkdirSync(output, { recursive: true });
const tests = ['test/mbt/integration/return-pallet-optional-plate.test.js', 'test/mbt/unit/return-pallet-optional-plate-ui.test.js'];
const options = ['--test', '--test-force-exit', '--test-timeout=90000', '--test-concurrency=1'];
function run(name, args, cwd = root, fail = false) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 15e6 });
  const text = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(output, name + '.log'), text);
  assert.ifError(result.error);
  if (fail) { assert.notEqual(result.status, 0, `${name}: mutation survived`); }
  else { assert.equal(result.status, 0, text.match(/^not ok[^]*?^  \.\.\./gm)?.join('\n') || text.slice(-12000)); }
  const count = Number(text.match(/# tests (\d+)/)?.[1] || 0);
  console.log(`${name}: ${fail ? 'killed' : 'passed'}${count ? ` (${count} tests)` : ''}`);
  return count;
}
const regressions = ['unit', 'integration'].flatMap(group => fs.readdirSync(`test/mbt/${group}`)
  .filter(file => /^return-.*\.test\.js$/.test(file) && !file.startsWith('return-pallet-optional-plate'))
  .map(file => `test/mbt/${group}/${file}`));
const accepted = run('acceptance', [...options, ...tests]);
const regressionCount = run('return-regressions', [...options, ...regressions, 'test/mbt/integration/stock-return-draft-insert.test.js']);
for (const file of [...tests].reverse()) { run('order-' + path.basename(file), [...options, file]); }
for (const file of ['src/return-repository.js', 'src/return-batch-ra-domain.js', 'public/operator.js']) { run('syntax-' + path.basename(file), ['--check', file]); }
run('new-test-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/return-notification-eslint.config.mjs', '--max-warnings=0', ...tests]);
run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', '--include=src/return-repository.js', '--include=src/return-batch-ra-domain.js',
  `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`, '--reporter=json', 'node', ...options, tests[0]]);
const coverage = JSON.parse(fs.readFileSync(path.join(output, 'coverage/coverage-final.json'), 'utf8'));
const anchors = [
  ['src/return-repository.js', 'return cleanText(value, "Vehicle plate", 32, { required }).toUpperCase();'],
  ['src/return-repository.js', 'const vehiclePlate = cleanVehiclePlate(input.vehiclePlate, { required: hasStock });'],
  ['src/return-batch-ra-domain.js', 'first.vehiclePlate ? `plate ${first.vehiclePlate}` : ""']
];
for (const [file, anchor] of anchors) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const line = lines.findIndex(value => value.includes(anchor)) + 1;
  assert.ok(line > 0, anchor);
  const entry = Object.entries(coverage).find(([name]) => name.endsWith('/' + file))?.[1];
  assert.ok(entry, file);
  assert.ok(Object.entries(entry.statementMap).some(([key, span]) => span.start.line <= line && span.end.line >= line && entry.s[key] > 0), `${file}:${line} not executed`);
}
console.log('Changed backend statements executed; UI changes exercised by real render/validation functions.');
const mutations = [
  ['pallet-plate-required', 'src/return-repository.js', '{ required: hasStock }', '{ required: true }', tests[0]],
  ['stock-plate-optional', 'src/return-repository.js', '{ required: hasStock }', '{ required: false }', tests[0]],
  ['plate-not-normalized', 'src/return-repository.js', 'return cleanText(value, "Vehicle plate", 32, { required }).toUpperCase();', 'return cleanText(value, "Vehicle plate", 32, { required });', tests[0]],
  ['empty-memo-label', 'src/return-batch-ra-domain.js', 'first.vehiclePlate ? `plate ${first.vehiclePlate}` : ""', '`plate ${first.vehiclePlate}`', tests[0]],
  ['ui-plate-required', 'public/operator.js', 'requireVehiclePlate && selectedRows.length &&', 'requireVehiclePlate &&', tests[1]]
];
const mutant = path.join(output, 'mutant');
try {
  for (const folder of ['src', 'public', 'test/support']) { fs.cpSync(folder, path.join(mutant, folder), { recursive: true }); }
  for (const file of [...tests, 'package.json']) { fs.mkdirSync(path.dirname(path.join(mutant, file)), { recursive: true }); fs.copyFileSync(file, path.join(mutant, file)); }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(mutant, 'node_modules'), 'dir');
  for (const [name, file, oldText, newText, test] of mutations) {
    const destination = path.join(mutant, file); const text = fs.readFileSync(destination, 'utf8');
    assert.equal(text.split(oldText).length, 2, name);
    fs.writeFileSync(destination, text.replace(oldText, newText));
    try { run(name, [...options, test], mutant, true); }
    finally { fs.writeFileSync(destination, text); }
  }
} finally { fs.rmSync(mutant, { recursive: true, force: true }); }
const files = JSON.parse(fs.readFileSync('tools/pallet-optional-plate-files.json', 'utf8'));
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report = { passed: true, acceptance: accepted, regressions: regressionCount, mutantsKilled: mutations.length,
  changedBackendStatementsCovered: anchors.length, uiRenderAndValidation: true, sourceHashes };
fs.writeFileSync('test-artifacts/pallet-optional-plate-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
