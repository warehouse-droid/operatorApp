import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const artifact = 'test-artifacts/customer-webhook/final';
await rm(artifact, { recursive: true, force: true });
await mkdir(artifact, { recursive: true });
const sourceFiles = ['src/netsuite-customer-webhook.js', 'src/netsuite-customer-webhook-router.js',
  'netsuite-customer-webhook-user-event.js', 'src/server.js'];
const newTests = ['test/mbt/integration/customer-webhook.test.js', 'test/mbt/unit/customer-webhook-sender.test.js'];
const regression = ['test/mbt/integration/customer-sync.test.js', 'test/mbt/integration/customer-sync-branch-hardening.test.js',
  'test/mbt/unit/customer-master-contract-boundaries.test.js', 'test/mbt/unit/customer-source-sync-branch-hardening.test.js',
  'test/mbt/unit/return-customer-projection-branches.test.js', 'test/mbt/property/customer-sync.property.test.js',
  'test/mbt/concurrency/customer-sync-races.test.js'];

async function run(name, args, timeout = 180000) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(`${artifact}/${name}.log`, (result.stdout || '') + (result.stderr || ''));
  assert.equal(result.status, 0, `${name} failed; inspect ${artifact}/${name}.log`);
  console.log(`${name}: passed`);
}
for (const file of sourceFiles) { await run(`syntax-${file.replaceAll('/', '-')}`, ['--check', file]); }
await run('types', ['node_modules/typescript/bin/tsc', '--project', 'tools/customer-webhook-tsconfig.json']);
await run('secrets', ['test/support/scan-diff-secrets.mjs', ...sourceFiles.filter(file => file !== 'src/server.js')]);
await run('tests-coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  '--include=src/netsuite-customer-webhook*.js', '--temp-directory=/tmp/customer-webhook-c8',
  `--report-dir=${artifact}/coverage`, '--reporter=text', '--reporter=json', '--reporter=json-summary',
  'node', '--test', '--test-concurrency=1', ...newTests, ...regression]);
await run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/customer-webhook-eslint.config.mjs',
  '--max-warnings=0', ...sourceFiles.filter(file => file !== 'src/server.js'), ...newTests,
  'tools/customer-webhook-gauntlet.mjs', 'tools/customer-webhook-mutations.mjs', 'tools/customer-webhook-runtime.mjs']);
await run('mutations', ['tools/customer-webhook-mutations.mjs']);
await run('runtime', ['tools/customer-webhook-runtime.mjs']);
const hashes = {};
for (const file of [...sourceFiles, ...newTests, ...regression]) {
  hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
}
const versions = { node: process.version };
for (const name of ['pg', 'express', 'fast-check', 'c8', 'eslint', 'typescript']) {
  versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
}
await writeFile(`${artifact}/source-state.json`, JSON.stringify({ hashes, versions }, null, 2) + '\n');
console.log(`Customer webhook gauntlet complete: ${artifact}`);
