import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Use the isolated release test runner.');}
const layers=[];
function run(name,args) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:8*1024*1024});
  writeFileSync(`test-artifacts/driver-${name}.log`,result.stdout+result.stderr);layers.push({name,exitCode:result.status});
  process.stdout.write(`${name}: ${result.status}\n`);
  if(result.status!==0) {process.stdout.write((result.stdout+result.stderr).slice(-5000));process.exit(result.status || 1);}
}
run('syntax',['--check','src/server.js']);run('worker-syntax',['--check','public/driver-service-worker.js']);
run('lint',['node_modules/eslint/bin/eslint.js','--config','eslint.driver-upload.config.mjs','--max-warnings=0',
  'public/driver-upload.js','src/driver-upload-failure.js','src/driver-upload-failure-repository.js']);
run('types',['node_modules/typescript/bin/tsc','--project','test/driver-upload-types.json']);
const files=['test/mbt/unit/driver-upload-reliability.test.js','test/mbt/unit/driver-upload-lifecycle.test.js',
  'test/mbt/unit/driver-upload-request.test.js','test/mbt/unit/driver-upload-failure.test.js',
  'test/mbt/unit/driver-pwa-recovery-assets.test.js','test/mbt/property/driver-upload-progress.test.js','test/mbt/integration/driver-upload-failure-http.test.js'];
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''});
const status=await runNodeTestFilesIsolated(files,{environment,label:'Combined release Driver'});
layers.push({name:'unit-property-http',exitCode:status});
const sources=['public/driver.js','public/driver.html','public/driver.css','public/driver-service-worker.js','public/driver-upload.js',
  'src/driver-client-version.js','src/driver-upload-failure.js','src/driver-upload-failure-repository.js','src/server.js','migrations/282_driver_upload_failure_audit.sql'];
const sourceHashes=Object.fromEntries(sources.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync('test-artifacts/driver-checks.json',JSON.stringify({layers,sourceHashes},null,2)+'\n');
process.exitCode=status;
