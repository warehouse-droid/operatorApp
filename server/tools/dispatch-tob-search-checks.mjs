// Execute only through docker/check-dispatch-tob-search.sh.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';

const input=JSON.parse(readFileSync('test-artifacts/inputs.json','utf8'));
const focus=[
 "test/dispatch/frontend/dispatch-tob-search.test.js",
 "test/dispatch/integration/dispatch-tob-search-sql.test.js"
];
const regression=[
 "test/dispatch/frontend/dispatch-freshness-races.test.js",
 "test/dispatch/frontend/group-hydration-concurrency.test.js",
 "test/dispatch/frontend/sales-order-group-hydration.red.test.js",
 "test/dispatch/frontend/dispatch-planner-performance.contract.test.js",
 "test/dispatch/frontend/dispatch-unplan-freshness.red.test.js",
 "test/dispatch/frontend/dispatch-po-ref-link-search.test.js",
 "test/dispatch/property/dispatch-search-session.property.test.js",
 "test/dispatch/unit/dispatch-order-pool-gate.contract.test.js",
 "test/dispatch/unit/dispatch-order-pool-policy.test.js",
 "test/dispatch/unit/dispatch-fulfilled-so-policy.test.js",
 "test/dispatch/integration/dispatch-search-session.test.js",
 "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
 "test/dispatch/integration/dispatch-po-pickup-yard.test.js",
 "test/dispatch/integration/scm-po-split-corrected-receipt-visibility.test.js",
 "test/dispatch/integration/scm-po-split-status-consistency.red.test.js",
 "test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js",
 "test/dispatch/integration/dispatch-global-order-group-pool.red.test.js",
 "test/dispatch/property/dispatch-global-order-group-pool.property.test.js",
 "test/dispatch/integration/dispatch-order-catalog.red.test.js",
 "test/dispatch/integration/dispatch-v2-snapshot-performance.red.test.js",
 "test/dispatch/integration/linked-po-pickup-feed-20261028.test.js"
];
const report={...input,passed:false,node:process.version,tests:[],specApproval:'not obtained (autonomous run)'};
report.toolchain=Object.fromEntries(['eslint','typescript','c8','fast-check','pg'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8')).version]));
const runtime=Object.keys(input.files).filter(file=>file.endsWith('.js'));
const original=Object.fromEntries(Object.keys(input.files).map(file=>[file,readFileSync(file)]));
const restore=()=>{for(const [file,contents] of Object.entries(original))writeFileSync(file,contents);};
const baseline=()=>{for(const file of Object.keys(original))if(readFileSync('baseline/'+file).length)writeFileSync(file,readFileSync('baseline/'+file));};
const node=(args,env={})=>spawnSync(process.execPath,args,{env:{...process.env,...env},encoding:'utf8',maxBuffer:40*1024*1024});
mkdirSync('test-artifacts/logs',{recursive:true});mkdirSync('test-artifacts/v8',{recursive:true});
const dbUrl=new URL(process.env.DATABASE_URL);
assert.equal(dbUrl.hostname,'db');assert.equal(dbUrl.pathname,'/mbt_test');assert.equal(process.env.MBT_TEST_ISOLATED,'1');
dbUrl.pathname='/postgres';const db=new pg.Client({connectionString:dbUrl.href});await db.connect();
async function run(file,label,coverage=false,pattern='') {
 await db.query('DROP DATABASE IF EXISTS mbt_verify WITH (FORCE)');
 await db.query('CREATE DATABASE mbt_verify TEMPLATE mbt_test');
 const url=new URL(process.env.DATABASE_URL);url.pathname='/mbt_verify';
 try {
  const result=node(['--test','--test-concurrency=1',...(pattern?['--test-name-pattern='+pattern]:[]),file],{
   DATABASE_URL:url.href,NETSUITE_MIRROR_ROLE:'source',...(coverage?{NODE_V8_COVERAGE:process.cwd()+'/test-artifacts/v8'}:{})
  });
  const output=(result.stdout||'')+(result.stderr||'');
  writeFileSync(`test-artifacts/logs/${label.replaceAll('/','_')}.log`,output);
  const failures=('\n'+output).split(/(?=not ok \d)/).slice(1).map(block=>({
   name:block.split('\n')[0].replace(/^not ok \d+ - /,''),
   error:block.match(/\n  error: ([\s\S]*?)(?:\n  (?:code|name|stack):)/)?.[1]?.trim()||'unknown'
  }));
  const row={file,label,status:result.status,tests:Number(output.match(/# tests (\d+)/)?.[1]||0),passed:Number(output.match(/# pass (\d+)/)?.[1]||0),failures};
  report.tests.push(row);console.log(JSON.stringify(row));return row;
 } finally {await db.query('DROP DATABASE IF EXISTS mbt_verify WITH (FORCE)');}
}
function difference(after,before) {
 const remaining=[...before];return after.filter(message=>{const index=remaining.indexOf(message);if(index<0)return true;remaining.splice(index,1);return false;});
}
function comparableFailures(failures) {
 return failures.map(failure=>({...failure,error:failure.error
  .replaceAll('mbt-planning-repairs-20261026','CURRENT_DISPATCH_ASSET')
  .replaceAll('20261028-search-consistency','CURRENT_DISPATCH_ASSET')}));
}
async function staticChecks() {
 const {ESLint}=await import('eslint');
 const globals=Object.fromEntries('process console Buffer URL URLSearchParams fetch structuredClone setTimeout clearTimeout setInterval clearInterval AbortController AbortSignal window document localStorage sessionStorage navigator Event CustomEvent FormData File Blob performance location requestAnimationFrame self caches Request Response importScripts crypto DriverOfflineSync'.split(' ').map(name=>[name,'readonly']));
 const eslint=new ESLint({overrideConfigFile:'eslint.mbt.config.js',overrideConfig:[{files:runtime,languageOptions:{globals},rules:{'no-undef':'error','no-unused-vars':['error',{args:'none',caughtErrors:'none'}],eqeqeq:'error','no-var':'error','prefer-const':'error'}}]});
 const lint=async()=> (await eslint.lintFiles(runtime)).flatMap(file=>file.messages.map(message=>`${file.filePath.split('/candidate/')[1]}:${message.ruleId}:${message.message}`)).sort();
 const args=['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','es2022','--module','nodenext',...runtime];
 const types=label=>{
  const result=node(args,{NODE_OPTIONS:'--max-old-space-size=1200'}),output=(result.stdout||'')+(result.stderr||'');
  writeFileSync('test-artifacts/logs/types-'+label+'.log',output);
  assert.ok(result.status===0||([1,2].includes(result.status)&&/error TS\d+:/.test(output)),`Type checker failed to complete: ${result.status} ${result.signal}`);
  return output.split('\n').filter(line=>runtime.some(file=>line.startsWith(file+'('))).map(line=>line.replace(/\(\d+,\d+\)/,'')).sort();
 };
 let oldTypes,oldLint;try{baseline();oldTypes=types('baseline');oldLint=await lint();}finally{restore();}
 const newTypes=types('candidate'),newLint=await lint();
 report.types={baseline:oldTypes.length,current:newTypes.length,newErrors:difference(newTypes,oldTypes)};
 report.lint={baseline:oldLint.length,current:newLint.length,newErrors:difference(newLint,oldLint)};
 console.log(JSON.stringify({types:report.types,lint:report.lint}));
 assert.equal(report.types.newErrors.length,0);assert.equal(report.lint.newErrors.length,0);
 for(const file of runtime)assert.equal(node(['--check',file]).status,0);
}
async function coverage() {
 const result=node(['node_modules/c8/bin/c8.js','report','--all=false','--check-coverage=false',...runtime.map(file=>'--include='+file),'--temp-directory=test-artifacts/v8','--report-dir=test-artifacts/coverage','--reporter=json']);
 assert.equal(result.status,0,result.stderr);
 const {createCoverageMap}=(await import('istanbul-lib-coverage')).default;
 const map=createCoverageMap(JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json','utf8')));
 report.coverage=runtime.map(file=>{
  const absolute=process.cwd()+'/'+file,source=readFileSync(file,'utf8').split('\n');
  const lines=map.files().includes(absolute)?map.fileCoverageFor(absolute).getLineCoverage():{};
  const changed=input.changedLines[file].filter(line=>source[line-1].trim()&&!/^\s*(\/\/|\*|\/\*)/.test(source[line-1]));
  const missing=changed.filter(line=>!(lines[line]>0));return {file,total:changed.length,covered:changed.length-missing.length,missing};
 });
 console.log(JSON.stringify({coverage:report.coverage}));assert.ok(report.coverage.every(row=>!row.missing.length),'Uncovered changed lines');
}
async function mutations() {
 const mutants=[
 {
  "name": "drop-search-after-plan-edit",
  "file": "public/dispatch.js",
  "before": "if (!current()) return true;",
  "after": "if (!current() || !dispatchOrderReadIsCurrent(readToken)) return true;",
  "test": "test/dispatch/frontend/dispatch-tob-search.test.js",
  "pattern": "properties"
 },
 {
  "name": "overwrite-newer-card",
  "file": "public/dispatch.js",
  "before": ": freshFeed.map(order => orderById(order.id) || order);",
  "after": ": freshFeed;",
  "test": "test/dispatch/frontend/dispatch-tob-search.test.js",
  "pattern": "properties"
 },
 {
  "name": "accept-same-date-old-navigation",
  "file": "public/dispatch.js",
  "before": "&& navigation === dispatchPlanLoadSequence;",
  "after": ";",
  "test": "test/dispatch/frontend/dispatch-tob-search.test.js",
  "pattern": "properties"
 },
 {
  "name": "refresh-browse-instead-of-search",
  "file": "public/dispatch.js",
  "before": "if (!sync && !append && term.length >= 2) {",
  "after": "if (false) {",
  "test": "test/dispatch/frontend/dispatch-tob-search.test.js"
 },
 {
  "name": "ignore-closed-split-member",
  "file": "src/dispatch-order-pool-sql.js",
  "before": "OR split_${kind}_id IN (SELECT id FROM closed_${kind})",
  "after": "OR false",
  "test": "test/dispatch/integration/dispatch-tob-search-sql.test.js"
 },
 {
  "name": "omit-closed-family-children",
  "file": "src/dispatch-order-pool-sql.js",
  "before": "WHERE source_${kind}_id IN (SELECT id FROM closed_${kind}_families)",
  "after": "WHERE false",
  "test": "test/dispatch/integration/dispatch-tob-search-sql.test.js"
 }
];
 report.mutations=[];
 for(const mutant of mutants) {
  const source=original[mutant.file].toString();assert.ok(source.includes(mutant.before),mutant.name);
  try {
   writeFileSync(mutant.file,source.replace(mutant.before,mutant.after));
   const row=await run(mutant.test,'mutant-'+mutant.name,false,mutant.pattern);
   report.mutations.push({name:mutant.name,killed:row.status!==0&&row.failures.length>0,propertyAlone:Boolean(mutant.pattern),failures:row.failures.map(f=>f.name)});
   assert.ok(report.mutations.at(-1).killed,'Surviving mutant '+mutant.name);
  } finally {restore();}
 }
}
try {
 const prior=new Map();try{baseline();report.red=await run(focus[0],'baseline-correctness');assert.ok(report.red.status!==0&&report.red.failures.length>0,'The baseline must reproduce the bug');for(const file of regression)prior.set(file,await run(file,'baseline-'+file));}finally{restore();}
 // Deterministic pseudorandom file ordering, independent databases per file.
 const order=[...regression,...focus].sort((a,b)=>createHash('sha256').update('TOB0126:'+a).digest('hex').localeCompare(createHash('sha256').update('TOB0126:'+b).digest('hex')));
 for(const file of order) {
  const row=await run(file,'candidate-'+file,true),before=prior.get(file);
  if(row.status!==0) {
   assert.ok(before?.status===row.status&&before.tests===row.tests&&JSON.stringify(comparableFailures(before.failures))===JSON.stringify(comparableFailures(row.failures)),'New regression in '+file);
   row.existingFailure=true;
  }
 }
 await staticChecks();await coverage();await mutations();
 for(const file of focus)assert.equal((await run(file,'restored-'+file)).status,0);
 report.passed=true;
} catch(error) {report.error=error.message;console.error(error.stack);process.exitCode=1;}
finally {
 restore();await db.end();
 assert.deepEqual(Object.fromEntries(Object.keys(original).map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),input.files,'Mutant restore changed the candidate');
 // Raw logs and source dumps stay disposable; retain concise assertion evidence.
 for(const row of report.tests)for(const failure of row.failures){
  failure.errorSha256=createHash('sha256').update(comparableFailures([failure])[0].error).digest('hex');
  failure.error=failure.error.split('\n    \n')[0].slice(0,600);
 }
 writeFileSync('test-artifacts/report.json',JSON.stringify(report,null,2)+'\n');
}
