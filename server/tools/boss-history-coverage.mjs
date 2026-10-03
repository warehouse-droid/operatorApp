import fs from 'node:fs/promises';
import path from 'node:path';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
const directory='test-artifacts/boss-search-history-20261003';
const map=coverage.createCoverageMap(JSON.parse(await fs.readFile(`${directory}/coverage/coverage-final.json`,'utf8')));
const changed=JSON.parse(await fs.readFile('/workspace/'+directory+'/changed-lines.json','utf8'));
for(const folder of [directory+'/browser','test-artifacts/boss-approvals/browser']){
 for(const name of (await fs.readdir(folder)).filter(f=>f.endsWith('-coverage.json'))){
  for(const entry of JSON.parse(await fs.readFile(folder+'/'+name,'utf8'))){
   if(!entry.source||!entry.url.startsWith('http')){continue;}
   const file='public'+new URL(entry.url).pathname;if(!changed[file]){continue;}
   const source=await fs.readFile(file,'utf8');if(source!==entry.source){throw new Error('Stale browser source '+file);}
   const converter=v8ToIstanbul(path.resolve(file),0,{source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
  }
 }
}
const result={covered:0,total:0,files:{},uncovered:[],unmeasured:[]};
for(const [file,lines] of Object.entries(changed)){
 if(!file.endsWith('.js')){continue;}
 const absolute=path.resolve(file);if(!map.files().includes(absolute)){result.unmeasured.push(file);continue;}
 const counts=map.fileCoverageFor(absolute).getLineCoverage(),row={covered:0,total:0};result.files[file]=row;
 for(const line of lines){if(!Object.hasOwn(counts,line)){continue;}row.total++;result.total++;if(counts[line]>0){row.covered++;result.covered++;}else{result.uncovered.push(file+':'+line);}}
}
await fs.writeFile(directory+'/changed-coverage.json',JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result,null,2)+'\n');
