import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const sources=JSON.parse(await fs.readFile('tools/delivery-expiry-sources.json','utf8'));
const map=coverage.createCoverageMap(JSON.parse(await fs.readFile('test-artifacts/coverage/coverage-final.json','utf8')));
for(const directory of ['test-artifacts','test-artifacts/delivery-requests-ui']) {
  const files=(await fs.readdir(directory)).filter(name=>/^(?:expiry-browser-|browser-coverage-).*\.json$/.test(name));
  for(const file of files) {
    for(const entry of JSON.parse(await fs.readFile(path.join(directory,file),'utf8'))) {
      if(!entry.source || !entry.url.startsWith('http')) {continue;}
      const target='public'+new URL(entry.url).pathname;if(!sources[target]) {continue;}
      if(entry.source!==await fs.readFile(target,'utf8')) {throw new Error('Stale coverage for '+target);}
      const converter=v8ToIstanbul(path.resolve(target),0,{source:entry.source});
      await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
    }
  }
}
const result={covered:0,total:0,uncovered:[],unmeasured:[],files:{}};
for(const [file,snapshot] of Object.entries(sources)) {
  if(createHash('sha256').update(await fs.readFile(file)).digest('hex')!==snapshot.sha256) {throw new Error('Source changed during verification: '+file);}
  if(!file.endsWith('.js')) {continue;}
  const absolute=path.resolve(file);
  if(!map.files().includes(absolute)) {result.unmeasured.push(file);continue;}
  const counts=map.fileCoverageFor(absolute).getLineCoverage(),row={covered:0,total:0};result.files[file]=row;
  for(const line of snapshot.lines) {
    if(!Object.hasOwn(counts,line)) {continue;}
    result.total++;row.total++;
    if(counts[line]>0) {result.covered++;row.covered++;}else {result.uncovered.push(file+':'+line);}
  }
}
await fs.writeFile('test-artifacts/changed-coverage.json',JSON.stringify(result,null,2)+'\n');
const versions={node:process.version};
for(const name of ['typescript','eslint','fast-check','c8','@playwright/test']) {versions[name]=JSON.parse(await fs.readFile(`node_modules/${name}/package.json`,'utf8')).version;}
await fs.writeFile('test-artifacts/versions.json',JSON.stringify(versions,null,2)+'\n');
await fs.copyFile('tools/delivery-expiry-sources.json','test-artifacts/source-hashes.json');
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(result.unmeasured.length) {process.exitCode=1;}
