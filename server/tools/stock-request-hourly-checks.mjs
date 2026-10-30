// Run only in the fresh disposable source tree and database supplied by the shell runner.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';

const mode=process.argv[2]||'gauntlet';
const input=JSON.parse(readFileSync('test-artifacts/inputs.json','utf8'));
const focus=['test/mbt/unit/stock-request-so-refresh.test.js','test/mbt/integration/stock-request-so-refresh.test.js'];
const regression=['test/mbt/integration/special-status-following.test.js','test/mbt/integration/regular-stock-handoff.test.js','test/mbt/unit/regular-stock-status.test.js'];
const browserTests=['test/mbt/integration/stock-request-so-refresh-browser.test.js','test/mbt/integration/stock-request-so-refresh-boot.test.js'];
const report={...input,mode,tests:[],passed:false,node:process.version};
report.toolchain=Object.fromEntries(['eslint','typescript','c8','fast-check','@playwright/test','pg'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8')).version]));
const runtime=Object.keys(input.files).filter(file=>file.endsWith('.js'));
const original=Object.fromEntries(Object.keys(input.files).map(file=>[file,readFileSync(file)]));
mkdirSync('test-artifacts/logs',{recursive:true});
mkdirSync('test-artifacts/v8',{recursive:true});
const baseline=existsSync('baseline-result.json')?JSON.parse(readFileSync('baseline-result.json','utf8')):null;
const database=new URL(process.env.DATABASE_URL);
assert.equal(database.hostname,'db');assert.equal(database.pathname,'/mbt_test');assert.equal(database.username,'mbt_test');assert.equal(process.env.MBT_TEST_ISOLATED,'1');
database.pathname='/postgres';const client=new pg.Client({connectionString:database.href});await client.connect();
function node(args,env={}) {
 return spawnSync(process.execPath,args,{env:{...process.env,...env},encoding:'utf8',maxBuffer:32*1024*1024});
}
function restore() {for(const [file,contents] of Object.entries(original))writeFileSync(file,contents);}
function failures(output) {
 return ('\n'+output).split(/(?=not ok \d)/).slice(1).map(block=>({
  name:block.split('\n')[0].replace(/^not ok \d+ - /,''),
  error:block.match(/\n  error: ([\s\S]*?)(?:\n  (?:code|name|stack):)/)?.[1]?.trim()||'unknown'
 }));
}
function knownFailures(row) {
 const before=baseline?.tests.find(test=>test.file===row.file);
 if(!before?.failures)return false;
 const prior=typeof before.failures[0]==='string'?before.failures.flatMap(failures):before.failures;
 return row.status===1 && row.tests===before.tests && JSON.stringify(row.failures)===JSON.stringify(prior);
}
async function run(file,label=file,coverage=false) {
 await client.query('DROP DATABASE IF EXISTS mbt_verify WITH (FORCE)');
 await client.query('CREATE DATABASE mbt_verify TEMPLATE mbt_test');
 const url=new URL(process.env.DATABASE_URL);url.pathname='/mbt_verify';
 if(file.includes('special-header-note-http'))url.hostname='mbbs-special-review-db';
 try {
  const result=node(['--test','--test-concurrency=1',file],{DATABASE_URL:url.href,NETSUITE_MIRROR_ROLE:'source',
   ...(coverage?{NODE_V8_COVERAGE:process.cwd()+'/test-artifacts/v8'}:{})});
  const output=(result.stdout||'')+(result.stderr||'');
  writeFileSync(`test-artifacts/logs/${label.replaceAll('/','_')}.log`,output);
  const row={file,label,status:result.status,tests:Number(output.match(/# tests (\d+)/)?.[1]||0),passed:Number(output.match(/# pass (\d+)/)?.[1]||0),failed:Number(output.match(/# fail (\d+)/)?.[1]||0)};
  if(result.status!==0)row.failures=failures(output);
  row.existingFailures=result.status!==0&&knownFailures(row);
  report.tests.push(row);console.log(JSON.stringify(row));
  return row;
 } finally {await client.query('DROP DATABASE IF EXISTS mbt_verify WITH (FORCE)');}
}
function diagnostics(result) {
 return ((result.stdout||'')+(result.stderr||'')).split('\n').filter(line=>runtime.some(file=>line.startsWith(file+'('))).map(line=>line.replace(/\(\d+,\d+\)/,'').replace(/regular-stock-status\.js\?v=[^']+/g,'regular-stock-status.js?v=<cache-version>')).sort();
}
function difference(after,before) {
 const remaining=[...before];return after.filter(message=>{const index=remaining.indexOf(message);if(index<0)return true;remaining.splice(index,1);return false;});
}
async function staticChecks() {
 const {ESLint}=await import('eslint');
 const globals=Object.fromEntries('process console Buffer URL URLSearchParams fetch structuredClone setTimeout clearTimeout setInterval clearInterval AbortController AbortSignal window document localStorage sessionStorage navigator Event CustomEvent FormData File Blob performance location requestAnimationFrame'.split(' ').map(name=>[name,'readonly']));
 const eslint=new ESLint({overrideConfigFile:'eslint.mbt.config.js',overrideConfig:[{files:runtime,languageOptions:{globals},rules:{'no-undef':'error','no-unused-vars':['error',{args:'none',caughtErrors:'none'}],eqeqeq:'error','no-var':'error','prefer-const':'error'}}]});
 const lint=async()=> (await eslint.lintFiles(runtime)).flatMap(file=>file.messages.map(message=>`${file.filePath.split('/candidate/')[1]}:${message.ruleId}:${message.message}`)).sort();
 const args=['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','es2022','--module','nodenext',...runtime];
 let oldTypes,oldLint;
 try {
  for(const file of runtime)writeFileSync(file,readFileSync('baseline/'+file));
  const before=node(args,{NODE_OPTIONS:'--max-old-space-size=1200'});assert.ok(before.status===0||([1,2].includes(before.status)&&/error TS\d+:/.test(before.stdout)),`Baseline type checker did not complete: ${before.status} ${before.signal} ${(before.stderr||before.stdout||'').slice(-2500)}`);
  writeFileSync('test-artifacts/logs/types-baseline.log',(before.stdout||'')+(before.stderr||''));oldTypes=diagnostics(before);oldLint=await lint();
 } finally {restore();}
 const after=node(args,{NODE_OPTIONS:'--max-old-space-size=1200'});assert.ok(after.status===0||([1,2].includes(after.status)&&/error TS\d+:/.test(after.stdout)),`Candidate type checker did not complete: ${after.status} ${after.signal} ${(after.stderr||after.stdout||'').slice(-2500)}`);
 writeFileSync('test-artifacts/logs/types-candidate.log',(after.stdout||'')+(after.stderr||''));
 const newTypes=diagnostics(after),newLint=await lint();
 report.types={scope:runtime,baseline:oldTypes.length,current:newTypes.length,newErrors:difference(newTypes,oldTypes)};
 report.lint={baseline:oldLint.length,current:newLint.length,newErrors:difference(newLint,oldLint)};
 console.log(JSON.stringify({types:report.types,lint:report.lint}));
 assert.equal(report.types.newErrors.length,0);assert.equal(report.lint.newErrors.length,0);
 for(const file of runtime)assert.equal(node(['--check',file]).status,0);
}
async function coverage() {
 const result=node(['node_modules/c8/bin/c8.js','report','--all=false','--check-coverage=false',...runtime.map(file=>'--include='+file),
  '--temp-directory=test-artifacts/v8','--report-dir=test-artifacts/coverage','--reporter=json']);
 assert.equal(result.status,0,result.stderr);
 const {createCoverageMap}= (await import('istanbul-lib-coverage')).default;
 const map=createCoverageMap(JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json','utf8')));
 const browserDir='test-artifacts/hourly-browser';
 const entries=existsSync(browserDir)?readdirSync(browserDir).filter(file=>file.startsWith('coverage-')).flatMap(file=>JSON.parse(readFileSync(browserDir+'/'+file,'utf8'))):[];
 const convert=(await import('v8-to-istanbul')).default;
 for(const entry of entries) {
  const file='public'+new URL(entry.url).pathname;
  if(!runtime.includes(file)||!entry.functions)continue;
  const converter=convert(process.cwd()+'/'+file,0,{source:entry.source||entry.text||readFileSync(file,'utf8')});
  await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
 }
 report.coverage=[];
 for(const file of runtime) {
  const absolute=process.cwd()+'/'+file;
  const lines=map.files().includes(absolute)?map.fileCoverageFor(absolute).getLineCoverage():{};
  const source=readFileSync(file,'utf8').split('\n');
  const changed=input.changedLines[file].filter(line=>source[line-1].trim()&&!source[line-1].trim().startsWith('*')&&!source[line-1].trim().startsWith('/**'));
  const missing=changed.filter(line=>{
   if(lines[line]>0)return false;
   const offset=source.slice(0,line-1).join('\n').length+(line>1?1:0)+source[line-1].search(/\S/);
   return !entries.some(entry=>new URL(entry.url).pathname==='/'+file.replace(/^public\//,'') && entry.ranges?.some(range=>range.start<=offset&&range.end>offset));
  });
  report.coverage.push({file,covered:changed.length-missing.length,total:changed.length,missing});
 }
 console.log(JSON.stringify({coverage:report.coverage}));
 assert.ok(report.coverage.every(row=>row.missing.length===0),'Uncovered changed lines');
 
}
async function mutations() {
 const mutants=[
  {name:'hourly-boundary-early',file:'src/stock-request-so-refresh-repository.js',before:'< STOCK_REQUEST_SO_REFRESH_INTERVAL_MS',after:'< STOCK_REQUEST_SO_REFRESH_INTERVAL_MS / 2'},
  {name:'partial-means-complete',file:'src/stock-request-so-refresh-domain.js',before:'line.fulfilledQuantity >= line.quantity',after:'line.fulfilledQuantity > 0'},
  {name:'ignore-canonical-refresh-race',file:'src/stock-request-so-refresh-repository.js',before:'current.syncedAt!==candidate.syncedAt || ',after:''}
 ];
 report.mutations=[];
 for(const mutant of mutants) {
  const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2);
  try {
   writeFileSync(mutant.file,source.replace(mutant.before,mutant.after));
   const property=await run(focus[0],mutant.name+'-property');
   const integration=await run(focus[1],mutant.name+'-integration');
   const result={name:mutant.name,killed:property.failed>0||integration.failed>0,propertyKilled:property.failed>0,
    failingTests:[...(property.failures||[]),...(integration.failures||[])].map(row=>row.name)};
   report.mutations.push(result);assert.equal(result.killed,true,'Surviving mutant '+mutant.name);
  } finally {writeFileSync(mutant.file,source);}
 }
 for(const [file,hash] of Object.entries(input.files))assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),hash);
 for(const file of [...focus].reverse())assert.equal((await run(file,'restored-'+file)).status,0);
}
try {
 if(mode==='baseline')for(const file of Object.keys(input.files))writeFileSync(file,readFileSync('baseline/'+file));
 let files=mode==='baseline'?regression:mode==='focused'?focus:[...focus,...regression,...browserTests];
 if(mode==='gauntlet') {
  let seed=20261028;for(let i=files.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[files[i],files[j]]=[files[j],files[i]];}
  report.orderSeed=20261028;await staticChecks();
 }
 let passed=true;
 for(const file of files){const row=await run(file,file,mode==='gauntlet');passed=(row.status===0||row.existingFailures)&&passed;}
 assert.ok(passed,'New test failures');
 if(mode==='gauntlet'){await coverage();await mutations();}
 report.passed=true;
} catch(error){report.error=error.message;console.error(error);}
finally {restore();await client.end();writeFileSync('test-artifacts/report.json',JSON.stringify(report,null,2)+'\n');}
process.exitCode=report.passed?0:1;
