import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const artifact='test-artifacts/load-followup',file=process.argv[2]||'public/operator.js';
const source=fs.readFileSync(file,'utf8'),hash=crypto.createHash('sha256').update(source).digest('hex');
assert.equal(JSON.parse(fs.readFileSync(`${artifact}/browser.json`)).sourceHashes['public/operator.js'],hash);
const entries=JSON.parse(fs.readFileSync(`${artifact}/browser-coverage.json`)).filter(row=>new URL(row.url).pathname==='/operator.js');
const changed=new Set();
const diff=spawnSync('diff',['-U0',`${artifact}/live-before/public/operator.js`,file],{encoding:'utf8'}).stdout;
for(const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm))for(let i=0;i<Number(match[2]??1);i++)changed.add(Number(match[1])+i);
const covered=(begin,end)=>entries.some(entry=>{
 const ranges=entry.functions.flatMap(fn=>fn.ranges).filter(range=>range.startOffset<=begin&&range.endOffset>=end).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset));
 return ranges[0]?.count>0;
});
let offset=0;const executed=[],missing=[];
for(const [i,line]of source.split('\n').entries()){
 if(changed.has(i+1)&&line.trim()&&!/^\s*(?:\/\/|[{}()[\];,]+\s*$)/.test(line)){
  (covered(offset+line.search(/\S/),offset+line.trimEnd().length)?executed:missing).push({line:i+1,source:line.trim()});
 }
 offset+=line.length+1;
}
const report={sourceHash:hash,executed:executed.length,missing};
fs.writeFileSync(`${artifact}/browser-changed-coverage.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
