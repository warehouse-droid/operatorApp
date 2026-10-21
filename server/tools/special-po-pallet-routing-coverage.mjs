import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';

const out='test-artifacts/special-po-pallet-routing';
const files=JSON.parse(readFileSync('tools/special-po-pallet-routing-files.json')).filter(file=>file.endsWith('.js'));
const measured=coverage.createCoverageMap(JSON.parse(readFileSync(out+'/coverage/coverage-final.json')));
for(const name of readdirSync(out+'/browser-final').filter(name=>name.startsWith('coverage-') || name.startsWith('browser-coverage-'))) {
  for(const entry of JSON.parse(readFileSync(out+'/browser-final/'+name))) {
    const file='public/'+new URL(entry.url).pathname.split('/').at(-1);
    if(!files.includes(file))continue;
    assert.equal(entry.source,readFileSync(file,'utf8'),'Browser source drift: '+file);
    const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});
    await converter.load();converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
  }
}
const report={total:0,covered:0,uncovered:[],files:{},branches:{total:0,covered:0,uncovered:[]}};
for(const file of files) {
  const old=out+'/before/'+file;
  const result=spawnSync('diff',['-U0',existsSync(old)?old:'/dev/null',file],{encoding:'utf8'});
  assert.ok([0,1].includes(result.status));
  const numbers=new Set();
  for(const match of result.stdout.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)) {
    for(let n=Number(match[1]);n<Number(match[1])+Number(match[2]??1);n++)numbers.add(n);
  }
  const data=measured.fileCoverageFor(resolve(file)),lines=data.getLineCoverage(),detail={covered:0,total:0};report.files[file]=detail;
  for(const n of numbers) {
    if(!Object.hasOwn(lines,n))continue;
    report.total++;detail.total++;
    if(lines[n]){report.covered++;detail.covered++;}else report.uncovered.push(file+':'+n);
  }
  for(const [key,branch] of Object.entries(data.branchMap)) {
    if(!numbers.has(branch.line))continue;
    for(const count of data.b[key]) {
      report.branches.total++;
      if(count)report.branches.covered++;else report.branches.uncovered.push(file+':'+branch.line);
    }
  }
}
writeFileSync(out+'/changed-lines.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
assert.deepEqual(report.uncovered,[],'Changed lines require meaningful coverage');
