import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const out='test-artifacts/regular-waitlist',diffs=JSON.parse(readFileSync(out+'/changed-diffs.json')),measured=coverage.createCoverageMap(JSON.parse(readFileSync(out+'/coverage/coverage-final.json')));
for(const name of readdirSync(out+'/browser').filter(name=>name.endsWith('-coverage.json'))){
  for(const entry of JSON.parse(readFileSync(out+'/browser/'+name))){
    const file='public/'+new URL(entry.url).pathname.split('/').at(-1);if(!diffs.files[file])continue;
    assert.equal(entry.source,readFileSync(file,'utf8'),'Browser source drift: '+file);
    const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
  }
}
const result={total:0,covered:0,uncovered:[],files:{},branches:{total:0,covered:0}};
for(const [file,comparison] of Object.entries(diffs.files)){
  const numbers=new Set();for(const match of comparison.diff.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm))for(let n=Number(match[1]);n<Number(match[1])+Number(match[2]??1);n++)numbers.add(n);
  const path=resolve(file),data=measured.files().includes(path)?measured.fileCoverageFor(path):null,lines=data?.getLineCoverage()||{};const detail={total:0,covered:0};result.files[file]=detail;
  for(const n of numbers){if(!Object.hasOwn(lines,n))continue;result.total++;detail.total++;if(lines[n]){result.covered++;detail.covered++;}else result.uncovered.push(file+':'+n);}
  if(data)for(const [key,branch] of Object.entries(data.branchMap)){if(!numbers.has(branch.line))continue;for(const count of data.b[key]){result.branches.total++;if(count)result.branches.covered++;}}
  if(!data&&numbers.size&&existsSync(file))result.uncovered.push(file+':not instrumented');
}
writeFileSync(out+'/changed-lines.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
if(!process.argv.includes('--inspect'))assert.deepEqual(result.uncovered,[],'Changed lines need meaningful coverage');
