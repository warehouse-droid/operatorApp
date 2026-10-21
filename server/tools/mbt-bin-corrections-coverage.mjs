import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const baseline = '/workspace/server/test-artifacts/mbt-bin-corrections-20261015/baseline/';
const map = coverageLibrary.createCoverageMap(JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json', 'utf8')));
for (const name of ['planning', 'frontdesk']) {
  const entries = JSON.parse(readFileSync(`test-artifacts/${name}-browser-coverage.json`, 'utf8'));
  for (const entry of entries) {
    const pathname = new URL(entry.url).pathname;
    if (!['/mbt-frontdesk.js', '/mbt-planning.js'].includes(pathname)) { continue; }
    const converter = v8ToIstanbul('/app/public' + pathname, 0, { source: entry.source });
    await converter.load(); converter.applyCoverage(entry.functions); map.merge(converter.toIstanbul());
  }
}
const files = ['src/mbt/frontdesk-bin-readiness.js', 'src/mbt/frontdesk-service.js',
  'src/mbt/customer-charge-request-service.js', 'src/mbt/customer-charge-calculator.js',
  'src/mbt/bin-dispatch-service.js', 'public/mbt-frontdesk.js', 'public/mbt-planning.js'];
const report = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8').split('\n');
  const changed = new Set();
  if (!existsSync(baseline + file)) {
    source.forEach((_line, i) => changed.add(i + 1));
  } else {
    const result = spawnSync('diff', ['-U0', baseline + file, file], { encoding: 'utf8' });
    for (const match of result.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]); const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let line = start; line < start + count; line++) { changed.add(line); }
    }
  }
  const data = map.fileCoverageFor('/app/' + file).getLineCoverage();
  const executable = [...changed].filter(line => data[line] !== undefined
    && /[A-Za-z0-9_$]/u.test(source[line - 1] || '')
    && !/^\s*(?:\/\/|\/\*|\*)/u.test(source[line - 1] || ''));
  const missed = executable.filter(line => data[line] === 0);
  report.push({ file, changed: executable.length, covered: executable.length - missed.length, missed });
}
writeFileSync('test-artifacts/changed-coverage.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.ok(report.every(file => file.missed.length === 0), 'Every executable changed line must be covered.');
