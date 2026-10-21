import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import coverage from 'istanbul-lib-coverage';

const out = 'test-artifacts/goa-co-planning-20261001';
const diffs = JSON.parse(readFileSync(out + '/candidate-diffs.json'));
const measured = coverage.createCoverageMap(JSON.parse(readFileSync(out + '/coverage/coverage-final.json')));
const report = { total: 0, covered: 0, uncovered: [], files: {} };
for (const [file, comparison] of Object.entries(diffs)) {
  if (!file.endsWith('.js')) {continue;}
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), comparison.sourceHash, 'Coverage source drift');
  const numbers = new Set();
  for (const match of comparison.diff.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let line = Number(match[1]); line < Number(match[1]) + Number(match[2] ?? 1); line += 1) {numbers.add(line);}
  }
  const lines = measured.fileCoverageFor(resolve(file)).getLineCoverage();
  const detail = { total: 0, covered: 0 };
  report.files[file] = detail;
  for (const line of numbers) {
    if (!Object.hasOwn(lines, line)) {continue;}
    report.total += 1; detail.total += 1;
    if (lines[line]) { report.covered += 1; detail.covered += 1; }
    else {report.uncovered.push(file + ':' + line);}
  }
}
writeFileSync(out + '/changed-lines.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.deepEqual(report.uncovered, [], 'Changed lines require meaningful execution');
