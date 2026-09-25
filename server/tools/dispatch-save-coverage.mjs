import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parse } from 'espree';

const require = createRequire(import.meta.url);
const v8ToIstanbul = require('v8-to-istanbul');
const { createCoverageMap } = require('istanbul-lib-coverage');
const directory = 'test-artifacts/dispatch-save-reliability';
const map = createCoverageMap(JSON.parse(await readFile(`${directory}/coverage/coverage-final.json`, 'utf8')));
const adjacent = await readFile(`${directory}/coverage-adjacent/coverage-final.json`, 'utf8').then(JSON.parse).catch(() => null);
if (adjacent) map.merge(adjacent);
// VM tests contain only one real declaration and whitespace before it. Discard
// the synthetic program range; it must never count earlier application code as
// executed. Named function and nested block offsets still match the real file.
for (const file of ['public/dispatch.js', 'public/dispatch-snapshot.js']) delete map.data[path.resolve(file)];
// Only these focused VM fixtures guarantee exact source offsets. Adjacent
// server coverage is merged above; other extracted browser snippets are not
// credited as full-file execution.
for (const folder of ['v8']) {
for (const name of await readdir(`${directory}/${folder}`).catch(() => [])) {
  if (!name.endsWith('.json')) continue;
  const data = JSON.parse(await readFile(`${directory}/${folder}/${name}`, 'utf8'));
  for (const script of data.result || []) {
    const file = ['public/dispatch.js', 'public/dispatch-snapshot.js'].find(f => script.url.endsWith(f));
    if (!file) continue;
    const source = await readFile(file, 'utf8');
    const converter = v8ToIstanbul(path.resolve(file), 0, { source });
    await converter.load();
    converter.applyCoverage([{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] },
      ...script.functions.filter(fn => fn.functionName || fn.ranges[0].startOffset > 0)]);
    map.merge(converter.toIstanbul());
  }
}
}
for (const artifact of ['browser-v8.json', 'journal-v8.json', 'snapshot-v8.json']) {
  const entries = JSON.parse(await readFile(`${directory}/${artifact}`, 'utf8'));
  for (const script of entries) {
    // Navigation may leave a script entry with no retained counters. The V8
    // converter defaults such a file to covered; it is not execution evidence.
    if (!script.functions.length) continue;
    const pathname = new URL(script.url).pathname;
    const file = pathname === '/journal.js' ? 'public/dispatch-save-journal.js' : `public${pathname}`;
    if (!['public/dispatch.js', 'public/dispatch-save-journal.js', 'public/dispatch-snapshot.js'].includes(file)) continue;
    assert.equal(script.source, await readFile(file, 'utf8'), `${file}: browser coverage is stale`);
    const converter = v8ToIstanbul(path.resolve(file), 0, { source: script.source });
    await converter.load();
    converter.applyCoverage([{ functionName: '', isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: script.source.length, count: 0 }] }, ...script.functions]);
    map.merge(converter.toIstanbul());
  }
}
const checks = JSON.parse(await readFile(`${directory}/checks.json`, 'utf8'));
const report = {};
for (const file of Object.keys(checks.sources).filter(f => f.endsWith('.js'))) {
  const baseline = `${directory}/baseline/${file}`;
  const before = await readFile(baseline).then(() => baseline).catch(() => '/dev/null');
  const diff = spawnSync('diff', ['-U0', before, file], { encoding: 'utf8' }).stdout;
  const changed = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let n = 0; n < Number(m[2] ?? 1); n++) changed.push(Number(m[1]) + n);
  }
  const coverage = map.data[path.resolve(file)];
  const lines = coverage?.getLineCoverage() || {};
  // Comments and blank lines are not executable statements. Token locations
  // distinguish them from strings containing comment-like text without regexes.
  const tokens = parse(await readFile(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', tokens: true, loc: true }).tokens;
  const executableLines = new Set(tokens.flatMap(token => Array.from({ length: token.loc.end.line - token.loc.start.line + 1 }, (_, i) => token.loc.start.line + i)));
  const executable = changed.filter(line => executableLines.has(line));
  report[file] = { changed: changed.length, executableChanged: executable.length, uncovered: executable.filter(line => !lines[line]) };
}
await writeFile(`${directory}/combined-coverage.json`, JSON.stringify(map.toJSON()));
await writeFile(`${directory}/changed-line-coverage.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
