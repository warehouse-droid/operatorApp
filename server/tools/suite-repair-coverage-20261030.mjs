import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import v8ToIstanbul from 'v8-to-istanbul';

const artifact = '/app/test-artifacts';
const changed = JSON.parse(await readFile(path.join(artifact, 'repair-changed-lines.json'), 'utf8'));
const executed = new Map();

async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) { files.push(...await discover(name)); }
    else if (entry.name.endsWith('.json') && name.includes('coverage')) { files.push(name); }
  }
  return files;
}

function sourceName(url) {
  if (!url) { return null; }
  if (url.startsWith('/app/')) { return url.slice(5); }
  if (url.startsWith('file:///app/')) { return url.slice(12).split('?')[0]; }
  if (/^https?:\/\//u.test(url)) { return 'public' + new URL(url).pathname; }
  return null;
}

async function add(entry) {
  const name = sourceName(entry.url);
  if (!changed[name]) { return; }
  const source = await readFile('/app/' + name, 'utf8');
  const text = entry.source ?? entry.text;
  if (text !== undefined && text !== source) { return; }
  const functions = entry.functions ?? [{functionName: '', isBlockCoverage: true,
    ranges: [{startOffset: 0, endOffset: source.length, count: 0},
      ...(entry.ranges ?? []).map(range => ({startOffset: range.start, endOffset: range.end, count: 1}))]}];
  const converter = v8ToIstanbul('/app/' + name, 0, {source});
  await converter.load();
  converter.applyCoverage(functions);
  const rows = executed.get(name) ?? new Map();
  for (const coverage of Object.values(converter.toIstanbul())) {
    for (const [id, statement] of Object.entries(coverage.statementMap)) {
      rows.set(statement.start.line, Boolean(rows.get(statement.start.line) || coverage.s[id] > 0));
    }
  }
  executed.set(name, rows);
}

const folders = (await readdir(artifact)).filter(name => /^repair-artifacts-\d+$/u.test(name));
let captures = 0;
for (const folder of folders) {
  for (const file of await discover(path.join(artifact, folder))) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    const entries = Array.isArray(value) ? value : value.result;
    if (!Array.isArray(entries)) { continue; }
    for (const entry of entries) { await add(entry); }
    captures++;
  }
}
const files = [];
for (const [name, lines] of Object.entries(changed)) {
  const source = (await readFile('/app/' + name, 'utf8')).split('\n');
  const measured = lines.filter(line => !/^\s*(?:$|[{};,]+$|\/\/|\/\*|\*|import\s)/u.test(source[line - 1] ?? ''));
  const covered = measured.filter(line => executed.get(name)?.get(line));
  files.push({file: name, changedLines: measured.length, covered: covered.length,
    uncovered: measured.filter(line => !covered.includes(line)), instrumented: executed.has(name)});
}
const report = {captures, changedLines: files.reduce((n, file) => n + file.changedLines, 0),
  covered: files.reduce((n, file) => n + file.covered, 0), files};
await writeFile(path.join(artifact, 'repair-coverage-summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({coverage: {captures: report.captures, changedLines: report.changedLines, covered: report.covered}}));
