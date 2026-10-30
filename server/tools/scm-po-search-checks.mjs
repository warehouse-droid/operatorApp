import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

if (process.env.MBT_TEST_ISOLATED !== '1') throw new Error('Disposable database required');
const focused='test/dispatch/integration/scm-po-search-recovery.test.js';
const files=['src/scm-purchase-order-catalog-repository.js','src/dispatch-repository.js','src/server.js'];
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const report={passed:true,node:process.version,hashes:Object.fromEntries(files.map(file=>[file,hash(file)])),layers:[]};
const outputFile='test-artifacts/scm-po-search-report.json';
const persist=()=>writeFileSync(outputFile,JSON.stringify(report,null,2)+'\n');
const failures=output=>[...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match=>match[1]).sort();
function run(name,args,{expectFailure=false,quiet=true,allowedFailures=[]}={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
  const output=(result.stdout||'')+(result.stderr||'');
  const actualFailures=failures(output);
  const baselineOnly=result.status===1&&actualFailures.length>0&&JSON.stringify(actualFailures)===JSON.stringify(allowedFailures);
  const passed=expectFailure?result.status!==0&&/not ok \d/u.test(output)&&!/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output):result.status===0||baselineOnly;
  report.layers.push({name,passed,exitCode:result.status,knownBaselineFailures:baselineOnly?actualFailures:[],summary:output.split('\n').filter(line=>/^# (tests|pass|fail|duration_ms)|^not ok/u.test(line)),...(!passed?{error:[...output.matchAll(/not ok [\s\S]*?\n  \.\.\./gu)].map(match=>match[0]).join('\n').slice(0,18000)||output.slice(-10000)}:{})});
  report.passed&&=passed; persist();
  console.log(JSON.stringify(report.layers.at(-1)));
  if(!quiet) process.stdout.write(output);
  return output;
}
const suites=[focused,'test/workload/integration/scm-po-catalog.red.test.js',
  'test/dispatch/unit/scm-purchase-order-catalog-status.test.js','test/dispatch/property/scm-purchase-order-catalog-status.property.test.js',
  ...readdirSync('test/dispatch/integration').filter(name=>name.startsWith('scm-')||name.startsWith('direct-linked-po-')||name==='direct-ship-po-planning.test.js').map(name=>'test/dispatch/integration/'+name),
  'test/mbt/integration/scm-schedule-search.test.js','test/mbt/integration/scm-cancelled-split-schedule.test.js'];
const unique=[...new Set(suites)];
const sources=Object.fromEntries(files.map(file=>[file,readFileSync(file,'utf8')]));
let baselineFailures=[];
try {
  for(const file of files) writeFileSync(file,readFileSync('test-artifacts/before/'+file));
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...unique.filter(file=>file!==focused)],{encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
  if(result.signal||result.error) throw result.error||new Error('Baseline suite terminated');
  const output=(result.stdout||'')+(result.stderr||'');
  baselineFailures=failures(output);
  report.baseline={exitCode:result.status,failures:baselineFailures,evidence:[...output.matchAll(/not ok [\s\S]*?\n  \.\.\./gu)].map(match=>match[0])};
  console.log(JSON.stringify({baselineFailures}));
} finally {for(const [file,source] of Object.entries(sources)) writeFileSync(file,source);}
run('reset disposable database between baseline and candidate',['--input-type=module','-e',
  "import pg from 'pg';const url=new URL(process.env.DATABASE_URL);if(process.env.MBT_TEST_ISOLATED!=='1'||url.pathname!=='/mbt_test'||url.hostname!=='db')throw new Error('Disposable database required');url.pathname='/postgres';const client=new pg.Client({connectionString:url.toString()});await client.connect();try{await client.query('DROP DATABASE mbt_test WITH (FORCE)');await client.query('CREATE DATABASE mbt_test');}finally{await client.end();}"]);
if(!report.layers.at(-1).passed) throw new Error('Fresh candidate database reset failed');
run('migrate fresh candidate database',['src/migrate.js']);
if(!report.layers.at(-1).passed) throw new Error('Fresh candidate database migration failed');
writeFileSync('test-artifacts/c8.json','{}');
run('complete affected SCM suites',['node_modules/c8/bin/c8.js','--config=test-artifacts/c8.json','--all=false',...files.map(file=>'--include='+file),'--reporter=json','--reporter=text-summary','--reports-dir=test-artifacts/coverage',process.execPath,'--test','--test-concurrency=1',...unique],{allowedFailures:baselineFailures});
for(const file of files) run('syntax '+file,['--check',file]);
writeFileSync('test-artifacts/eslint.config.mjs',`export default [{files:['**/*.js'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:Object.fromEntries(['Buffer','process','console','URL','URLSearchParams','fetch','setTimeout','setInterval','clearTimeout','clearInterval','structuredClone','AbortController','AbortSignal','TextEncoder','TextDecoder','performance','FormData','Blob','Headers','Response','setImmediate'].map(k=>[k,'readonly']))},rules:{'no-undef':'error','no-unreachable':'error','no-dupe-args':'error','no-dupe-keys':'error','no-duplicate-case':'error','valid-typeof':'error'}}];`);
const lintArgs=['node_modules/eslint/bin/eslint.js','--config','test-artifacts/eslint.config.mjs','--format','json',...files];
function lintDiagnostics() {
  const result=spawnSync(process.execPath,lintArgs,{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
  if(![0,1].includes(result.status)) throw new Error(result.stderr||'Linter terminated');
  return JSON.parse(result.stdout).flatMap(row=>row.messages.map(message=>row.filePath.replace(process.cwd()+'/','')+': '+message.ruleId+': '+message.message)).sort();
}
const candidateLint=lintDiagnostics();
try {
  for(const file of files) writeFileSync(file,readFileSync('test-artifacts/before/'+file));
  const baselineLint=lintDiagnostics(),added=[...candidateLint];
  for(const issue of baselineLint){const i=added.indexOf(issue);if(i>=0)added.splice(i,1);}
  report.lint={baseline:baselineLint,candidate:candidateLint,newErrors:added};report.passed&&=added.length===0;
} finally {for(const [file,source] of Object.entries(sources)) writeFileSync(file,source);}
const changed=JSON.parse(readFileSync('test-artifacts/changed-lines.json','utf8'));
const coverage=JSON.parse(readFileSync('test-artifacts/coverage/coverage-final.json','utf8'));
report.changedCoverage={};
for(const [file,lines] of Object.entries(changed)) {
  const data=Object.entries(coverage).find(([key])=>key.endsWith('/'+file))?.[1];
  const measured=new Set(),covered=new Set();
  for(const [key,location] of Object.entries(data?.statementMap||{})) {
    for(const line of lines.filter(n=>n>=location.start.line&&n<=location.end.line)) {
      measured.add(line); if(data.s[key]>0) covered.add(line);
    }
  }
  report.changedCoverage[file]={covered:covered.size,measured:measured.size,uncovered:[...measured].filter(n=>!covered.has(n))};
  report.passed&&=measured.size>0&&covered.size===measured.size;
}
const typeArgs=['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--noResolve','--target','ES2022','--module','NodeNext',...files];
function typeDiagnostics() {
  const result=spawnSync(process.execPath,typeArgs,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
  if(result.signal||result.error) throw result.error||new Error('Type checker terminated');
  return (result.stdout||'').split('\n').filter(line=>/error TS\d/u.test(line)).map(line=>line.replace(/\(\d+,\d+\)/u,'')).sort();
}
const candidateTypes=typeDiagnostics();
try {
  for(const file of files) writeFileSync(file,readFileSync('test-artifacts/before/'+file));
  const baselineTypes=typeDiagnostics();
  const added=[...candidateTypes];
  for(const issue of baselineTypes) {const index=added.indexOf(issue);if(index>=0) added.splice(index,1);}
  report.types={baseline:baselineTypes.length,candidate:candidateTypes.length,newErrors:added};
  report.passed&&=added.length===0;
} finally {for(const [file,source] of Object.entries(sources)) writeFileSync(file,source);}
const mutations=[
  ['expired claim recovery','src/scm-purchase-order-catalog-repository.js',"updated_at < now() - interval '5 minutes'","updated_at > now() - interval '5 minutes'"],
  ['old worker fencing','src/scm-purchase-order-catalog-repository.js',"WHERE id = $1 AND status = 'running' AND updated_at = $2::timestamptz\n        FOR UPDATE","WHERE id = $1 AND status = 'running' AND $2::timestamptz IS NOT NULL\n        FOR UPDATE"],
  ['active work row lock','src/scm-purchase-order-catalog-repository.js','AND updated_at = $2::timestamptz\n        FOR UPDATE','AND updated_at = $2::timestamptz'],
  ['bounded delivery work','src/dispatch-repository.js',"AND allocation.po_order_id IN (SELECT source_id FROM base WHERE order_kind = 'PO')","AND true"],
  ['typed Driver references','src/dispatch-repository.js','AND job.order_refs ? reference.ref','AND true'],
  ['bounded linked plans','src/dispatch-repository.js',"WHERE allocation.status = 'active'\n         AND allocation.po_order_id IN (SELECT source_id FROM base WHERE order_kind = 'PO')\n         AND (dispatch_po_link_fully_covers", "WHERE allocation.status = 'active'\n         AND (dispatch_po_link_fully_covers"]
];
report.propertyMutation=[];
if(report.passed) for(const [name,file,from,to] of mutations) {
  const source=sources[file]; if(!source.includes(from)) throw new Error('Mutation anchor moved: '+name);
  try {
    writeFileSync(file,source.replace(from,to));
    run('mutation: '+name,['--test','--test-concurrency=1',focused],{expectFailure:true});
    const result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-name-pattern=claim ownership is exclusive',focused],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
    const output=(result.stdout||'')+(result.stderr||'');
    if(![0,1].includes(result.status)||/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output)) throw new Error('Property mutation run failed: '+name);
    report.propertyMutation.push({name,killed:result.status===1&&/not ok \d/u.test(output),failures:failures(output)});
  }
  finally {writeFileSync(file,source);}
}
if(report.passed) run('restored suites in reverse order',['--test','--test-concurrency=1','test/dispatch/integration/scm-schedule-split-parity.test.js',focused,'test/dispatch/property/scm-purchase-order-catalog-status.property.test.js']);
report.sourceRestored=files.every(file=>hash(file)===report.hashes[file]);report.passed&&=report.sourceRestored;
persist();console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
