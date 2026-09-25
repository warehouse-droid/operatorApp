import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { query, closeDb } from '../src/db.js';
const require = createRequire(import.meta.url);
const directory = 'test-artifacts/dispatch-save-reliability';
const files = await readFile(`${directory}/live-image-files.json`, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const manifests = {};
for (const name of ['package.json', 'package-lock.json']) {
  const sha256 = createHash('sha256').update(await readFile(name)).digest('hex');
  const expected = files?.[name] || createHash('sha256').update(await readFile(`${directory}/baseline/${name}`)).digest('hex');
  assert.equal(sha256, expected, `Dependency manifest changed: ${name}`);
  manifests[name] = sha256;
}
try {
  const versions = { node: process.version, postgres: (await query('SELECT version() AS version')).rows[0].version };
  for (const name of ['@playwright/test', 'fast-check', 'c8', 'eslint', 'typescript']) versions[name] = require(`${name}/package.json`).version;
  const result = { versions, manifests, newDependencies: 0, completedAt: new Date().toISOString() };
  await writeFile(`${directory}/inventory.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
