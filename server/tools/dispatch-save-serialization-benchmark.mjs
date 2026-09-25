import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import { parse } from 'espree';

const file = 'src/dispatch-planner-performance.js';
const source = await readFile(file, 'utf8');
const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true }).body
  .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'stableValue');
const existing = vm.runInNewContext(`${source.slice(...declaration.range)}; stableValue`, { Date });
function candidate(value) {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(candidate);
  if (!value || typeof value !== 'object') return value;
  const ordered = Object.create(null);
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    if (value[key] !== undefined) ordered[key] = candidate(value[key]);
  }
  return ordered;
}
const input = createReadStream('test-artifacts/dispatch-save-reliability/private-history/dispatch_plan_commands.jsonl.gz').pipe(createGunzip());
const records = [];
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  records.push(JSON.parse(line));
  if (records.length === 25) break;
}
const samples = [];
for (const value of records) {
  const start = performance.now();
  const before = JSON.stringify(existing(value));
  const middle = performance.now();
  const after = JSON.stringify(candidate(value));
  samples.push({ existing: middle - start, candidate: performance.now() - middle, bytes: before.length });
  assert.equal(after, before, 'Canonical bytes must remain identical');
}
await writeFile('test-artifacts/dispatch-save-reliability/serialization-benchmark.json', JSON.stringify(samples));
console.log(JSON.stringify({ samples: samples.length, existingMs: samples.reduce((n, s) => n + s.existing, 0),
  candidateMs: samples.reduce((n, s) => n + s.candidate, 0), equal: true }));
