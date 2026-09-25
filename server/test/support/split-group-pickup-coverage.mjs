import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'split-group-coverage-'));
const result = spawnSync('node_modules/.bin/c8', [
  '--all=false', '--check-coverage=false', '--include=src/server.js', '--include=src/dispatch-order-catalog-repository.js',
  '--reporter=json', '--report-dir=' + temporary, '--temp-directory=' + path.join(temporary,'raw'),
  process.execPath, '--test', 'test/dispatch/integration/dispatch-split-pickup-pool.test.js'
], { encoding: 'utf8', timeout: 120000 });
assert.equal(result.status, 0, result.stdout + result.stderr);
const report = JSON.parse(await readFile(path.join(temporary,'coverage-final.json'), 'utf8'));
const changed = JSON.parse(await readFile('/workspace/server/test-artifacts/split-group-pickup/changed-lines.json', 'utf8'));
const evidence = {};
for (const [file, lines] of Object.entries(changed)) {
  const entry = report[path.resolve(file)];
  assert.ok(entry, file);
  const covered = lines.filter(line => Object.entries(entry.statementMap).some(([key, range]) =>
    range.start.line <= line && range.end.line >= line && entry.s[key] > 0));
  assert.deepEqual(covered, lines, file + ' changed lines not covered');
  const branches = Object.entries(entry.branchMap).filter(([, value]) => lines.includes(value.loc.start.line));
  for (const [key, branch] of branches) {
    assert.ok(entry.b[key].every(count => count > 0), 'Missed branch at ' + file + ':' + branch.loc.start.line);
  }
  evidence[file] = { changedLines: lines, covered, branchCounters: branches.map(([key]) => entry.b[key]),
    sha256: createHash('sha256').update(await readFile(file)).digest('hex') };
}
console.log(JSON.stringify(evidence));
