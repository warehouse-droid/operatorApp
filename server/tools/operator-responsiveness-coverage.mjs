import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const root='test-artifacts/sor-rentals';
const map=coverage.createCoverageMap(JSON.parse(readFileSync(`${root}/responsiveness-coverage/coverage-final.json`)));
for(const file of readdirSync(`${root}/responsiveness-browser`).filter(name=>name.endsWith('.coverage.json'))){
 for(const entry of JSON.parse(readFileSync(`${root}/responsiveness-browser/${file}`))){
  if(!entry.source||new URL(entry.url).pathname!=='/operator.js')continue;
  const converter=v8ToIstanbul('/app/public/operator.js',0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
 }
}
const changes=JSON.parse(readFileSync(`${root}/responsiveness-changed-lines.json`));
const files=Object.entries(changes).map(([file,lines])=>{
 const counts=map.fileCoverageFor('/app/'+file).getLineCoverage();
 return {file,changedExecutableLines:lines.length,covered:lines.filter(line=>counts[line]>0).length,missing:lines.filter(line=>!(counts[line]>0))};
});
const report={files,covered:files.reduce((sum,file)=>sum+file.covered,0),total:files.reduce((sum,file)=>sum+file.changedExecutableLines,0)};
writeFileSync(`${root}/responsiveness-changed-coverage.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(report.covered!==report.total)process.exitCode=1;
