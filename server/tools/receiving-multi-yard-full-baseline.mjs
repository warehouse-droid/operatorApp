import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [prefixPath, remainderPath] = process.argv.slice(2);
assert.ok(prefixPath && remainderPath, 'Provide the baseline prefix and completed remainder logs.');
const prefix = readFileSync(prefixPath, 'utf8');
const remainder = readFileSync(remainderPath, 'utf8');
const originalEnd = [...prefix.matchAll(/MBT main (\d+)\/(\d+)/g)].at(-1);
const remainderEnd = [...remainder.matchAll(/MBT baseline remainder (\d+)\/(\d+)/g)].at(-1);
assert.ok(originalEnd && remainderEnd, 'Both baseline runs must record their file positions.');
assert.match(remainder, /^Isolated MBT baseline remainder run (?:failed in|passed:)/m,
  'The baseline runner must record its completion summary.');
assert.equal(remainderEnd[1], remainderEnd[2], 'The resumed baseline must finish every remaining file.');
assert.equal(Number(originalEnd[1]) - 1 + Number(remainderEnd[2]), Number(originalEnd[2]));
const output = prefix + '\n' + remainder;
const unique = pattern => [...new Set([...output.matchAll(pattern)].map(match => match[1]))];
const sum = key => [...output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, 'gm'))]
  .reduce((total, row) => total + Number(row[1]), 0);
const result = {
  source: 'Original deployed application before the receiving fix; the later live rebase includes unrelated stock-purchase changes.',
  files: Number(originalEnd[2]),
  passed: sum('pass'), failed: sum('fail'),
  failures: unique(/^✖ (.+?) \([\d.]+ms\)/gm),
  deadlines: unique(/^TEST_FILE_DEADLINE (.+)$/gm),
  logs: [prefixPath, remainderPath].map((file, index) => ({
    file, sha256: createHash('sha256').update(index === 0 ? prefix : remainder).digest('hex')
  }))
};
writeFileSync('test/receiving-multi-yard-full-baseline.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({files: result.files, passed: result.passed, failed: result.failed,
  failures: result.failures.length, deadlines: result.deadlines.length}));
