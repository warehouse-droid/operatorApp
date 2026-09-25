import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import v8ToIstanbul from 'v8-to-istanbul';
import coverage from 'istanbul-lib-coverage';
const root='test-artifacts/sor-rentals/';
const map=coverage.createCoverageMap(JSON.parse(readFileSync(root+'coverage/coverage-final.json')));
for(const directory of ['integration-coverage','flow-coverage','startup-coverage','cache-coverage']){
 if(existsSync(root+directory+'/coverage-final.json')){map.merge(JSON.parse(readFileSync(root+directory+'/coverage-final.json')));}
}
for(const file of ['driver-browser-coverage.json','admin-browser-coverage.json']){
 for(const entry of JSON.parse(readFileSync(root+file))){
  const url=new URL(entry.url);
  if(!url.pathname.endsWith('.js') || !entry.source){continue;}
  const converter=v8ToIstanbul('/app/public'+url.pathname,0,{source:entry.source});
  await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
 }
}
writeFileSync(root+'coverage/combined.json',JSON.stringify(map.toJSON()));
const lines={};
for(const file of map.files()){
 const entry=map.fileCoverageFor(file);
 lines[file.replace('/app/','')]={lines:entry.getLineCoverage(),summary:entry.toSummary().toJSON()};
}
writeFileSync(root+'coverage/lines.json',JSON.stringify(lines));
