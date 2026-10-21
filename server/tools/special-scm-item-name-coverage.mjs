import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const out = 'test-artifacts/special-workflow-review/scm-item-name-20260930';
const files = ['src/special-stock-request-domain.js', 'src/special-stock-request-repository.js', 'public/scm-special-stock-requests.js'];
const measured = coverage.createCoverageMap(JSON.parse(readFileSync(out + '/coverage/coverage-final.json')));
for (const name of readdirSync(out + '/browser-final').filter(name => /^browser-coverage-.*\.json$/.test(name))) {
  for (const entry of JSON.parse(readFileSync(out + '/browser-final/' + name))) {
    const file = 'public/' + new URL(entry.url).pathname.split('/').pop();
    if (!files.includes(file)) continue;
    const source = readFileSync(file, 'utf8');
    assert.equal(entry.source, source);
    const converter = v8ToIstanbul(resolve(file), 0, { source });
    await converter.load(); converter.applyCoverage(entry.functions); measured.merge(converter.toIstanbul());
  }
}
const changed = JSON.parse(readFileSync(out + '/changed-lines.json'));
const report = { covered: 0, total: 0, uncovered: [], branches: { covered: 0, total: 0, uncovered: [] } };
for (const file of files) {
  assert(measured.files().includes(resolve(file)), 'Missing coverage: ' + file);
  const entry = measured.fileCoverageFor(resolve(file)), lines = entry.getLineCoverage();
  for (const line of changed[file]) {
    if (!Object.hasOwn(lines, line)) continue;
    report.total++;
    if (lines[line]) report.covered++; else report.uncovered.push(`${file}:${line}`);
  }
  for (const [key, branch] of Object.entries(entry.branchMap)) {
    if (!changed[file].includes(branch.line)) continue;
    for (const count of entry.b[key]) {
      report.branches.total++;
      if (count) report.branches.covered++; else report.branches.uncovered.push(`${file}:${branch.line}`);
    }
  }
}
writeFileSync(out + '/coverage-result.json', JSON.stringify(report, null, 2) + '\n');
assert.deepEqual(report.uncovered, []);
assert.deepEqual(report.branches.uncovered, []);
console.log(JSON.stringify(report));
