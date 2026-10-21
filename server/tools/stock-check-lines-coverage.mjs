import fs from 'node:fs/promises';
import path from 'node:path';
import v8toIstanbul from 'v8-to-istanbul';
import {mergeScriptCovs} from '@bcoe/v8-coverage';
const scripts=[...JSON.parse(await fs.readFile('test-artifacts/stock-check/browser-coverage.json','utf8')),
  ...JSON.parse(await fs.readFile('test-artifacts/stock-check/lines-browser-coverage.json','utf8'))],report={};
for(const file of ['public/scm-stock-check.js','public/scm-stock-check-lines.js','public/scm-special-stock-requests.js','public/scm-stock-requests.js','public/backorder-stock-requests.js']) {
  const source=await fs.readFile(file,'utf8'),rows=scripts.filter(row=>row.url.split('?')[0].endsWith('/'+path.basename(file)));
  if(!rows.length) {throw new Error('Missing browser coverage for '+file);}
  const merged=mergeScriptCovs(rows.map(row=>({scriptId:'1',url:file,functions:row.functions})));
  const converter=v8toIstanbul(file,0,{source});await converter.load();converter.applyCoverage(merged.functions);
  Object.assign(report,converter.toIstanbul());
  const data=Object.values(converter.toIstanbul())[0],counts=Object.values(data.s);
  console.log(JSON.stringify({file,executedLines:counts.filter(count=>count>0).length,totalLines:counts.length}));
}
await fs.writeFile('test-artifacts/stock-check/lines-browser-coverage-istanbul.json',JSON.stringify(report));

const versions={node:process.versions.node};
for(const name of ['@playwright/test','typescript','eslint','c8','fast-check']) {versions[name]=JSON.parse(await fs.readFile('node_modules/'+name+'/package.json','utf8')).version;}
await fs.writeFile('test-artifacts/stock-check/lines-toolchain.json',JSON.stringify(versions));
