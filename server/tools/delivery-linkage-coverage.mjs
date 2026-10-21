import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const diffs=JSON.parse(readFileSync('test-artifacts/changed-lines-input.json'));
const measured=coverage.createCoverageMap(JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json')));
for(const name of readdirSync('test-artifacts/delivery-requests-ui').filter(file=>file.startsWith('browser-coverage-'))) {
  for(const entry of JSON.parse(readFileSync(`test-artifacts/delivery-requests-ui/${name}`))) {
    const file='public/'+new URL(entry.url).pathname.split('/').at(-1);
    if(!diffs[file]) {continue;}
    assert.equal(entry.source,readFileSync(file,'utf8'),`Browser source drift: ${file}`);
    const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});
    await converter.load();converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
  }
}
const report={total:0,covered:0,uncovered:[],files:{},branches:{total:0,covered:0},static:[]};
for(const [file,diff] of Object.entries(diffs)) {
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),diff.sourceHash,`Source drift: ${file}`);
  if(!file.endsWith('.js') || file==='public/app-sidebar.js') {report.static.push({file,reason:'Styles/HTML and asset version checked by browser and syntax checks.'});continue;}
  const data=measured.fileCoverageFor(resolve(file)),lines=data.getLineCoverage(),detail={covered:0,total:0};report.files[file]=detail;
  for(const number of diff.lines) {
    if(!Object.hasOwn(lines,number)) {continue;}
    report.total++;detail.total++;
    if(lines[number]) {report.covered++;detail.covered++;} else {report.uncovered.push(`${file}:${number}`);}
  }
  for(const [key,branch] of Object.entries(data.branchMap)) {
    if(!diff.lines.includes(branch.line)) {continue;}
    for(const count of data.b[key]) {report.branches.total++;if(count) {report.branches.covered++;}}
  }
}
writeFileSync('test-artifacts/changed-lines.json',JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(report)+'\n');assert.deepEqual(report.uncovered,[],'Changed lines need meaningful execution');
