import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const out=resolve('test-artifacts/damage-photos-20261001');mkdirSync(out,{recursive:true});
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
assert.match(process.env.DATABASE_URL,/\/mbt_focus$/);
const files=JSON.parse(readFileSync('tools/damage-photos-files.json'));
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const sourceHashes=hashes();
const featureTests=readdirSync('test').filter(file=>/^(damage-photo.*|control-damage-.*|operator-inventory-.*)\.test\.js$/.test(file)).sort().map(file=>'test/'+file);
featureTests.push('test/mbt/integration/netsuite-priority-queue.test.js','test/mbt/integration/netsuite-priority-queue-failure.test.js');
function run(label,args,timeout=240000) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  const log=(result.stdout || '')+(result.stderr || '');writeFileSync(`${out}/${label}.log`,log);
  console.log(JSON.stringify({label,exitCode:result.status,tail:log.slice(-700)}));assert.equal(result.status,0,label+': '+log.slice(-3000));
  return Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1] || 0)]));
}
const focused=run('focused',['node_modules/c8/bin/c8.js','--all','--check-coverage=false','--include=src/inventory-damage-*.js',
  '--include=src/control-damage-router.js',
  '--include=public/damage-photo-download.js','--reporter=json','--reporter=json-summary',`--reports-dir=${out}/coverage`,
  `--temp-directory=${out}/v8`,'node','--test','--test-concurrency=1',...featureTests]);
run('mutations',['tools/damage-photos-mutations.mjs']);
const shuffle=run('reordered',['--test','--test-concurrency=1',...featureTests.slice().reverse()]);
run('static',['tools/damage-photos-static.mjs']);
assert.deepEqual(hashes(),sourceHashes);
const versions=Object.fromEntries(['c8','eslint','typescript','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
const result={completed:true,sourceHashes,focused,reordered:shuffle,node:process.version,versions,newDependencies:0};
writeFileSync(`${out}/checks.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
