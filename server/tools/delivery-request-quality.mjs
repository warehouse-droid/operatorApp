import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const command=process.argv[2];
if(command==='versions') {
  const packages=['@playwright/test','c8','fast-check','eslint','typescript','pg','express'];
  const versions=Object.fromEntries(packages.map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version]));
  process.stdout.write(JSON.stringify({node:process.version,...versions},null,2)+'\n');
} else {
const modes={types:['node_modules/.bin/tsc','--project','tools/tsconfig.delivery-requests.json','--noEmit'],
  lint:[process.execPath,'tools/delivery-request-static.mjs']};
if(!Object.hasOwn(modes,command)) {throw new Error('Choose types or lint.');}
const [binary,...args]=modes[command];
const result=spawnSync(binary,args,{stdio:'inherit'});
process.exitCode=result.status ?? 1;
}
