import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const baseline = process.argv.includes('baseline');
const randomized = process.argv.includes('random');
const files = (await readdir('test/dispatch', { recursive: true }))
  .filter(file => /\.test\.(js|mjs)$/.test(file) && /dispatch-(v2|save|plan|split-date|retired|co|order|global)|co-source-packing/.test(file))
  .filter(file => !baseline || !/dispatch-save-(reliability|snapshot|compaction|digest-compatibility|projection-identity)/.test(file))
  .map(file => path.resolve('test/dispatch', file)).sort();
if (randomized) {
  // Fixed, reproducible permutation of test-file order.
  let state = 9172026;
  for (let i = files.length - 1; i; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1); [files[i], files[j]] = [files[j], files[i]];
  }
}
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
if (process.argv.includes('--cancel-first')) {
  // Exercise the valid cancellation-first schedule deterministically. The
  // original test assertions are intact; both compared versions use it.
  environment.NODE_OPTIONS = `${environment.NODE_OPTIONS || ''} --experimental-loader ${path.resolve('test/support/dispatch-save-co-race-order.mjs')}`.trim();
}
process.exitCode = await runNodeTestFilesIsolated(files, { environment, label: 'Dispatch save adjacent' });
