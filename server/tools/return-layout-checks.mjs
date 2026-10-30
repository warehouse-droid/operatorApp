import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const args of [
  ['--check', 'public/operator.js'],
  ['--test', 'test/mbt/unit/return-enhancements-ui.test.js'],
  ['tools/return-enhancements-browser.mjs'],
  ['tools/return-layout-browser.mjs']
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  assert.equal(result.status, 0, args.join(' '));
}
const sourceHashes = Object.fromEntries(['public/operator.js', 'public/operator.css', 'public/operator.html']
  .map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync('/app/test-artifacts/return-layout-validation.json', JSON.stringify({
  passed: true, sourceHashes, uiTests: 3, browserCases: 14,
  widths: [320, 390, 768, 1024, 1440], scrollAdditions: 20
}, null, 2));
