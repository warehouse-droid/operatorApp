import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import coverage from 'istanbul-lib-coverage';
import { parse } from 'espree';

const map = coverage.createCoverageMap(JSON.parse(readFileSync('test-artifacts/source-save/coverage/coverage-final.json')));
// Frontend race tests extract declarations into VM contexts. Their padded source
// locations cannot provide trustworthy whole-file coverage. Browser behavior and
// mutation results cover that layer; report instrumentation only for real modules.
const names = new Set(['getDispatchSourceReviewPayload', 'dispatchSourceRefreshBaseline', 'orderStructure']);
const results = [];
for (const file of map.files()) {
  const lines = map.fileCoverageFor(file).getLineCoverage();
  const nodes = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: file.endsWith('public/dispatch.js') ? 'script' : 'module', loc: true }).body;
  for (const node of nodes) {
    const fn = node.declaration || node;
    if (fn.type !== 'FunctionDeclaration' || !names.has(fn.id.name)) {continue;}
    const executable = Object.entries(lines).filter(([line]) => Number(line) >= fn.loc.start.line && Number(line) <= fn.loc.end.line);
    results.push({ function: fn.id.name, covered: executable.filter(([, hits]) => hits > 0).length, executable: executable.length,
      uncovered: executable.filter(([, hits]) => hits === 0).map(([line]) => Number(line)) });
  }
}
assert.equal(results.length, names.size);
for (const result of results) {assert.equal(result.covered, result.executable, `${result.function} has unexecuted lines`);}
const files = map.files().map(file => ({ file, ...map.fileCoverageFor(file).toSummary().toJSON() }));
const verifier = files.find(file => file.file.endsWith('/dispatch-source-refresh.js'));
assert.equal(verifier.branches.pct, 100, 'the new archive verifier must exercise every branch');
console.log(JSON.stringify({ coverage: results, files, frontendCoverage: 'not claimed: VM extraction cannot establish line completeness' }));
