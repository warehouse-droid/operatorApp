import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const artifact = 'test-artifacts/customer-pickup-lookup-access';
const source = JSON.parse(await readFile('test-artifacts/operator-posting-pack-quantities/manifest.json', 'utf8'));
const hashes = {};
for (const [name, evidence] of Object.entries(source.changes)) {
  hashes[name] = createHash('sha256').update(await readFile(name)).digest('hex');
  assert.equal(hashes[name], evidence.after, `Deployed source mismatch: ${name}`);
}
async function run(name, args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || '');
  await writeFile(`${artifact}/${name}.log`, log);
  assert.equal(result.status, 0, `${name} failed; see its saved log`);
  return log;
}
const added = ['test/mbt/integration/customer-pickup-lookup-access.browser.test.mjs',
  'tools/customer-pickup-lookup-access-live.mjs', 'tools/customer-pickup-lookup-access-checks.mjs'];
for (const name of added) { await run(`syntax-${name.split('/').at(-1)}`, ['--check', name]); }
await run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js', '--max-warnings=0', ...added]);
const log = await run('final', ['--test', '--test-concurrency=1',
  'test/mbt/unit/customer-pickup-yard-ui.test.js', 'test/mbt/integration/customer-pickup-yard-scope.test.js',
  'test/mbt/integration/customer-pickup-lookup-access.browser.test.mjs', 'test/mbt/unit/customer-pickup-yard-scope.test.js']);
const counts = Object.fromEntries(['tests', 'pass', 'fail'].map(key =>
  [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'mu'))?.[1] || 0)]));
assert.equal(counts.tests, 37);
assert.equal(counts.pass, 37);
const report = { at: new Date().toISOString(), node: process.version, ...counts,
  syntax: added.length, lintExit: 0, runtimeChanges: 0, sourceHashes: hashes };
await writeFile(`${artifact}/checks.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
