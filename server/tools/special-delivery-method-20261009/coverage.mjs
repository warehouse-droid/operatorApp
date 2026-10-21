import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const out = 'test-artifacts/special-delivery-method-20261009';
const measured = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`));
const browser = readdirSync(`${out}/browser`).filter(file => /^coverage-\d+\.json$/.test(file))
  .flatMap(file => JSON.parse(readFileSync(`${out}/browser/${file}`)));
const changed = [], branches = [];
for (const file of JSON.parse(readFileSync('tools/special-delivery-method-20261009/files.json')).filter(name => name.endsWith('.js'))) {
  const source = readFileSync(file, 'utf8');
  const diff = spawnSync('diff', ['-U0', `tools/special-delivery-method-20261009/baseline/${file}`, file], { encoding: 'utf8' });
  assert.ok([0, 1].includes(diff.status));
  const entry = Object.values(measured).find(value => value.path.endsWith('/' + file));
  const clientEntries = browser.filter(value => new URL(value.url).pathname === '/' + file.replace(/^public\//, '') && value.source === source);
  assert.ok(entry || clientEntries.length, 'Missing execution coverage: ' + file);
  let line = 0;
  const changedNumbers = new Set();
  for (const value of diff.stdout.split('\n')) {
    const hunk = value.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); }
    else if (value.startsWith('+') && !value.startsWith('+++')) {
      changedNumbers.add(line);
      const statements = entry ? Object.entries(entry.statementMap).filter(([, statement]) => statement.start.line <= line && statement.end.line >= line) : [];
      const offset = source.split('\n').slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
      const clientHit = clientEntries.some(client => client.functions.some(fn => {
        const ranges = fn.ranges.filter(range => range.startOffset <= offset && range.endOffset > offset).sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
        return ranges[0]?.count > 0;
      }));
      if (statements.length) {
        assert.ok(statements.some(([key]) => entry.s[key] > 0) || clientHit, `Uncovered changed line ${file}:${line}`);
        changed.push(`${file}:${line}`);
      } else if (file.startsWith('public/') && value.trim() && !/^\+\s*(?:\/\/|\*|[};]+\s*$)/.test(value)) {
        assert.ok(clientHit, `Uncovered browser line ${file}:${line}`); changed.push(`${file}:${line}`);
      }
      line++;
    }
  }
  if (entry) {
    for (const [key, branch] of Object.entries(entry.branchMap)) {
      if (!Array.from(changedNumbers).some(number => branch.loc.start.line <= number && branch.loc.end.line >= number)) { continue; }
      branches.push({ file, line: branch.loc.start.line, covered: entry.b[key].filter(Boolean).length, total: entry.b[key].length });
    }
  }
}
const report = { changedLines: changed.length, executedLines: changed.length, lines: changed, serverBranches: branches };
writeFileSync(`${out}/changed-coverage.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ changedLines: changed.length, executedLines: changed.length }));
