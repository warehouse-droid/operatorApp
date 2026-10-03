import fs from 'node:fs/promises';
import path from 'node:path';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const directory='test-artifacts/boss-approvals';
const map=coverage.createCoverageMap(JSON.parse(await fs.readFile(`${directory}/coverage/coverage-final.json`,'utf8')));
const changed=JSON.parse(await fs.readFile('/workspace/test-artifacts/boss-approvals/changed-lines.json','utf8'));
for(const name of (await fs.readdir(`${directory}/browser`)).filter(file=>file.endsWith('-coverage.json'))){
 for(const entry of JSON.parse(await fs.readFile(`${directory}/browser/${name}`,'utf8'))){
  const file='public/'+new URL(entry.url).pathname.split('/').pop();if(!changed[file]){continue;}
  // Chromium can retain a script ID across navigation without retaining its
  // source. Only merge entries with actual source, verifying those bytes exactly.
  if(!entry.source){continue;}
  const source=await fs.readFile(file,'utf8');if(entry.source!==source){throw new Error('Stale browser coverage: '+file);}
  const converter=v8ToIstanbul(path.resolve(file),0,{source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
 }
}
const result={covered:0,total:0,files:{},uncovered:[],unmeasured:[]};
for(const [file,numbers] of Object.entries(changed)){
 const absolute=path.resolve(file);if(!map.files().includes(absolute)){result.unmeasured.push(file);continue;}
 const measured=map.fileCoverageFor(absolute).getLineCoverage();const count={covered:0,total:0};result.files[file]=count;
 for(const line of numbers){if(!Object.hasOwn(measured,line)){continue;}count.total++;result.total++;if(measured[line]>0){count.covered++;result.covered++;}else{result.uncovered.push(`${file}:${line}`);}}
}
await fs.writeFile(`${directory}/changed-coverage.json`,JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result,null,2)+'\n');
