import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import v8ToIstanbul from 'v8-to-istanbul';
import coverage from 'istanbul-lib-coverage';

const out='test-artifacts/special-status-following-20261005';
const publicFiles=Object.keys(JSON.parse(readFileSync(out+'/summary.json')).manifest).filter(name=>name.startsWith('public/'));
const measured=coverage.createCoverageMap({});
for(const name of readdirSync(out).filter(name=>/^browser-coverage-.+\.json$/.test(name))) {
 for(const entry of JSON.parse(readFileSync(out+'/'+name))) {
  const file='public'+new URL(entry.url).pathname;
  if(!publicFiles.includes(file))continue;
  assert.equal(entry.source,readFileSync(file,'utf8'),'Browser coverage source changed: '+file);
  const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});
  await converter.load();converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
 }
}
assert.deepEqual(measured.files().map(file=>file.replace('/app/','')).sort(),publicFiles.sort());
mkdirSync(out+'/browser-coverage',{recursive:true});
writeFileSync(out+'/browser-coverage/coverage-final.json',JSON.stringify(measured.toJSON()));
console.log(JSON.stringify({browserCoverageFiles:measured.files().length}));
