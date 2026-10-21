import fs from 'node:fs/promises';
import v8ToIstanbul from 'v8-to-istanbul';
import coverage from 'istanbul-lib-coverage';
const root=process.argv[2];
const map=coverage.createCoverageMap(JSON.parse(await fs.readFile(`${root}/coverage/coverage-final.json`,'utf8')));
for(const file of await fs.readdir(`${root}/browser`)) {
 if(!file.endsWith('.json'))continue;
 for(const entry of JSON.parse(await fs.readFile(`${root}/browser/${file}`,'utf8'))) {
  const name=new URL(entry.url).pathname;
  if(!['/special-stock-fulfillment.js','/sales-special-stock-requests.js','/special-stock-case-status.js'].includes(name))continue;
  const path='/app/public'+name;
  if(entry.source!==await fs.readFile(path,'utf8'))throw Error('Browser source mismatch: '+name);
  const converter=v8ToIstanbul(path,0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
 }
}
await fs.writeFile(`${root}/coverage/merged.json`,JSON.stringify(map.toJSON()));
