import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import v8ToIstanbul from 'v8-to-istanbul';
import library from 'istanbul-lib-coverage';
const out='test-artifacts/damage-posting-retry-20261001';
const map=library.createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`)));
const browserFiles=readdirSync(out).filter(name=>/^browser-.*\.json$/.test(name)).map(file=>`${out}/${file}`);
for(const name of ['operator-inventory-browser-coverage.json','control-damage-browser-coverage.json']) {if(existsSync('test-artifacts/'+name))browserFiles.push('test-artifacts/'+name);}
for(const directory of ['test-artifacts/control-damage','test-artifacts/damage-photos-20261001']) {if(existsSync(directory)) {for(const name of readdirSync(directory).filter(name=>/^browser-.*\.json$/.test(name)))browserFiles.push(directory+'/'+name);}}
for(const file of browserFiles) {
  for(const entry of JSON.parse(readFileSync(file))) {
    let pathname;try {pathname=new URL(entry.url).pathname;}catch {continue;}
    const local='public'+pathname;if(!existsSync(local) || !local.endsWith('.js') || entry.source!==readFileSync(local,'utf8')) {continue;}
    const converter=v8ToIstanbul(resolve(local),0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
  }
}
const changed=JSON.parse(readFileSync(`${out}/changed-lines.json`)),results=[],missed=[];
for(const [file,definition] of Object.entries(changed)) {
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),definition.sha256,'Coverage source changed: '+file);
  const coverage=map.data[resolve(file)]?.getLineCoverage() || {};
  const executable=definition.lines.filter(line=>coverage[line]!==undefined);
  const missing=executable.filter(line=>coverage[line]===0);
  if(!Object.keys(coverage).length) {missed.push({file,reason:'No instrumented execution'});}
  if(missing.length) {missed.push({file,lines:missing});}
  results.push({file,changed:definition.lines.length,executable:executable.length,covered:executable.length-missing.length});
}
const result={results,missed};writeFileSync(`${out}/changed-coverage.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));assert.deepEqual(missed,[],'Changed executable lines need coverage');
