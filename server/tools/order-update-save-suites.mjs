import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const mode = process.argv[2] || 'focused';
const files = (await readdir('test/dispatch', { recursive: true }))
  .filter(file => /\.test\.(js|mjs)$/.test(file))
  .filter(file => mode === 'adjacent' ? !file.includes('order-update-') : file.includes('order-update-'))
  .filter(file => mode !== 'properties' || file.startsWith('property/'))
  .map(file => path.resolve('test/dispatch', file)).sort();
if (process.argv.includes('reverse')) files.reverse();
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
process.exitCode = await runNodeTestFilesIsolated(files, { environment, label: `Order update ${mode}` });
