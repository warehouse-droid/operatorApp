import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const out=resolve('test-artifacts/damage-posting-retry-20261001');mkdirSync(out,{recursive:true});
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
assert.match(process.env.DATABASE_URL,/\/mbt_focus$/);
const files=JSON.parse(readFileSync('tools/damage-posting-retry-files.json'));
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const sourceHashes=hashes();
const tests=readdirSync('test').filter(file=>/^(damage-photo.*|damage-posting-.*|damage-retained-.*|damage-control-.*|damage-retry-.*|control-damage-.*|operator-inventory-.*)\.test\.js$/.test(file)).sort().map(file=>'test/'+file);
tests.push('test/mbt/integration/netsuite-priority-queue.test.js','test/mbt/integration/netsuite-priority-queue-failure.test.js');
function run(label,args,timeout=300000) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout,maxBuffer:12*1024*1024});
  const log=(result.stdout || '')+(result.stderr || '');writeFileSync(`${out}/${label}.log`,log);
  console.log(JSON.stringify({label,exitCode:result.status,tail:log.slice(-500)}));assert.equal(result.status,0,label+': '+log.slice(-2500));
  return Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1] || 0)]));
}
const focused=run('focused',['node_modules/c8/bin/c8.js','--all','--check-coverage=false','--include=src/inventory-damage-*.js',
  '--include=src/control-damage-*.js','--include=src/operator-inventory-router.js','--include=public/damage-draft-cache.js',
  '--include=public/operator-inventory.js','--include=public/service-worker.js','--include=public/control-damage.js','--reporter=json','--reporter=json-summary',
  `--reports-dir=${out}/coverage`,`--temp-directory=${out}/v8`,'node','--test','--test-concurrency=1',...tests]);
run('mutations',['tools/damage-posting-retry-mutants.mjs']);
const reordered=run('reordered',['--test','--test-concurrency=1',...tests.slice().reverse()]);
run('static',['tools/damage-posting-retry-static.mjs']);
assert.deepEqual(hashes(),sourceHashes);
const versions=Object.fromEntries(['c8','eslint','typescript','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
const result={completed:true,sourceHashes,focused,reordered,node:process.version,versions,newDependencies:0};
writeFileSync(`${out}/checks.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
