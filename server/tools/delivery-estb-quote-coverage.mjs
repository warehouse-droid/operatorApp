import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const files=['src/delivery-request-documents.js','public/delivery-requests.js','src/netsuite-order-pdf.js','src/netsuite.js',
  'netsuite-smart-scm-picking-ticket-restlet.js','netsuite-transaction-pdf-suitelet.js'];
const measured=coverage.createCoverageMap(JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json')));
for(const name of readdirSync('test-artifacts/delivery-requests-ui').filter(file=>file.includes('coverage-') && file.endsWith('.json'))) {
  for(const entry of JSON.parse(readFileSync(`test-artifacts/delivery-requests-ui/${name}`))) {
    if(!entry.url) {continue;}
    const file='public/'+new URL(entry.url).pathname.split('/').at(-1);
    if(!files.includes(file)) {continue;}
    assert.equal(entry.source,readFileSync(file,'utf8'),`Browser source drift: ${file}`);
    const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});await converter.load();
    converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
  }
}
const report={covered:0,total:0,uncovered:[],files:{}};
for(const file of files) {
  let changed=[];
  if(existsSync('/baseline/'+file)) {
    const diff=spawnSync('diff',['-U0','/baseline/'+file,file],{encoding:'utf8'});
    assert.ok([0,1].includes(diff.status),diff.stderr);
    for(const hunk of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
      const start=Number(hunk[1]),count=hunk[2]===undefined?1:Number(hunk[2]);
      for(let index=0;index<count;index++) {changed.push(start+index);}
    }
  } else {changed=readFileSync(file,'utf8').split('\n').map((_,index)=>index+1);}
  const lines=measured.fileCoverageFor(resolve(file)).getLineCoverage(),detail={covered:0,total:0};report.files[file]=detail;
  for(const line of changed) {
    if(!Object.hasOwn(lines,line)) {continue;}
    report.total++;detail.total++;
    if(lines[line]) {report.covered++;detail.covered++;} else {report.uncovered.push(`${file}:${line}`);}
  }
}
writeFileSync('test-artifacts/changed-lines.json',JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(report)+'\n');assert.deepEqual(report.uncovered,[]);
