import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const folder = process.argv[2];
const coverage = JSON.parse(await readFile(path.join(folder, 'coverage-final.json'), 'utf8'));
const summary = JSON.parse(await readFile(path.join(folder, 'coverage-summary.json'), 'utf8'));
const targets = new Map();
for (const file of ['src/operator-co-routing.js', 'src/co-source-receipt.js']) {
  targets.set(file, (await readFile(file, 'utf8')).split('\n').map((_, index) => index + 1));
}
const patch = await readFile('test/support/co-operator-baseline.patch', 'utf8');
for (const section of patch.split(/^--- a\//m).slice(1)) {
  const file = section.split('\n')[0];
  if (!file.startsWith('src/')) {continue;}
  const added = [];
  let line = 0;
  for (const text of section.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {line = Number(hunk[1]);}
    else if (line && text.startsWith('+')) {added.push(line++);}
    else if (line && text.startsWith(' ')) {line++;}
  }
  targets.set(file, added);
}
let total = 0, hit = 0;
for (const [file, lines] of targets) {
  const entry = coverage[path.resolve(file)];
  assert(entry, `Missing coverage: ${file}`);
  const misses = [];
  for (const line of lines) {
    const candidates = Object.entries(entry.statementMap).filter(([, loc]) => loc.start.line <= line && loc.end.line >= line)
      .sort((a, b) => (a[1].end.line - a[1].start.line) - (b[1].end.line - b[1].start.line));
    if (!candidates.length) {continue;}
    total++;
    if (entry.s[candidates[0][0]] > 0) {hit++;} else {misses.push(line);}
  }
  console.log(`${file}: uncovered changed lines ${misses.join(',') || 'none'}; branch coverage ${summary[path.resolve(file)].branches.pct}%`);
}
console.log(`Changed server line coverage: ${hit}/${total}`);
assert.equal(hit, total, 'Changed server lines must be exercised.');
