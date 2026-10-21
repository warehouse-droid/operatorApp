import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';

const root = mkdtempSync('/tmp/split-identity-mutants-');
const file = 'public/dispatch.js', test = 'test/dispatch/frontend/split-draft-identity.test.js';
const source = readFileSync(file, 'utf8');
const original = 'item.lineId || item.line_id || item.lineRowId || item.id || item.sku || item.itemName';
const mutants = [
  ['row-first', 'item.lineRowId || item.id || item.lineId || item.line_id || item.sku || item.itemName'],
  ['sku-first', 'item.sku || item.lineId || item.line_id || item.lineRowId || item.id || item.itemName'],
  ['snake-after-row', 'item.lineId || item.lineRowId || item.line_id || item.id || item.sku || item.itemName'],
  ['missing-row-fallback', 'item.lineId || item.line_id || item.id || item.sku || item.itemName']
];
assert.equal(source.split(original).length, 2);
try {
  mkdirSync(root + '/public', { recursive: true });
  mkdirSync(root + '/test/dispatch/frontend', { recursive: true });
  cpSync(test, root + '/' + test);
  cpSync('package.json', root + '/package.json');
  symlinkSync(resolve('node_modules'), root + '/node_modules');
  const rows = [];
  for (const [name, replacement] of mutants) {
    writeFileSync(root + '/' + file, source.replace(original, replacement));
    const run = property => {
      const result = spawnSync(process.execPath, ['--test',
        ...(property ? ['--test-name-pattern=property:'] : []), test],
      { cwd: root, encoding: 'utf8', timeout: 30000 });
      const log = result.stdout + result.stderr;
      writeFileSync(`test-artifacts/mutant-${name}${property ? '-property' : ''}.log`, log);
      return { killed: result.status === 1 && /^not ok /mu.test(log),
        failures: [...log.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]) };
    };
    const full = run(false), propertyOnly = run(true);
    assert.equal(full.killed, true, name);
    rows.push({ name, ...full, propertyOnly });
  }
  const coverage = JSON.parse(readFileSync('test-artifacts/split-draft-identity-20261020/browser/coverage.json', 'utf8'));
  const script = coverage.find(entry => entry.url.endsWith('/dispatch.js'));
  assert.equal(script.source, source);
  const position = source.indexOf('return String(' + original);
  assert.ok(position >= 0);
  const ranges = script.functions.flatMap(fn => fn.ranges)
    .filter(range => range.startOffset <= position && range.endOffset > position)
    .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
  assert.ok(ranges[0]?.count > 0);
  const result = { mutations: rows, changedLineCoverage: { total: 1, covered: 1,
    line: source.slice(0, position).split('\n').length, executionCount: ranges[0].count },
  sourceHash: crypto.createHash('sha256').update(source).digest('hex') };
  writeFileSync('test-artifacts/mutations.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  rmSync(root, { recursive: true, force: true });
  assert.equal(readFileSync(file, 'utf8'), source);
}
