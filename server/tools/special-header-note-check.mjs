import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';
import {existing,own} from './special-header-note-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const staticOnly=process.argv.includes('--static-only');
const out=resolve('test-artifacts/special-header-note-20261001');mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/special-header-note-files.json'));
const js=files.filter(file=>file.endsWith('.js'));
const newModules=js.filter(file=>!existsSync(out+'/before/'+file));
const sha=source=>createHash('sha256').update(source).digest('hex');
const hashes=Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
function run(label,command,args,{cwd=process.cwd(),allowFailure=false}={}) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:240000,maxBuffer:40000000,
    env:{...process.env,SPECIAL_BATCH_BROWSER_OUTPUT:out+'/routing-browser',SPECIAL_ENHANCEMENTS_BROWSER_OUTPUT:out+'/sales-browser',
      SPECIAL_SALES_ACTIONS_BROWSER_OUTPUT:out+'/sales-actions-browser',SPECIAL_QUOTE_PALLET_BROWSER_OUTPUT:out+'/quote-browser',SPECIAL_CASE_EDITS_BROWSER_OUTPUT:out+'/case-browser',SPECIAL_HEADER_NOTE_BROWSER_OUTPUT:out+'/browser',SPECIAL_QUOTE_PALLET_OUTPUT:out+'/pdf'}});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/'+label+'.log',log);
  assert.ok(result.status===0 || allowFailure && [1,2].includes(result.status),label+': '+log.slice(-5000));
  console.log(JSON.stringify({label,exitCode:result.status,...counts(log)}));return {log,status:result.status};
}
function tree() {
  const root=mkdtempSync('/tmp/special-items-copy-check-');
  for(const folder of ['src','public','migrations','test','tools'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const file of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,root+'/'+file);
  symlinkSync(resolve('node_modules'),root+'/node_modules','dir');return root;
}
const baseline=tree();let previous;
try {
  for(const file of files)if(existsSync(out+'/before/'+file))cpSync(out+'/before/'+file,baseline+'/'+file);
  if(!staticOnly){
    previous=run('baseline-tests',process.execPath,['--test','--test-concurrency=1',...existing],{cwd:baseline,allowFailure:true});
    const fulfillment=baseline+'/public/special-stock-fulfillment.js';
    writeFileSync(fulfillment,readFileSync(fulfillment,'utf8')+readFileSync(out+'/red-stub.js','utf8'));
    const red=run('red-acceptance',process.execPath,['--test','--test-concurrency=1',...own],{cwd:baseline,allowFailure:true});
    assert.equal(red.status,1,'Captured live source must reproduce the missing header Note editor');
    const initialRed=failures(readFileSync(out+'/red-tests.log','utf8')+readFileSync(out+'/red-browser.log','utf8')+readFileSync(out+'/red-blank-lines.log','utf8'));
    assert.equal(initialRed.length,22);
    assert.deepEqual(initialRed.filter(name=>!failures(red.log).includes(name)),[],'All original header acceptance cases must fail against captured live source');
    cpSync(out+'/before/public/special-stock-fulfillment.js',fulfillment);
  }
  for(const file of js)run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]);
  const typeArgs=['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...js];
  const hunks=new Map(js.filter(file=>existsSync(out+'/before/'+file)).map(file=>{
    const diff=spawnSync('diff',['-U0',out+'/before/'+file,file],{encoding:'utf8'});assert.ok([0,1].includes(diff.status));
    return [file,[...diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match=>
      ({oldStart:Number(match[1]),oldCount:Number(match[2]??1),start:Number(match[3]),count:Number(match[4]??1)}))];
  }));
  const diagnostics=(result,current=false)=>result.log.split('\n').filter(line=>/error TS\d+/.test(line)).map(line=>{
    const match=line.match(/^(.+)\((\d+),(\d+)\): error (TS\d+):/);assert.ok(match,line);
    const [,file,number,,code]=match,location=Number(number);let delta=0;
    if(current)for(const hunk of hunks.get(file)||[]){
      if(location>=hunk.start && location<hunk.start+hunk.count) {
        if(hunk.count===1 && hunk.oldCount===1)return file+':'+hunk.oldStart+':'+code+':'+line.slice(line.indexOf(': error '));
        return file+':changed:'+number+':'+code+':'+line.slice(line.indexOf(': error '));
      }
      if(location>=hunk.start+hunk.count)delta+=hunk.count-hunk.oldCount;
    }
    return file+':'+(location-delta)+':'+code+':'+line.slice(line.indexOf(': error '));
  }).sort();
  const oldTypes=diagnostics(run('types-before',resolve('node_modules/.bin/tsc'),typeArgs,{cwd:baseline,allowFailure:true}));
  const newTypes=diagnostics(run('types-after',resolve('node_modules/.bin/tsc'),typeArgs,{allowFailure:true}),true);
  const remaining=[...oldTypes],added=newTypes.filter(line=>{const i=remaining.indexOf(line);if(i<0)return true;remaining.splice(i,1);return false;});
  writeFileSync(out+'/new-types.json',JSON.stringify(added,null,2));assert.deepEqual(added,[],'No new type errors');
  assert.deepEqual(newTypes.filter(line=>newModules.some(file=>line.startsWith(file+':'))),[],'New module own type errors');
  const lint=new ESLint({overrideConfigFile:resolve('tools/stock-request-layout-eslint.config.mjs')});
  const messages=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  for(const file of js){
    const before=existsSync(out+'/before/'+file)?await messages(readFileSync(out+'/before/'+file,'utf8'),file):[];
    const after=await messages(readFileSync(file,'utf8'),file);
    assert.deepEqual(after.filter(message=>{const i=before.indexOf(message);if(i<0)return true;before.splice(i,1);return false;}),[],file+' new lint findings');
  }
  run('lint-tests',resolve('node_modules/.bin/eslint'),['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...own,
    'tools/special-header-note-check.mjs','tools/special-header-note-suites.mjs','tools/special-header-note-coverage.mjs']);
} finally {rmSync(baseline,{recursive:true,force:true});}
if(staticOnly){console.log(JSON.stringify({staticChecksPassed:true,newTypeDiagnostics:0,newLintFindings:0}));process.exit(0);}

for(const dir of ['browser','case-browser','quote-browser','sales-browser','routing-browser','sales-actions-browser']){rmSync(out+'/'+dir,{recursive:true,force:true});mkdirSync(out+'/'+dir,{recursive:true});}
const final=run('final-tests',resolve('node_modules/.bin/c8'),['--all=false','--check-coverage=false',...js.map(file=>'--include='+file),
  '--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json',process.execPath,'--test','--test-concurrency=1',...existing,...own],{allowFailure:true});
assert.deepEqual(failures(final.log).filter(name=>!failures(previous.log).includes(name)),[],'No new affected-suite regressions');
const focused=run('focused-tests',process.execPath,['--test','--test-concurrency=1',...own]);
run('changed-line-coverage',process.execPath,['tools/special-header-note-coverage.mjs']);
const shuffled=[...own].sort((a,b)=>sha('2026100143'+a).localeCompare(sha('2026100143'+b)));
for(const [index,file] of shuffled.entries())run('shuffled-'+index,process.execPath,['--test',file]);
writeFileSync(out+'/shuffled-order.json',JSON.stringify({seed:2026100143,files:shuffled},null,2));

const mutants=[
  ['drop-chinese','public/special-stock-fulfillment.js',null,"return value.replace(/\\r\\n?/g, '\\n');","return value.replace(/[^\\x00-\\x7f]/g, '').replace(/\\r\\n?/g, '\\n');",[own[0]],true],
  ['erase-line-breaks','public/special-stock-fulfillment.js',null,"return value.replace(/\\r\\n?/g, '\\n');","return value.replace(/\\r\\n?/g, '');",[own[0]],true],
  ['trim-note-whitespace','public/special-stock-fulfillment.js',null,"return value.replace(/\\r\\n?/g, '\\n');","return value.trim().replace(/\\r\\n?/g, '\\n');",[own[0]],true],
  ['allow-issued-header-edits','src/special-stock-request-repository.js','export async function updateSpecialStockHeader','if (!canEditSpecialHeader(detail))','if (false)',[own[1]],false],
  ['restart-header-status','src/special-stock-request-repository.js','export async function updateSpecialStockHeader','SET remarks=$2, revision=revision+1',"SET remarks=$2, status=\\'submitted\\', revision=revision+1",[own[1]],false]
];
const mutantRoot=tree();
try {
  for(const [name,file,scope,before,after,suites,property] of mutants){
    const path=mutantRoot+'/'+file,source=readFileSync(path,'utf8');
    const start=scope?source.indexOf(scope):0,end=scope?source.indexOf('\nexport async function claimSpecialFulfillmentChange',start):source.length;
    assert.ok(start>=0&&end>start,name);const selected=source.slice(start,end);assert.equal(selected.split(before).length,2,name);
    try{
      writeFileSync(path,source.slice(0,start)+selected.replace(before,after)+source.slice(end));
      run('mutant-syntax-'+name,process.execPath,['--check',file],{cwd:mutantRoot});
      const result=run('mutant-'+name,process.execPath,['--test','--test-concurrency=1',...(property?['--test-name-pattern=^property:']:[]),...suites],{cwd:mutantRoot,allowFailure:true});
      assert.equal(result.status,1,name+' survived');assert.ok(failures(result.log).length,name+' failed without an assertion');
    }finally{writeFileSync(path,source);}
  }
}finally{rmSync(mutantRoot,{recursive:true,force:true});}
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files,...own,'tools/special-header-note-check.mjs']);
assert.deepEqual(Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))])),hashes);
const result={completed:true,sourceHashes:hashes,affected:counts(final.log),focused:counts(focused.log),
  baselineFailures:failures(previous.log),finalFailures:failures(final.log),newFailures:[],newTypeDiagnostics:0,newLintFindings:0,
  mutantsKilled:mutants.length,propertyMutantsKilled:3,propertyRuns:400,shuffledFiles:shuffled,
  changedLines:JSON.parse(readFileSync(out+'/changed-lines.json')),
  specApproval:'not obtained (autonomous run)',dependenciesChanged:false,
  tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
writeFileSync(out+'/checks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
