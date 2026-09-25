import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url),v8toIstanbul=require('v8-to-istanbul'),{createCoverageMap}=require('istanbul-lib-coverage');
const dir=process.env.FIELD_SALES_ARTIFACT_DIR||'test-artifacts/field-sales/customer-quotes',coverage=createCoverageMap(JSON.parse(readFileSync(dir+'/coverage/coverage-final.json')));
for(const entry of JSON.parse(readFileSync(dir+'/browser-v8.json'))){
 const url=new URL(entry.url);if(!url.pathname.startsWith('/field-sales/')||!url.pathname.endsWith('.js')){continue;}
 const path=resolve('public'+url.pathname),converter=v8toIstanbul(path,0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);coverage.merge(converter.toIstanbul());
}
mkdirSync(dir+'/combined-coverage',{recursive:true});writeFileSync(dir+'/combined-coverage/coverage-final.json',JSON.stringify(coverage.toJSON()));
const files=JSON.parse(readFileSync(dir+'/source-files.json')),baseline=JSON.parse(readFileSync(dir+'/baseline-text.json'));
function changed(before,after){
 const a=before.split('\n'),b=after.split('\n'),dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--){for(let j=b.length-1;j>=0;j--){dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);}}
 let i=0,j=0;const lines=[];while(j<b.length){if(i<a.length&&a[i]===b[j]){i++;j++;}else if(i<a.length&&dp[i+1][j]>dp[i][j+1]){i++;}else{lines.push(++j);}}return lines;
}
const results=[];
for(const file of files.filter(f=>f.endsWith('.js'))){
 const path=resolve(file),source=readFileSync(file,'utf8'),data=coverage.data[path];
 if(!data){results.push({file,measured:false});continue;}
 const counts=data.getLineCoverage(),lines=changed(baseline[file]||'',source).filter(n=>Object.hasOwn(counts,n)&&source.split('\n')[n-1].trim()&&!source.split('\n')[n-1].trim().startsWith('//'));
 const missed=lines.filter(n=>!counts[n]);results.push({file,measured:true,changed:lines.length,covered:lines.length-missed.length,missed,branches:data.toSummary().branches});
}
const report={results,changed:results.reduce((n,r)=>n+(r.changed||0),0),covered:results.reduce((n,r)=>n+(r.covered||0),0),unmeasured:results.filter(r=>!r.measured).map(r=>r.file)};
writeFileSync(dir+'/changed-lines.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));

assert.equal(report.unmeasured.length,0,'Every changed JavaScript file must be measured.');
assert.equal(report.covered,report.changed,'Changed executable lines must be covered after merging backend and browser runs.');
