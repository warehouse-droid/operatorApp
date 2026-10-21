import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';
import {existing,own} from './special-po-so-note-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out=resolve('test-artifacts/special-po-so-note-20261001');mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/special-po-so-note-files.json'));
const js=files.filter(file=>file.endsWith('.js'));
const newModules=js.filter(file=>!existsSync(out+'/before/'+file));
const sha=source=>createHash('sha256').update(source).digest('hex');
const hashes=Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
function run(label,command,args,{cwd=process.cwd(),allowFailure=false}={}) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:240000,maxBuffer:40000000,
    env:{...process.env,SPECIAL_BATCH_BROWSER_OUTPUT:out+'/browser'}});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/'+label+'.log',log);
  assert.ok(result.status===0 || allowFailure && [1,2].includes(result.status),label+': '+log.slice(-5000));
  console.log(JSON.stringify({label,exitCode:result.status,...counts(log)}));return {log,status:result.status};
}
function tree() {
  const root=mkdtempSync('/tmp/po-so-note-check-');
  for(const folder of ['src','public','migrations','test','tools'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const file of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,root+'/'+file);
  symlinkSync(resolve('node_modules'),root+'/node_modules','dir');return root;
}
run('isolated-schema',process.execPath,['tools/special-po-so-note-isolated.mjs']);
const baseline=tree();let previous;
try {
  for(const file of files)if(existsSync(out+'/before/'+file))cpSync(out+'/before/'+file,baseline+'/'+file);
  previous=run('baseline-tests',process.execPath,['--test','--test-concurrency=1','--test-name-pattern=^(?!history refresh carries)',...existing],{cwd:baseline,allowFailure:true});
  for(const file of js)run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]);
  const typeArgs=['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...js];
  const hunks=new Map(js.filter(file=>existsSync(out+'/before/'+file)).map(file=>{
    const diff=spawnSync('diff',['-U0',out+'/before/'+file,file],{encoding:'utf8'});
    assert.ok([0,1].includes(diff.status));
    return [file,[...diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match=>
      ({oldStart:Number(match[1]),oldCount:Number(match[2]??1),start:Number(match[3]),count:Number(match[4]??1)}))];
  }));
  // Compare diagnostics at their original source positions. TypeScript may
  // reorder/truncate a pre-existing union-type error's rendered message.
  // Errors on added/changed lines are always new; those cannot be normalized.
  const diagnostics=(result,current=false)=>result.log.split('\n').filter(line=>/error TS\d+/.test(line)).map(line=>{
    const match=line.match(/^(.+)\((\d+),(\d+)\): error (TS\d+):/);assert.ok(match,line);
    const [,file,number,column,code]=match,location=Number(number);let delta=0;
    if(current)for(const hunk of hunks.get(file)||[]){
      if(location>=hunk.start && location<hunk.start+hunk.count)return file+':changed:'+number+':'+column+':'+code;
      if(location>=hunk.start+hunk.count)delta+=hunk.count-hunk.oldCount;
    }
    return file+':'+(location-delta)+':'+column+':'+code;
  }).sort();
  const oldTypes=diagnostics(run('types-before',resolve('node_modules/.bin/tsc'),typeArgs,{cwd:baseline,allowFailure:true}));
  const newTypeResult=run('types-after',resolve('node_modules/.bin/tsc'),typeArgs,{allowFailure:true});
  const newTypes=diagnostics(newTypeResult,true);
  const remaining=[...oldTypes],added=newTypes.filter(line=>{const i=remaining.indexOf(line);if(i<0)return true;remaining.splice(i,1);return false;});
  writeFileSync(out+'/new-types.json',JSON.stringify(added,null,2));assert.deepEqual(added,[],'No new type errors');
  assert.deepEqual(newTypes.filter(line=>newModules.some(file=>line.startsWith(file+':'))),[],'New modules have no own type errors');
  const lint=new ESLint({overrideConfigFile:resolve('tools/stock-request-layout-eslint.config.mjs')});
  const messages=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  for(const file of js) {
    const before=existsSync(out+'/before/'+file)?await messages(readFileSync(out+'/before/'+file,'utf8'),file):[];
    const after=await messages(readFileSync(file,'utf8'),file);
    assert.deepEqual(after.filter(message=>{const i=before.indexOf(message);if(i<0)return true;before.splice(i,1);return false;}),[],file+' has new lint findings');
  }
  run('lint-tests',resolve('node_modules/.bin/eslint'),['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...own,
    'tools/special-po-so-note-check.mjs','tools/special-po-so-note-suites.mjs','tools/special-po-so-note-isolated.mjs',
    'tools/special-po-so-note-worker-read.mjs','tools/special-po-so-note-shuffled.mjs']);
} finally {rmSync(baseline,{recursive:true,force:true});}

rmSync(out+'/browser',{recursive:true,force:true});mkdirSync(out+'/browser',{recursive:true});
const final=run('final-tests',resolve('node_modules/.bin/c8'),['--all=false','--check-coverage=false',...js.map(file=>'--include='+file),
  '--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json',process.execPath,'--test','--test-concurrency=1',...existing,...own],{allowFailure:true});
assert.deepEqual(failures(final.log).filter(name=>!failures(previous.log).includes(name)),[],'No new regressions');
assert.equal(failures(final.log).includes('history refresh carries the actual PO Note into canonical sync separately from memo'),false,
  'The added history Note regression assertion must pass');
run('focused-tests',process.execPath,['--test','--test-concurrency=1',...own]);
run('changed-line-coverage',process.execPath,['tools/special-po-so-note-coverage.mjs']);
run('worker-note-sync',process.execPath,['tools/special-po-so-note-worker-check.mjs']);
run('worker-note-reads',process.execPath,['tools/special-po-so-note-worker-read.mjs']);
run('focused-shuffled-tests',process.execPath,['tools/special-po-so-note-shuffled.mjs']);
const mutantRoot=tree();
const mutants=[
  ['drop-so-note','src/special-stock-request-netsuite.js','if (salesOrderNumber) payload.custbody7 = `for ${salesOrderNumber}`;','if (salesOrderNumber) payload.custbody8 = `for ${salesOrderNumber}`;',[own[0]],true],
  ['wrong-note-prefix','src/special-stock-request-netsuite.js','`for ${salesOrderNumber}`','`FOR ${salesOrderNumber}`',[own[0]],true],
  ['fabricate-blank-so-note','src/special-stock-request-netsuite.js','if (salesOrderNumber) payload.custbody7','if (true) payload.custbody7',[own[0]],false],
  ['ignore-existing-marker','src/special-stock-request-service.js','const rows = await findMarkerOrders({ caseId, orderKind, entityId, salesOrderId });','const rows = [];',[own[0]],false],
  ['accept-invalid-note-input','src/special-stock-purchase-order-note-adapter.js',"typeof input.note!=='string' || input.note.length>4000 || typeof input.expectedNote!=='string'",'false',[own[1]],false],
  ['overwrite-stale-note','src/special-stock-purchase-order-note-adapter.js','current!==input.expectedNote','false',[own[1]],false],
  ['write-note-as-remark','src/special-stock-purchase-order-note-adapter.js','body:{custbody7:input.note}','body:{memo:input.note}',[own[1]],false],
  ['save-remote-note-locally','src/special-stock-purchase-order-routing.js',"['notes','expectedNote'","['expectedNote'",[own[2]],false],
  ['drop-history-note','src/scm-netsuite-po-history-service.js','netsuite_note: snapshot.note ?? null','netsuite_note: null',['test/mbt/unit/smart-scm-created-po-service.test.js'],false]
];
try {
  for(const [name,file,before,after,suites,property] of mutants) {
    const path=mutantRoot+'/'+file,source=readFileSync(path,'utf8');assert.equal(source.split(before).length,2,name);
    try {
      writeFileSync(path,source.replace(before,after));
      const result=run('mutant-'+name,process.execPath,['--test','--test-concurrency=1',...(property?['--test-name-pattern=^property:']:[]),...suites],{cwd:mutantRoot,allowFailure:true});
      assert.equal(result.status,1,name+' survived');assert.ok(failures(result.log).length,name+' failed without an assertion');
    } finally {writeFileSync(path,source);}
  }
} finally {rmSync(mutantRoot,{recursive:true,force:true});}
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files,...own,'tools/special-po-so-note-check.mjs']);
assert.deepEqual(Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))])),hashes);
const result={completed:true,...counts(final.log),baselineFailures:failures(previous.log),finalFailures:failures(final.log),newFailures:[],newTypeDiagnostics:0,newLintFindings:0,
  mutantsKilled:mutants.length,propertyMutantsKilled:2,sourceHashes:hashes,
  tools:{node:process.version,coverageDiffGit:JSON.parse(readFileSync(out+'/changed-diffs.json')).gitVersion,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
writeFileSync(out+'/checks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
