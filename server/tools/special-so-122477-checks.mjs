import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { typeDiagnostics } from './special-so-122477-diagnostics.mjs';

const mode = process.argv[2];
const phase = process.argv[3] || 'full';
assert.ok(['baseline', 'final', 'shuffled'].includes(mode));
assert.ok(['full', 'verification'].includes(phase));
const artifact = 'test-artifacts/special-so-122477';
const sources = ['src/special-stock-request-service.js', 'src/special-stock-request-repository.js', 'src/netsuite.js'];
const focused = ['test/mbt/unit/special-so-creation-confirmation.test.js', 'test/mbt/unit/special-so-creation-marker.test.js',
  'test/mbt/integration/special-so-creation-confirmation.test.js', 'test/mbt/integration/special-so-creation-webhook.test.js'];
await mkdir(artifact, { recursive: true });
if (mode === 'final' && phase === 'full') {
  await rm(`${artifact}/gauntlet.json`, { force: true });
  await rm(`${artifact}/coverage`, { recursive: true, force: true });
  await mkdir(`${artifact}/coverage/tmp`, { recursive: true });
}
async function run(name, args, allowFailure = false) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || '');
  await writeFile(`${artifact}/${name}.log`, log);
  console.log(JSON.stringify({ check: name, exitCode: result.status }));
  if (!allowFailure) assert.equal(result.status, 0, `Check failed: ${name}; see retained log`);
  return log;
}
function additional(baseline, current) {
  const remaining = new Map();
  for (const value of baseline) remaining.set(value, (remaining.get(value) || 0) + 1);
  return current.filter(value => {
    const count = remaining.get(value) || 0;
    if (count) { remaining.set(value, count - 1); return false; }
    return true;
  });
}
const hashes = Object.fromEntries(await Promise.all(sources.map(async name => [name,
  createHash('sha256').update(await readFile(name)).digest('hex')])));
if (phase === 'verification') {
  assert.deepEqual(JSON.parse(await readFile(`${artifact}/final-source.json`, 'utf8')).hashes, hashes,
    'Regression source changed; run the full suite again');
  assert.deepEqual(JSON.parse(await readFile(`${artifact}/final-summary.json`, 'utf8')).newFailures, []);
}
await writeFile(`${artifact}/${mode}-source.json`, JSON.stringify({ at: new Date().toISOString(), node: process.version, hashes }, null, 2) + '\n');
if (phase === 'full') await run(`${mode}-regressions`, ['tools/special-so-122477-regressions.mjs', mode]);
if (mode !== 'shuffled') {
  for (const name of sources) await run(`${mode}-syntax-${name.split('/').at(-1)}`, ['--check', name]);
  const types = await run(`${mode}-types`, ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--lib', 'ES2023,DOM', '--skipLibCheck', ...sources], true);
  const lint = await run(`${mode}-lint`, ['node_modules/eslint/bin/eslint.js', '--config', 'tools/special-workflow-native-eslint.config.mjs', '--format', 'json', ...sources], true);
  const report = {
    types: typeDiagnostics(types),
    lint: JSON.parse(lint).flatMap(file => file.messages.map(message => `${file.filePath.split('/app/').at(-1)}:${message.ruleId}:${message.message}`))
  };
  await writeFile(`${artifact}/${mode}-static.json`, JSON.stringify(report, null, 2) + '\n');
  if (mode === 'final') {
    const baseline = JSON.parse(await readFile(`${artifact}/baseline-static.json`, 'utf8'));
    baseline.types = typeDiagnostics(await readFile(`${artifact}/baseline-types.log`, 'utf8'));
    const result = { baselineTypes: baseline.types.length, finalTypes: report.types.length,
      newTypes: additional(baseline.types, report.types), newLint: additional(baseline.lint, report.lint) };
    await writeFile(`${artifact}/static-comparison.json`, JSON.stringify(result, null, 2) + '\n');
    assert.deepEqual(result.newTypes, []);
    assert.deepEqual(result.newLint, []);
    await run('diagnostic-comparison-tests', ['--test', 'test/support/special-so-diagnostics.test.mjs']);
  }
}
if (mode === 'final') {
  await run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    `--reports-dir=${artifact}/coverage`, `--temp-directory=${artifact}/coverage/tmp`, '--clean=false',
    '--reporter=json', '--reporter=json-summary', ...sources.map(name => `--include=${name}`),
    process.execPath, '--test', '--test-concurrency=1', ...focused]);
  await run('mutations', ['tools/special-so-122477-mutations.mjs']);
  await run('new-test-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/special-workflow-native-eslint.config.mjs',
    '--max-warnings=0', ...focused, 'tools/special-so-122477-checks.mjs', 'tools/special-so-122477-regressions.mjs',
    'tools/special-so-122477-mutations.mjs', 'tools/special-so-122477-diagnostics.mjs', 'test/support/special-so-diagnostics.test.mjs']);
  await run('secrets', ['test/support/scan-diff-secrets.mjs', '--unified-diff', `${artifact}/release.patch`, ...focused,
    'tools/special-so-122477-checks.mjs', 'tools/special-so-122477-regressions.mjs', 'tools/special-so-122477-mutations.mjs',
    'tools/special-so-122477/prepare.py', 'tools/special-so-122477/run.py', 'tools/special-so-122477/inspect.mjs',
    'tools/special-so-122477/recover.mjs', 'tools/special-so-122477/deploy.py', 'tools/special-so-122477/evidence.py',
    'tools/special-so-122477-diagnostics.mjs', 'test/support/special-so-diagnostics.test.mjs']);
  const manifest = JSON.parse(await readFile(`${artifact}/manifest.json`, 'utf8'));
  assert.deepEqual(hashes, Object.fromEntries(sources.map(name => [name, manifest.changes[name].after])));
  await writeFile(`${artifact}/gauntlet.json`, JSON.stringify({ passed: true, sourceHashes: hashes, at: new Date().toISOString() }, null, 2) + '\n');
}
