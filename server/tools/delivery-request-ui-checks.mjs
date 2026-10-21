import {spawnSync} from 'node:child_process';
import {readdirSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

assert.equal(process.env.MBT_TEST_ISOLATED,'1','Checks require disposable test infrastructure');
const artifact='test-artifacts/delivery-requests-ui';
mkdirSync(artifact,{recursive:true});
for(const name of readdirSync(artifact)) {rmSync(`${artifact}/${name}`,{recursive:true,force:true});}
const stages=[];
function run(name,args,env={}) {
  const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:300000,env:{...process.env,...env}});
  writeFileSync(`${artifact}/${name}.log`,result.stdout+result.stderr);
  stages.push({name,exitCode:result.status});
  writeFileSync(`${artifact}/stages.json`,JSON.stringify(stages,null,2)+'\n');
  process.stdout.write(`${name}: ${result.status}\n`);
  if(result.status!==0) {process.stdout.write((result.stdout+result.stderr).slice(-14000));process.exit(result.status || 1);}
}
run('workflow',[process.execPath,'tools/delivery-request-checks.mjs']);
run('types',[process.execPath,'tools/delivery-request-quality.mjs','types']);
run('lint',[process.execPath,'tools/delivery-request-static.mjs']);
run('syntax',[process.execPath,'--check','public/app-sidebar.js']);
run('versions',[process.execPath,'tools/delivery-request-quality.mjs','versions']);
run('mutations',[process.execPath,'tools/delivery-request-ui-mutations.mjs']);
// A final browser run after mutation preserves fresh screenshots and coverage.
run('browser',[process.execPath,'--test','--test-concurrency=1',
  'test/mbt/integration/delivery-requests-browser.test.js','test/mbt/integration/delivery-request-event-stream-browser.test.js'],{DELIVERY_UI_COVERAGE:'1'});
const files=['public/delivery-requests.html','public/delivery-requests.css','public/delivery-requests.js',
  'public/delivery-request-alert.js','public/app-sidebar.js','src/delivery-request-repository.js'];
const hashes=Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${artifact}/source.json`,JSON.stringify({files:hashes,treeHash:crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex')},null,2)+'\n');
