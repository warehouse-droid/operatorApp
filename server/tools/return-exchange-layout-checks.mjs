import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.argv[2] || '.';
for (const args of [
  ['--check', path.join(root, 'public/operator.js')],
  ['--check', path.join(root, 'public/operator-display-settings.js')],
  ['--check', path.join(root, 'public/i18n.js')],
  ['--test', 'test/mbt/unit/return-enhancements-ui.test.js', 'test/mbt/unit/operator-display-settings.test.js'],
  ['tools/return-exchange-layout-browser.mjs', root],
  ['tools/return-layout-browser.mjs', root],
  ['tools/return-enhancements-browser.mjs', root],
  ['tools/return-summary-browser.mjs', root]
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 180000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, args.join(' '));
}
const sourceHashes = Object.fromEntries(['operator.js', 'operator.css', 'operator-phone.css', 'operator-display-settings.js', 'operator.html', 'i18n.js']
  .map(file => [file, createHash('sha256').update(readFileSync(path.join(root, 'public', file))).digest('hex')]));
console.log(JSON.stringify({ passed: true, browserCases: 54, unitTests: 8, sourceHashes }));
