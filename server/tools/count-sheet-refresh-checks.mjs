import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {mutants} from '../test/support/count-sheet-refresh-mutation-loader.mjs';
import {packedMutants} from '../test/support/inventory-packed-mutation-loader.mjs';

export const files=JSON.parse(readFileSync('tools/count-sheet-refresh-files.json'));
const folder='test-artifacts/count-sheet-refresh';
const tests=['test/count-sheet-refresh.test.js','test/count-sheet-refresh-browser.test.js','test/inventory-packed-count.test.js','test/count-sheet-reconstruction.test.js','test/inventory-count-review-browser.test.js','test/cycle-count-refresh-http.test.js',
  'test/mbt/integration/operator-yard-access.test.js',...['domain','adapter','photos','count','damage','http','browser'].map(name=>`test/operator-inventory-${name}.test.js`)];
const save=(name,value)=>writeFileSync(`${folder}/${name}.json`,JSON.stringify(value,null,2)+'\n');
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const counts=output=>Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(match=>[match[1],Number(match[2])]));
function run(label,args,{env={},failure=false}={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,...env},timeout:240000,maxBuffer:16*1024*1024});
  const output=result.stdout+result.stderr;writeFileSync(`${folder}/${label}.log`,output);
  if(!failure) {assert.equal(result.status,0,`${label}: ${output.slice(-5000)}`);}
  return {...result,output};
}

async function resetFocusedDatabase() {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  const connection=new URL(process.env.DATABASE_URL);
  assert.equal(connection.hostname,'db');assert.equal(connection.username,'mbt_test');
  assert.equal(connection.pathname,'/mbt_test_file_000000000000_focus');
  connection.pathname='/postgres';
  const client=new pg.Client({connectionString:connection.href});await client.connect();
  try {
    await client.query('DROP DATABASE IF EXISTS mbt_test_file_000000000000_focus WITH (FORCE)');
    await client.query('CREATE DATABASE mbt_test_file_000000000000_focus TEMPLATE mbt_test');
  } finally {await client.end();}
}

rmSync(folder,{recursive:true,force:true});mkdirSync(folder,{recursive:true});
const startedAt=new Date().toISOString();
for(const file of files.filter(file=>file.endsWith('.js'))) {run('syntax-'+file.split('/').at(-1),['--check',file]);}
run('lint',['tools/count-sheet-refresh-scoped-lint.mjs']);
run('test-lint',['node_modules/eslint/bin/eslint.js','--config','tools/count-sheet-refresh-eslint.config.mjs','--max-warnings=0',...tests.slice(0,6),'test/operator-inventory-browser.test.js']);
const types=run('project-types',['node_modules/typescript/bin/tsc','--project','tsconfig.mbt.json','--pretty','false'],{failure:true});
save('type-diagnostics',[...new Set(types.output.split('\n').filter(line=>line.includes('error TS')).map(line=>line.replace(/\(\d+,\d+\)/g,'')))].sort());
await resetFocusedDatabase();
const focused=run('focused',['node_modules/c8/bin/c8.js','--all','--check-coverage=false','--include=src/count-sheet-stock-refresh.js','--include=src/operator-inventory-router.js','--include=src/inventory-packed-stock.js','--include=src/count-sheet-reconstruction.js','--include=src/cycle-count-stock-refresh.js','--include=src/count-sheet-repository.js','--include=src/inventory-repository.js','--include=src/server.js','--include=src/history-repository.js',
  `--temp-directory=${folder}/v8`,`--report-dir=${folder}/coverage`,'--reporter=json','--reporter=text',
  process.execPath,'--test','--test-concurrency=1',...tests]);
save('focused',counts(focused.output));
const browserCoverage=readFileSync('test-artifacts/count-sheet-refresh-browser-coverage.json');
writeFileSync(`${folder}/browser-coverage.json`,JSON.stringify([...JSON.parse(browserCoverage),...JSON.parse(readFileSync('test-artifacts/inventory-count-review-browser-coverage.json'))]));
run('changed-lines-coverage',['tools/count-sheet-refresh-coverage.mjs']);
const mutation=[];
for(const name of Object.keys(mutants)) {
  const result=run('mutant-'+name,['--loader','./test/support/count-sheet-refresh-mutation-loader.mjs','--test','test/count-sheet-refresh.test.js'],{env:{COUNT_REFRESH_MUTANT:name},failure:true});
  assert.ok(result.output.includes(`COUNT_REFRESH_MUTATION_APPLIED:${name}`),name);
  assert.notEqual(result.status,0,'Surviving mutant: '+name);assert.ok(counts(result.output).fail>0,name);
  mutation.push({name,killed:true,failures:counts(result.output).fail});
}
const uiMutation=run('mutant-completed-browser',['--test','--test-name-pattern=submitted sheet review','test/count-sheet-refresh-browser.test.js'],{env:{COUNT_REFRESH_BROWSER_MUTANT:'historical'},failure:true});
assert.ok(uiMutation.output.includes('COUNT_REFRESH_BROWSER_MUTATION_APPLIED'));assert.notEqual(uiMutation.status,0);assert.equal(counts(uiMutation.output).fail,1);
mutation.push({name:'completed-browser',killed:true,failures:1});save('mutations',mutation);
for(const name of Object.keys(packedMutants)) {
  const result=run('mutant-packed-'+name,['--loader','./test/support/inventory-packed-mutation-loader.mjs','--test','--test-concurrency=1','test/inventory-packed-count.test.js','test/count-sheet-reconstruction.test.js'],{env:{PACKED_COUNT_MUTANT:name},failure:true});
  assert.ok(result.output.includes(`PACKED_COUNT_MUTATION_APPLIED:${name}`),name);
  assert.notEqual(result.status,0,'Surviving mutant: '+name);assert.ok(counts(result.output).fail>0,name);
  mutation.push({name,killed:true,failures:counts(result.output).fail});
}
for(const name of ['packedZero','fulfilledIgnored']) {
  const result=run('property-mutant-'+name,['--loader','./test/support/inventory-packed-mutation-loader.mjs','--test','--test-name-pattern=generated packing','test/inventory-packed-count.test.js'],{env:{PACKED_COUNT_MUTANT:name},failure:true});
  assert.ok(result.output.includes(`PACKED_COUNT_MUTATION_APPLIED:${name}`));assert.equal(counts(result.output).fail,1);
}
save('mutations',mutation);
const order=[...tests].sort((a,b)=>hash(a).localeCompare(hash(b)));
await resetFocusedDatabase();
const reordered=run('reordered',['--test','--test-concurrency=1',...order]);save('reordered',{order,...counts(reordered.output)});
run('secrets',['test/support/scan-diff-secrets.mjs',...files.filter(file=>file.endsWith('.js')),...tests.slice(0,6),'tools/count-sheet-refresh-checks.mjs','tools/count-sheet-refresh-env.sh']);
const versions=Object.fromEntries(['@playwright/test','fast-check','c8','eslint','typescript'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
save('source',{startedAt,finishedAt:new Date().toISOString(),node:process.version,versions,files:Object.fromEntries([...files,...tests].map(file=>[file,hash(file)]))});
console.log(JSON.stringify({passed:true,...counts(focused.output),mutants:mutation.length,source:folder+'/source.json'}));
