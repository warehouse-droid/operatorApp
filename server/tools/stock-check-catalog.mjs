import fs from 'node:fs/promises';
import path from 'node:path';
import {scrapeUnilockCatalog} from '../src/stock-check/unilock-catalog.js';
const root=process.argv[2]??'/app/test-artifacts/stock-check/catalog';
const directory=path.join(root,new Date().toISOString().replace(/[:.]/gu,'-'));
await fs.mkdir(directory,{recursive:true,mode:0o700});
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
let count=0;
console.log(JSON.stringify({catalogDirectory:directory,method:'Unilock Ontario',credentialsUsed:false}));
try {
  const result=await scrapeUnilockCatalog({signal:controller.signal,throttleMs:250,retainUnmapped:true,
    onProduct:async product=>{await fs.appendFile(path.join(directory,'products.ndjson'),JSON.stringify(product)+'\n');},
    onStep:async step=>{await fs.appendFile(path.join(directory,'steps.ndjson'),JSON.stringify({at:new Date().toISOString(),...step})+'\n');},
    onProgress:async progress=>{count++;if(count%10===0 || progress.imported===0) {console.log(JSON.stringify(progress));}}
  });
  await fs.writeFile(path.join(directory,'products.json'),JSON.stringify(result.products,null,2)+'\n');
  await fs.writeFile(path.join(directory,'summary.json'),JSON.stringify({status:result.errors.length?'partial':'complete',finishedAt:new Date().toISOString(),...result.summary,errors:result.errors},null,2)+'\n');
  console.log(JSON.stringify({finished:true,catalogDirectory:directory,...result.summary}));
} catch(error) {
  await fs.writeFile(path.join(directory,'interrupted.json'),JSON.stringify({status:'failed',finishedAt:new Date().toISOString(),reason:error.message},null,2)+'\n');
  console.error(JSON.stringify({catalogFailed:true,reason:error.message,catalogDirectory:directory}));process.exitCode=1;
}
