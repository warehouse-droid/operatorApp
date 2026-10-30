// The complete npm test selection, divided without changing any assertions.
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
const index = Number(process.argv[2]), count = Number(process.argv[3]);
if (!Number.isInteger(index) || ![1, 2].includes(count) || index < 0 || index >= count)
  throw new Error('Invalid bounded test shard');
const groups = ['infrastructure', 'unit', 'contracts', 'property', 'integration', 'adversarial', 'concurrency'];
async function discover(directory) {
  const files = [];
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(name));
    else if (/\.test\.(?:js|mjs)$/.test(entry.name)) files.push(name);
  }
  return files;
}
const all = process.argv[4] ? JSON.parse(process.argv[4]).map(file => path.resolve(file))
  : (await Promise.all(groups.map(group => discover(path.resolve('test/mbt', group))))).flat();
if (new Set(all).size !== all.length) throw new Error('Duplicate test file');
if (process.env.MBBS_TEST_SHUFFLE_SEED) {
  const rank = file => createHash('sha256').update(process.env.MBBS_TEST_SHUFFLE_SEED + ':' + file).digest('hex');
  all.sort((a, b) => rank(a).localeCompare(rank(b)));
}
const files = all.filter((_, position) => position % count === index);
console.log(JSON.stringify({shard: index + 1, shards: count, selectedFiles: files.length, totalFiles: all.length}));
process.exitCode = files.length ? await runNodeTestFilesIsolated(files, {
  environment: buildIsolatedTestEnvironment(process.env, {databaseUrl: process.env.DATABASE_URL}),
  label: `Release shard ${index + 1}`
}) : 0;
