import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import coverageLibrary from 'istanbul-lib-coverage';
const out='test-artifacts/already-ordered-arrival-20261020';
const runtime=JSON.parse(readFileSync('tools/already-ordered-arrival-files.json','utf8')).filter(file=>file.endsWith('.js'));
const map=coverageLibrary.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`,'utf8')));
const report=[];
const located=JSON.parse(readFileSync(`${out}/changed-lines.json`,'utf8'));
for(const file of runtime){
  assert(Array.isArray(located.files[file]));
  const changed=new Set(located.files[file]);
  if(!changed.size)continue;
  const path='/app/'+file;
  if(!map.files().includes(path)){report.push({file,missingCoverage:true});continue;}
  const coverage=map.fileCoverageFor(path),lines=coverage.getLineCoverage();
  const executable=[...changed].filter(line=>line in lines),uncovered=executable.filter(line=>!lines[line]);
  report.push({file,changedExecutable:executable.length,covered:executable.length-uncovered.length,uncovered,branches:coverage.toSummary().branches});
}
writeFileSync(`${out}/changed-line-coverage.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({files:report.length,changedExecutable:report.reduce((n,r)=>n+(r.changedExecutable||0),0),covered:report.reduce((n,r)=>n+(r.covered||0),0),gaps:report.filter(r=>r.missingCoverage||r.uncovered.length)}));
