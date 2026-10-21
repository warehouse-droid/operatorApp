import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import coverage from 'istanbul-lib-coverage';
const out='test-artifacts/special-local-closure';
const measured=coverage.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
const report={covered:0,total:0,uncovered:[],files:{},branches:{covered:0,total:0,uncovered:[]}};
let file;const changed=new Map();
for(const line of readFileSync(`${out}/runtime.diff`,'utf8').split('\n')) {
  if(line.startsWith('+++ b/'))file=line.slice(6);
  const hunk=/^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);if(!hunk)continue;
  const numbers=changed.get(file)||new Set();changed.set(file,numbers);
  for(let n=Number(hunk[1]);n<Number(hunk[1])+Number(hunk[2]??1);n++)numbers.add(n);
}
for(const [file,numbers] of changed) {
  assert.ok(measured.files().includes(resolve(file)),`Missing coverage: ${file}`);
  const entry=measured.fileCoverageFor(resolve(file)),lines=entry.getLineCoverage(),detail={covered:0,total:0};report.files[file]=detail;
  for(const n of numbers) {
    if(!Object.hasOwn(lines,n))continue;
    report.total++;detail.total++;
    if(lines[n]){report.covered++;detail.covered++;}else report.uncovered.push(`${file}:${n}`);
  }
  for(const [key,branch] of Object.entries(entry.branchMap)) {
    if(!numbers.has(branch.line))continue;
    for(const count of entry.b[key]) {
      report.branches.total++;
      if(count)report.branches.covered++;else report.branches.uncovered.push(`${file}:${branch.line}`);
    }
  }
}
writeFileSync(`${out}/changed-lines.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
assert.deepEqual(report.uncovered,[],'Changed executable lines require meaningful coverage');
