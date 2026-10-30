import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const results = [];
for (const args of [
  ['--test', 'test/mbt/unit/return-notification.test.js', 'test/mbt/unit/return-notification-ui.test.js'],
  ['tools/return-notification-browser.mjs']
]) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 });
  fs.writeFileSync(`test-artifacts/recipient-help-${results.length}.log`, (result.stdout || '') + (result.stderr || ''));
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  results.push(result.stdout.match(/# tests \d+/)?.[0] || 'Seven browser scenarios passed');
}
const files = JSON.parse(fs.readFileSync('tools/return-recipient-help-files.json', 'utf8'));
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report = { passed: true, results, sourceHashes };
fs.writeFileSync('test-artifacts/return-recipient-help-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
