import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { added } from './child-location-files.mjs';
import { scanUnifiedDiff, scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';
const root = 'test-artifacts/child-locations';
const read = name => JSON.parse(readFileSync(`${root}/${name}`, 'utf8'));
const manifest = JSON.parse(readFileSync('/release/manifest.json', 'utf8'));
const comparison = read('full-comparison.json');
assert.deepEqual(comparison.newFailures, []);
const before = read('static-live-baseline.json'), after = read('static-live-candidate.json');
function extra(values, baseline) {
  const remaining = [...baseline];
  return values.filter(value => { const index = remaining.indexOf(value); if (index < 0) { return true; } remaining.splice(index,1); return false; });
}
const lintKey = item => JSON.stringify([item.file,item.ruleId,item.message]);
const typeKey = value => value.replace(/\(\d+,\d+\)/g, '');
const staticResult = { newLint: extra(after.lint.map(lintKey),before.lint.map(lintKey)), newTypes: extra(after.types.map(typeKey),before.types.map(typeKey)),
  baselineLint: before.lint.length, currentLint: after.lint.length, baselineTypes: before.types.length, currentTypes: after.types.length };
assert.deepEqual(staticResult.newLint, []); assert.deepEqual(staticResult.newTypes, []);
writeFileSync(`${root}/static-live-comparison.json`, JSON.stringify(staticResult,null,2));
const mutations = read('mutations.json');
assert.equal(mutations.filter(result => result.layer === 'unit' && result.killed).length,8);
assert.equal(mutations.filter(result => result.layer === 'property' && result.killed).length,5);
assert.equal(mutations.filter(result => result.layer === 'http' && result.killed).length,2);
const coverage = read('coverage/coverage-summary.json');
const newCodeCoverage = Object.fromEntries(added.filter(file => file.endsWith('.js')).map(file => {
  const result = coverage['/app/' + file];
  assert.ok(result, file); assert.equal(result.lines.pct,100,file);
  return [file, { lines: result.lines, branches: result.branches }];
}));
const focused = readFileSync('test-artifacts/child-location-candidate-focused-final.log','utf8');
assert.match(focused,/Isolated Child location focused run passed: 31 file\(s\), 212 test\(s\)\./);
const browser = readFileSync('test-artifacts/child-location-browser.log','utf8');
assert.match(browser,/PASS: settings, pixel\/colour rendering, reset, account sync\/isolation, failure recovery, keypad\/scanner events, responsive layouts, and driver units\./);
assert.equal(read('browser/fulfillment-parts.json').passed, true);
const secretFindings = scanUnifiedDiff(readFileSync('/release/release.patch','utf8'));
for (const file of added) { secretFindings.push(...scanTextForSecrets(readFileSync(file,'utf8'),file)); }
assert.deepEqual(secretFindings, []);
const sources = Object.fromEntries(Object.keys(manifest.after).map(file => [file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
assert.deepEqual(sources,manifest.after);
const result = { passed: true, imageId: manifest.candidateImageId, sources, at: new Date().toISOString(),
  fullRegression: { existingFailures: comparison.currentFailures.length, newFailures: 0 }, focusedTests: 212,
  mutationChecks: mutations.length, newCodeCoverage, staticResult, secretFindings, browser: 'passed', versions: after.versions };
writeFileSync(`${root}/verified.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({ passed: true, imageId: result.imageId, focusedTests: 212, mutationChecks: mutations.length, existingFailures: comparison.currentFailures.length, newFailures: 0 }));
