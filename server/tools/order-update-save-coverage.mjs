import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parse } from 'espree';
import { runtimeFiles } from './order-update-save-files.mjs';

const require = createRequire(import.meta.url);
const v8ToIstanbul = require('v8-to-istanbul');
const { createCoverageMap } = require('istanbul-lib-coverage');
const directory = 'test-artifacts/order-update-save';
const map = createCoverageMap(JSON.parse(await readFile(`${directory}/coverage/coverage-final.json`, 'utf8')));
const adjacent = await readFile(`${directory}/coverage-adjacent/coverage-final.json`, 'utf8').then(JSON.parse).catch(() => null);
if (adjacent) map.merge(adjacent);
for (const extra of ['coverage-full', 'coverage-startup', 'coverage-incident', 'coverage-rollback']) {
  const coverage = await readFile(`${directory}/${extra}/coverage-final.json`, 'utf8').then(JSON.parse).catch(() => null);
  if (coverage) map.merge(coverage);
}
delete map.data[path.resolve('public/dispatch.js')];
for (const name of await readdir(`${directory}/v8`)) {
  if (!name.endsWith('.json')) continue;
  const data = JSON.parse(await readFile(`${directory}/v8/${name}`, 'utf8'));
  for (const script of data.result || []) {
    if (!script.url.endsWith('public/dispatch.js')) continue;
    const source = await readFile('public/dispatch.js', 'utf8');
    const converter = v8ToIstanbul(path.resolve('public/dispatch.js'), 0, { source });
    await converter.load();
    converter.applyCoverage([{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] },
      ...script.functions.filter(fn => fn.functionName || fn.ranges[0].startOffset > 0)]);
    map.merge(converter.toIstanbul());
  }
}
for (const script of JSON.parse(await readFile(`${directory}/browser-v8.json`, 'utf8'))) {
  if (!script.functions.length || new URL(script.url).pathname !== '/dispatch.js') continue;
  const source = await readFile('public/dispatch.js', 'utf8');
  assert.equal(script.source, source, 'Browser coverage is stale');
  const converter = v8ToIstanbul(path.resolve('public/dispatch.js'), 0, { source });
  await converter.load();
  converter.applyCoverage([{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }, ...script.functions]);
  map.merge(converter.toIstanbul());
}
const report = {};
for (const file of runtimeFiles) {
  const baseline = `${directory}/baseline/${file}`;
  const before = await readFile(baseline).then(() => baseline).catch(() => '/dev/null');
  const diff = spawnSync('diff', ['-U0', before, file], { encoding: 'utf8' }).stdout;
  const changed = [];
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let i = 0; i < Number(match[2] ?? 1); i++) changed.push(Number(match[1]) + i);
  }
  const lines = map.data[path.resolve(file)]?.getLineCoverage() || {};
  const tokens = parse(await readFile(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', tokens: true, loc: true }).tokens;
  const executableLines = new Set(tokens.flatMap(token => Array.from({ length: token.loc.end.line - token.loc.start.line + 1 }, (_, i) => token.loc.start.line + i)));
  const executable = changed.filter(line => executableLines.has(line));
  report[file] = { changed: changed.length, executableChanged: executable.length, uncovered: executable.filter(line => !lines[line]) };
}
await writeFile(`${directory}/combined-coverage.json`, JSON.stringify(map.toJSON()));
await writeFile(`${directory}/changed-line-coverage.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.equal(Object.values(report).reduce((count, row) => count + row.uncovered.length, 0), 0,
  'Changed runtime lines without execution evidence require investigation');
