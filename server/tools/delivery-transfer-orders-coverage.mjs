import fs from 'node:fs/promises';
import path from 'node:path';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const map=coverage.createCoverageMap(JSON.parse(await fs.readFile('test-artifacts/delivery-requests/coverage/coverage-final.json','utf8')));
const changed=JSON.parse(await fs.readFile('test-artifacts/changed-lines.json','utf8'));
for(const name of (await fs.readdir('test-artifacts/delivery-requests-ui')).filter(name=>name.includes('coverage') && name.endsWith('.json'))) {
  for(const entry of JSON.parse(await fs.readFile('test-artifacts/delivery-requests-ui/'+name,'utf8'))) {
    if(!entry.source || !entry.url.startsWith('http')) {continue;}
    const file='public'+new URL(entry.url).pathname;if(!changed[file]) {continue;}
    const source=await fs.readFile(file,'utf8');if(source!==entry.source) {throw new Error('Stale browser coverage: '+file);}
    const converter=v8ToIstanbul(path.resolve(file),0,{source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
  }
}
const result={covered:0,total:0,files:{},uncovered:[],unmeasured:[],nonExecutable:[]};
for(const [file,lines] of Object.entries(changed)) {
  if(!file.endsWith('.js')) {continue;}
  const absolute=path.resolve(file);if(!map.files().includes(absolute)) {result.unmeasured.push(file);continue;}
  const counts=map.fileCoverageFor(absolute).getLineCoverage(),row={covered:0,total:0};result.files[file]=row;
  for(const line of lines) {
    if(!Object.hasOwn(counts,line)) {result.nonExecutable.push(file+':'+line);continue;}
    row.total++;result.total++;
    if(counts[line]>0) {row.covered++;result.covered++;} else {result.uncovered.push(file+':'+line);}
  }
}
await fs.writeFile('test-artifacts/changed-coverage.json',JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(result.uncovered.length || result.unmeasured.length) {process.exitCode=1;}
