import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import v8ToIstanbul from 'v8-to-istanbul';

const mode = process.argv.at(-1);
const result = spawnSync(process.execPath, ['--test',
  'test/dispatch/frontend/split-quantity-validation.browser.test.mjs'],
{ encoding: 'utf8', timeout: 120000 });
writeFileSync(`test-artifacts/split-quantity-20261020/${mode}.log`, result.stdout + result.stderr);
console.log((result.stdout + result.stderr).slice(-4000));
if (mode === 'browser-red') assert.notEqual(result.status, 0);
else assert.equal(result.status, 0);
if (mode === 'browser') {
  const coverage = JSON.parse(readFileSync('test-artifacts/split-quantity-20261020/browser/coverage.json', 'utf8'));
  const converted = {};
  for (const entry of coverage.result) {
    assert.equal(entry.source, readFileSync('public/dispatch.js', 'utf8'));
    const converter = v8ToIstanbul('/app/public/dispatch.js', 0, { source: entry.source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    Object.assign(converted, converter.toIstanbul());
  }
  writeFileSync('test-artifacts/split-quantity-20261020/browser/coverage-istanbul.json', JSON.stringify(converted));
}
