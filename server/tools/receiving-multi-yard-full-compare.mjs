import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const baseline = JSON.parse(readFileSync('test/receiving-multi-yard-full-baseline.json', 'utf8'));
const output = readFileSync('test-artifacts/receiving-multi-yard/full-candidate.log', 'utf8');
const unique = pattern => [...new Set([...output.matchAll(pattern)].map(match => match[1]))];
const failures = unique(/^✖ (.+?) \([\d.]+ms\)/gm);
const deadlines = unique(/^TEST_FILE_DEADLINE (.+)$/gm);
const completed = [...output.matchAll(/MBT main (\d+)\/(\d+)/g)].at(-1);
assert.ok(completed && completed[1] === completed[2], 'The full candidate suite must finish every file.');
const fixtureName = 'selected receiving order card counts the same current remaining lines as its detail';
const rechecks = [];
if (failures.includes(fixtureName) && !baseline.failures.includes(fixtureName)) {
  const recheck = JSON.parse(readFileSync('test-artifacts/receiving-multi-yard/fixture-recheck.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('test/receiving-multi-yard-manifest.json', 'utf8'));
  assert.deepEqual(recheck.source, manifest.after);
  assert.equal(recheck.test, fixtureName);
  assert.ok(recheck.assertionsUnchanged && recheck.exit === 0 && recheck.passed === 1 && recheck.failed === 0);
  rechecks.push(recheck);
}
const sum = key => [...output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, 'gm'))]
  .reduce((total, row) => total + Number(row[1]), 0);
const result = {
  files: Number(completed[2]), passed: sum('pass'), failed: sum('fail'),
  cancelled: sum('cancelled'), skipped: sum('skipped'),
  baseline: {files: baseline.files, passed: baseline.passed, failed: baseline.failed},
  failures, deadlines,
  fixtureRechecks: rechecks,
  method: rechecks.length ? 'Full suite on unchanged production source plus fresh recheck after supplying a missing browser global to an extracted-function fixture; assertions unchanged.' : 'Full suite',
  newFailures: failures.filter(name => !baseline.failures.includes(name) && !rechecks.some(row => row.test === name)),
  newDeadlines: deadlines.filter(file => !baseline.deadlines.includes(file))
};
writeFileSync('test-artifacts/receiving-multi-yard/full-comparison.json', JSON.stringify(result, null, 2) + '\n');
assert.equal(result.newFailures.length, 0, JSON.stringify(result.newFailures));
assert.equal(result.newDeadlines.length, 0, JSON.stringify(result.newDeadlines));
console.log(JSON.stringify({files: result.files, passed: result.passed, failed: result.failed,
  newFailures: result.newFailures.length, deadlines: result.deadlines.length, newDeadlines: result.newDeadlines.length}));
