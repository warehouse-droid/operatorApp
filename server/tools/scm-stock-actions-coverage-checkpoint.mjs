import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const out='test-artifacts/scm-stock-actions-20261006';
const files=JSON.parse(await readFile('tools/scm-stock-actions-files.json','utf8')).filter(file=>file.endsWith('.js'));
const gauntlet=JSON.parse(await readFile(out+'/gauntlet.json','utf8'));assert.ok(gauntlet.passed);
for(const [file,hash] of Object.entries(gauntlet.sourceHashes))assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash);
const map=coverage.createCoverageMap(JSON.parse(await readFile(out+'/coverage/coverage-final.json','utf8')));
const browsers=[...JSON.parse(await readFile('test-artifacts/stocking-replies-20261006/browser-coverage.json','utf8')),...JSON.parse(await readFile(out+'/browser-coverage.json','utf8')),...JSON.parse(await readFile('test-artifacts/stocking-replies-20261006/view-browser-coverage.json','utf8'))];
for(const entry of browsers){
  if(!entry.url.startsWith('http'))continue;
  const file='public/'+new URL(entry.url).pathname.split('/').pop();if(!files.includes(file))continue;
  const source=await readFile(file,'utf8');assert.equal(entry.source,source,file);
  const converter=v8ToIstanbul(resolve(file),0,{source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
}
const added=JSON.parse(await readFile('tools/scm-stock-actions-changed-lines.json','utf8'));
const lineReport={covered:0,total:0,uncovered:[],missingFiles:[],files:{}};
for(const file of files){
  const path=resolve(file);if(!map.files().includes(path)){lineReport.missingFiles.push(file);continue;}
  const executed=map.fileCoverageFor(path).getLineCoverage(),lines=added[file].filter(line=>Object.hasOwn(executed,line));
  const missing=lines.filter(line=>!executed[line]);lineReport.total+=lines.length;lineReport.covered+=lines.length-missing.length;
  lineReport.uncovered.push(...missing.map(line=>({file,line})));lineReport.files[file]={covered:lines.length-missing.length,total:lines.length};
}
await writeFile(`${out}/changed-line-coverage.json`,JSON.stringify(lineReport,null,2));

gauntlet.coverage=lineReport;gauntlet.coverageCollectedAt=new Date().toISOString();
await writeFile(out+'/gauntlet.json',JSON.stringify(gauntlet,null,2));
const final=JSON.parse(await readFile(out+'/final-validation.json','utf8'));
for(const [file,hash] of Object.entries(final.sourceHashes))assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash);
final.at=gauntlet.coverageCollectedAt;final.coverageCollectedAt=gauntlet.coverageCollectedAt;
await writeFile(out+'/final-validation.json',JSON.stringify(final,null,2));
console.log(JSON.stringify({passed:true,changedLinesCovered:lineReport.covered,changedLinesTotal:lineReport.total,sourceUnchanged:true}));
