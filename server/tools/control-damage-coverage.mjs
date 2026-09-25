import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import v8ToIstanbul from 'v8-to-istanbul';
import coverageLibrary from 'istanbul-lib-coverage';
const root='test-artifacts/control-damage';
const map=coverageLibrary.createCoverageMap(JSON.parse(readFileSync(`${root}/coverage/coverage-final.json`,'utf8')));
const browserFiles=readdirSync(root).filter(name=>/^browser-.*\.json$/.test(name)).map(name=>root+'/'+name);
if(existsSync('test-artifacts/operator-inventory-browser-coverage.json')) browserFiles.push('test-artifacts/operator-inventory-browser-coverage.json');
for(const file of browserFiles) for(const entry of JSON.parse(readFileSync(file,'utf8'))) {
 let pathname;try{pathname=new URL(entry.url).pathname;}catch{continue;}
 const local='public'+pathname;if(!existsSync(local) || !local.endsWith('.js')) continue;
 if(entry.source!==readFileSync(local,'utf8')) continue;
 const converter=v8ToIstanbul('/app/'+local,0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
}
const changes=JSON.parse(readFileSync('test/support/control-damage-changed-lines.json','utf8'));
const results=[],missed=[],assetOnly=[];
for(const [file,definition] of Object.entries(changes)) {
 const hash=createHash('sha256').update(readFileSync(file)).digest('hex');
 const change=(definition.variants || [definition]).find(entry=>entry.sha256===hash);
 assert.ok(change,'Coverage source changed: '+file);
 if(change.assetOnly) {assetOnly.push({file,reason:'Only cache name and asset version strings changed; verified by release asset hashes.'});continue;}
 const covered=map.data['/app/'+file]?.getLineCoverage() || {};
 const executable=change.lines.filter(line=>covered[line]!==undefined);
 const missing=executable.filter(line=>covered[line]===0);
 if(!Object.keys(covered).length) missed.push({file,reason:'No instrumented execution'});
 if(missing.length) missed.push({file,lines:missing});
 results.push({file,changedLines:change.lines.length,executable:executable.length,covered:executable.length-missing.length});
}
const result={results,assetOnly,missed};writeFileSync(`${root}/changed-coverage.json`,JSON.stringify(result,null,2));
writeFileSync(`${root}/merged-coverage.json`,JSON.stringify(map.toJSON()));console.log(JSON.stringify(result));
assert.deepEqual(missed,[],'Changed executable lines need coverage');
