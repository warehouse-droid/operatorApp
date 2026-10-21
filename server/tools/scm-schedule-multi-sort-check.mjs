import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';
import {query,closeDb} from '../src/db.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out=resolve('test-artifacts/scm-schedule-deploy-20261001');mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/scm-schedule-multi-sort-files.json'));
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const originalHashes=hashes();
try {
  const migration=readFileSync('migrations/248_scm_schedule_multi_filters.sql','utf8');
  await query(migration);await query(migration);
} finally {await closeDb();}

function run(label,args,{expectedFailures=[]}={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:240000,maxBuffer:40000000,
    env:{...process.env,SCHEDULE_SCREENSHOT_DIR:out+'/browser',SPECIAL_BATCH_BROWSER_OUTPUT:out+'/note-browser'}});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/'+label+'.log',log);
  const failures=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  assert.deepEqual(failures.sort(),[...expectedFailures].sort(),label+': '+log.slice(-5000));
  assert.equal(result.status,expectedFailures.length?1:0,label+': '+log.slice(-5000));
  const counts=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
  console.log(JSON.stringify({label,exitCode:result.status,...counts}));return counts;
}
for(const file of files.filter(file=>file.endsWith('.js')))run('syntax-'+file.split('/').at(-1),['--check',file]);
const lint=new ESLint({overrideConfigFile:resolve('tools/stock-request-layout-eslint.config.mjs')});
for(const file of files.filter(file=>file.endsWith('.js'))) {
  const messages=async text=>(await lint.lintText(text,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  const before=await messages(readFileSync(out+'/before/'+file,'utf8'));
  const current=await messages(readFileSync(file,'utf8'));
  assert.deepEqual(current.filter(message=>{const i=before.indexOf(message);if(i<0)return true;before.splice(i,1);return false;}),[],file+' has new lint findings');
}
const unit=run('schedule-unit',['--test','--test-concurrency=1',
  'test/dispatch/frontend/scm-schedule-multi-sort.test.js','test/dispatch/frontend/scm-schedule-column-preferences.test.js',
  'test/dispatch/frontend/scm-schedule-status-save.test.js']);
run('column-filter-contract',['src/scm-schedule-column-filter-harness.js']);
run('column-filter-postgres',['src/scm-schedule-column-filter-integration-harness.js']);
run('preference-postgres',['src/scm-schedule-preference-harness.js']);
const browser=run('schedule-browser',['--test','--test-concurrency=1','test/dispatch/frontend/scm-schedule-columns.browser.test.mjs']);
run('column-mutations',['test/support/run-schedule-column-mutations.mjs']);
const {existing,own}=await import('./special-po-so-note-suites.mjs');
const noteBaseline=JSON.parse(readFileSync('tools/scm-schedule-note-baseline.json'));
const note=run('note-regressions',['--test','--test-concurrency=1',...existing,...own],{expectedFailures:noteBaseline.finalFailures});
run('secrets',['test/support/scan-diff-secrets.mjs',...files]);
assert.deepEqual(hashes(),originalHashes);
const result={completed:true,sourceHashes:originalHashes,unit,browser,note,newFailures:[],newLintFindings:0,
  filterPostgres:true,preferencePostgres:true,migrationIdempotent:true,columnMutantsKilled:3,
  tools:{node:process.version,...Object.fromEntries(['eslint','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
writeFileSync(out+'/checks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
