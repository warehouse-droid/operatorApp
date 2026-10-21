import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import coverageLibrary from 'istanbul-lib-coverage';
const out='test-artifacts/unified-stock-status';
const runtime=JSON.parse(readFileSync('tools/unified-stock-status-files.json','utf8')).filter(file=>file.endsWith('.js'));
const map=coverageLibrary.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`,'utf8')));
const report=[];
for(const file of runtime){
  const baseline=`${out}/before/${file}`,changed=new Set();
  if(existsSync(baseline)){
    const diff=spawnSync('diff',['-U0',baseline,file],{encoding:'utf8'});
    assert([0,1].includes(diff.status));
    for(const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm))for(let i=0;i<Number(match[2]??1);i++)changed.add(Number(match[1])+i);
  }else readFileSync(file,'utf8').split('\n').forEach((_,i)=>changed.add(i+1));
  if(!changed.size)continue;
  const path='/app/'+file;
  if(!map.files().includes(path)){report.push({file,missingCoverage:true});continue;}
  const coverage=map.fileCoverageFor(path),lines=coverage.getLineCoverage();
  const executable=[...changed].filter(line=>line in lines),uncovered=executable.filter(line=>!lines[line]);
  report.push({file,changedExecutable:executable.length,covered:executable.length-uncovered.length,uncovered,branches:coverage.toSummary().branches});
}
writeFileSync(`${out}/changed-line-coverage.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({files:report.length,changedExecutable:report.reduce((n,r)=>n+(r.changedExecutable||0),0),covered:report.reduce((n,r)=>n+(r.covered||0),0),gaps:report.filter(r=>r.missingCoverage||r.uncovered.length)}));
