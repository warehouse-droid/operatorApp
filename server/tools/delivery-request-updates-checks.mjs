import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Checks require disposable isolated infrastructure.');}
const files=['unit/delivery-request-domain','unit/delivery-request-expiry','unit/delivery-request-router',
  'property/delivery-request-domain.property','integration/delivery-requests','integration/delivery-requests-http',
  'integration/delivery-request-planning','integration/delivery-request-event-stream-browser','integration/delivery-requests-browser']
  .map(name=>`test/mbt/${name}.test.js`);
const checks=[['types',['tools/delivery-request-quality.mjs','types']],
  ['lint',['tools/delivery-request-static.mjs']],['sidebar-syntax',['--check','public/app-sidebar.js']]];
const stages=[];
for(const [name,args] of checks) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8'});
  writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);
  stages.push({name,exitCode:result.status});
  process.stdout.write(`${name}: ${result.status}\n`);
  if(result.status!==0) {process.exit(result.status || 1);}
}
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''});
process.exitCode=await runNodeTestFilesIsolated(files,{environment,label:'Delivery request updates'});
stages.push({name:'tests',exitCode:process.exitCode});
writeFileSync('test-artifacts/stages.json',JSON.stringify(stages,null,2)+'\n');
