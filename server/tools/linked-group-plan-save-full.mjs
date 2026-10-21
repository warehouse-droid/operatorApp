import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const side = process.argv[2];
assert.ok(['baseline', 'final'].includes(side));
const groups = ['infrastructure', 'unit', 'contracts', 'property', 'integration', 'adversarial', 'concurrency'];
const workers = 4;
function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? findTests(directory + '/' + entry.name)
      : /\.test\.(?:js|mjs)$/u.test(entry.name) ? [resolve(directory, entry.name)] : []);
}
const files = groups.flatMap(group => findTests('test/mbt/' + group));
if (process.argv[3] === '--shard') {
  const shard = Number(process.argv[4]);
  assert.ok(Number.isInteger(shard) && shard >= 0 && shard < workers);
  const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
  process.exitCode = await runNodeTestFilesIsolated(files.filter((_, index) => index % workers === shard),
    { environment, label: 'MBT main' });
} else {
  const results = await Promise.all(Array.from({ length: workers }, (_, index) => new Promise((done, reject) => {
    const file = `test-artifacts/linked-group-plan-save-20261001/full-${side}-part-${index}.log`;
    const output = createWriteStream(file);
    const child = spawn(process.execPath, [...process.execArgv, 'tools/linked-group-plan-save-full.mjs', side,
      '--shard', String(index)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    child.once('error', reject);
    child.once('close', (code, signal) => output.end(() => done({ file, code: signal ? 1 : (code ?? 1) })));
  })));
  for (const result of results) { process.stdout.write(readFileSync(result.file)); }
  process.exitCode = Math.max(...results.map(result => result.code));
}
