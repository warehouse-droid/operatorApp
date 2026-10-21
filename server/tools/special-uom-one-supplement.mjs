import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { scanUnifiedDiff, scanPaths } from '../test/support/scan-diff-secrets.mjs';
import { own } from './special-case-fields-suites.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out = 'test-artifacts/special-uom-one-20261003';
const files = JSON.parse(readFileSync('tools/special-uom-one-files.json'));
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const order = [...own].reverse(), counts = { tests: 0, pass: 0, fail: 0, skipped: 0 };
for (const [index, file] of order.entries()) {
  const result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 180000, maxBuffer: 20000000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/reverse-${index}.log`, log);
  assert.equal(result.status, 0, `Reordered suite failed: ${file}`);
  for (const key of Object.keys(counts)) counts[key] += Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0);
}
assert.ok(counts.tests > 0); assert.equal(counts.fail, 0); assert.equal(counts.skipped, 0);
const diffs = JSON.parse(readFileSync(out + '/changed-diffs.json')).files;
const scanFiles = [...own, 'test/special-uom-one-spec.md', ...readdirSync('tools').filter(file => file.startsWith('special-uom-one-')).map(file => 'tools/' + file)];
const findings = [...Object.values(diffs).flatMap(value => scanUnifiedDiff(value.diff)), ...await scanPaths(scanFiles)];
assert.deepEqual(findings, []);
const result = { sourceHashes, counts, order, secretFindings: findings, dependenciesChanged: false,
  tools: { node: process.version, ...Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test'].map(name => [name, JSON.parse(readFileSync('node_modules/' + name + '/package.json')).version])) } };
writeFileSync(out + '/supplement.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
