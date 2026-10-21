import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const testFile = 'test/mbt/unit/receiving-split-balance-ui.test.js';
const beforeFile = 'test/support/receiving-multi-yard-baseline/' + testFile;
const before = readFileSync(beforeFile, 'utf8');
const after = readFileSync(testFile, 'utf8');
assert.equal(after.replace('locationId: 28, ', ''), before,
  'Only the existing browser yard global may be added to this extracted-function fixture; every assertion is frozen.');
const manifest = JSON.parse(readFileSync('test/receiving-multi-yard-manifest.json', 'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
for (const [file, expected] of Object.entries(manifest.after)) {assert.equal(hash(readFileSync(file)), expected);}
const result = spawnSync(process.execPath, ['--test', testFile], {encoding: 'utf8'});
if (result.error) {throw result.error;}
const output = result.stdout + result.stderr;
writeFileSync('test-artifacts/receiving-multi-yard/fixture-recheck.log', output);
assert.equal(result.status, 0, output);
assert.match(output, /^# pass 1$/m);
assert.match(output, /^# fail 0$/m);
const report = {file: testFile, test: 'selected receiving order card counts the same current remaining lines as its detail',
  beforeHash: hash(before), afterHash: hash(after), assertionsUnchanged: true, source: manifest.after,
  exit: result.status, passed: 1, failed: 0, logHash: hash(output)};
writeFileSync('test-artifacts/receiving-multi-yard/fixture-recheck.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({file: testFile, assertionsUnchanged: true, passed: 1, failed: 0}));
