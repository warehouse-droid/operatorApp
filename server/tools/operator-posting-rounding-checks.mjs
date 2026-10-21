import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const mode = process.argv[2];
assert.ok(['baseline', 'final', 'shuffled'].includes(mode));
const artifact = 'test-artifacts/operator-posting-rounding';
await mkdir(artifact, { recursive: true });
const manifest = JSON.parse(await readFile(`${artifact}/manifest.json`, 'utf8'));
const names = Object.keys(manifest.changes);
if (mode === 'final') {
  await rm(`${artifact}/gauntlet.json`, { force: true });
  await rm(`${artifact}/coverage`, { recursive: true, force: true });
  await mkdir(`${artifact}/coverage/tmp`, { recursive: true });
}
async function run(name, args, allowFailure = false) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || '');
  await writeFile(`${artifact}/${name}.log`, log);
  console.log(JSON.stringify({ check: name, exitCode: result.status }));
  if (!allowFailure) { assert.equal(result.status, 0, `Check failed: ${name}; see saved log`); }
  return { exitCode: result.status, log };
}
function diagnostics(log) {
  return log.split('\n').filter(line => /error TS\d+/u.test(line))
    .map(line => line.replace(/\(\d+,\d+\)/u, ''));
}
function additionalDiagnostics(baseline, current) {
  const counts = new Map();
  for (const message of baseline) { counts.set(message, (counts.get(message) || 0) + 1); }
  return current.filter(message => {
    const count = counts.get(message) || 0;
    if (count) { counts.set(message, count - 1); return false; }
    return true;
  });
}
function lintDiagnostics(log) {
  return JSON.parse(log).flatMap(file => file.messages.map(message =>
    `${file.filePath.split('/app/').at(-1)}:${message.ruleId}:${message.message}`));
}
async function staticChecks() {
  const existing = [];
  for (const name of names) {
    try { await access(name); existing.push(name); }
    catch { /* New source is absent from the original baseline. */ }
  }
  for (const name of existing) { await run(`${mode}-syntax-${name.split('/').at(-1)}`, ['--check', name]); }
  const types = await run(`${mode}-types`, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.mbt.json', '--noEmit'], true);
  const lintNames = existing.filter(name => name.includes('operator-netsuite-posting-') || name.includes('operator-po-receipt-'));
  const lint = await run(`${mode}-lint`, ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--format', 'json', '--no-warn-ignored', ...lintNames], true);
  const report = { types: diagnostics(types.log), lint: lintDiagnostics(lint.log), typesExit: types.exitCode, lintExit: lint.exitCode };
  await writeFile(`${artifact}/${mode}-static.json`, JSON.stringify(report, null, 2) + '\n');
  if (mode === 'final') {
    const baseline = JSON.parse(await readFile(`${artifact}/baseline-static.json`, 'utf8'));
    const newTypes = additionalDiagnostics(baseline.types, report.types);
    await writeFile(`${artifact}/type-comparison.json`, JSON.stringify({ baseline: baseline.types.length, final: report.types.length, newTypes }, null, 2) + '\n');
    assert.deepEqual(newTypes, [], 'New compiler diagnostics');
    const newLint = additionalDiagnostics(baseline.lint, report.lint);
    await writeFile(`${artifact}/lint-comparison.json`, JSON.stringify({ baseline: baseline.lint, final: report.lint, newLint }, null, 2) + '\n');
    assert.deepEqual(newLint, [], 'New posting source lint diagnostics');
  }
}
const hashes = {};
for (const name of names) {
  try { hashes[name] = createHash('sha256').update(await readFile(name)).digest('hex'); }
  catch { hashes[name] = null; }
}
await writeFile(`${artifact}/${mode}-source.json`, JSON.stringify({ at: new Date().toISOString(), node: process.version, hashes }, null, 2) + '\n');
await run(`${mode}-regressions`, ['tools/operator-posting-rounding-regressions.mjs', mode]);
if (mode !== 'shuffled') { await staticChecks(); }
if (mode === 'final') {
  const focused = ['test/mbt/unit/operator-posting-rounding.test.js', 'test/mbt/unit/operator-posting-rounding-sources.test.js',
    'test/mbt/integration/operator-posting-rounding.test.js'];
  await run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    `--reports-dir=${artifact}/coverage`, `--temp-directory=${artifact}/coverage/tmp`, '--clean=false',
    '--reporter=json', '--reporter=json-summary', '--reporter=text',
    ...names.map(name => `--include=${name}`), process.execPath, '--test', '--test-concurrency=1', ...focused]);
  await run('mutations', ['tools/operator-posting-rounding-mutations.mjs']);
  await run('new-code-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--max-warnings=0',
    'src/operator-netsuite-posting-quantity.js', ...focused, 'tools/operator-posting-rounding-regressions.mjs',
    'tools/operator-posting-rounding-mutations.mjs', 'tools/operator-posting-rounding-checks.mjs']);
  await run('secrets', ['test/support/scan-diff-secrets.mjs', '--unified-diff', `${artifact}/release.patch`,
    ...focused, 'tools/operator-posting-rounding-regressions.mjs', 'tools/operator-posting-rounding-mutations.mjs',
    'tools/operator-posting-rounding-checks.mjs', 'tools/operator-posting-rounding-prepare.py',
    'tools/operator-posting-rounding-deploy.py', 'tools/operator-posting-rounding-live.mjs',
    'tools/operator-posting-rounding-live.py', 'tools/operator-posting-rounding-coverage.py']);
  assert.deepEqual(hashes, Object.fromEntries(names.map(name => [name, manifest.changes[name].after])));
  await writeFile(`${artifact}/gauntlet.json`, JSON.stringify({ passed: true, sourceHashes: hashes, at: new Date().toISOString() }, null, 2) + '\n');
}
