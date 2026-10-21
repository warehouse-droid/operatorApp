import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out=resolve('test-artifacts/regular-stock-resolve-20261002'),files=JSON.parse(readFileSync('tools/regular-stock-resolve-files.json'));
const own=['test/mbt/unit/regular-stock-resolution.test.js','test/mbt/integration/regular-stock-resolution-http.test.js','test/mbt/integration/regular-stock-resolution-browser.test.js'];
const baseline=JSON.parse(readFileSync(out+'/baseline.json')),js=files.filter(file=>file.endsWith('.js')),newModules=js.filter(file=>!existsSync(out+'/before/'+file));
const sha=source=>createHash('sha256').update(source).digest('hex'),hashes=Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
function run(label,command,args,{cwd=process.cwd(),allowFailure=false}={}){
  const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:40000000});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/'+label+'.log',log);
  assert.ok(result.status===0||allowFailure&&[1,2].includes(result.status),label+': '+log.slice(-5000));
  console.log(JSON.stringify({label,exitCode:result.status,...counts(log)}));return {log,status:result.status};
}
function tree(){
  const root=mkdtempSync('/tmp/regular-stock-resolve-check-');
  for(const folder of ['src','public','migrations','test','tools'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const file of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,root+'/'+file);
  symlinkSync(resolve('node_modules'),root+'/node_modules','dir');return root;
}
const before=tree();
try{
  for(const file of files)if(existsSync(out+'/before/'+file))cpSync(out+'/before/'+file,before+'/'+file);
  for(const file of js)run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]);
  const typeArgs=['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','tools/regular-stock-resolution-globals.d.ts',...js.filter(file=>file!=='src/server.js')];
  const hunks=new Map(js.filter(file=>existsSync(out+'/before/'+file)).map(file=>{
    const diff=spawnSync('diff',['-U0',out+'/before/'+file,file],{encoding:'utf8'});assert.ok([0,1].includes(diff.status));
    return [file,[...diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match=>({oldCount:Number(match[2]??1),start:Number(match[3]),count:Number(match[4]??1)}))];
  }));
  const diagnostics=(result,current=false)=>result.log.split('\n').filter(line=>/error TS\d+/.test(line)).map(line=>{
    const match=line.match(/^(.+)\((\d+),(\d+)\): error (TS\d+):/);assert.ok(match,line);
    const [,file,number,column,code]=match,location=Number(number);let delta=0;
    if(current)for(const hunk of hunks.get(file)||[]){if(location>=hunk.start&&location<hunk.start+hunk.count)return file+':changed:'+number+':'+column+':'+code;if(location>=hunk.start+hunk.count)delta+=hunk.count-hunk.oldCount;}
    return file+':'+(location-delta)+':'+column+':'+code;
  }).sort();
  const previous=diagnostics(run('types-before',resolve('node_modules/.bin/tsc'),typeArgs,{cwd:before,allowFailure:true}));
  const current=diagnostics(run('types-after',resolve('node_modules/.bin/tsc'),typeArgs,{allowFailure:true}),true);
  const remaining=[...previous],added=current.filter(line=>{const index=remaining.indexOf(line);if(index<0)return true;remaining.splice(index,1);return false;});
  writeFileSync(out+'/new-types.json',JSON.stringify(added,null,2));assert.deepEqual(added,[],'No new type diagnostics');
  assert.deepEqual(current.filter(line=>newModules.some(file=>line.startsWith(file+':'))),[],'New modules must have no own type diagnostics');
  const lint=new ESLint({overrideConfigFile:resolve('tools/stock-request-layout-eslint.config.mjs')});
  const messages=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  for(const file of js){const old=existsSync(out+'/before/'+file)?await messages(readFileSync(out+'/before/'+file,'utf8'),file):[];const after=await messages(readFileSync(file,'utf8'),file);
    assert.deepEqual(after.filter(message=>{const i=old.indexOf(message);if(i<0)return true;old.splice(i,1);return false;}),[],file+' new lint findings');}
  run('lint-tests',resolve('node_modules/.bin/eslint'),['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...own,'tools/regular-stock-resolve-check.mjs','tools/regular-stock-resolve-baseline.mjs','tools/regular-stock-resolve-coverage.mjs','tools/regular-stock-resolve-queue-red.mjs']);
}finally{rmSync(before,{recursive:true,force:true});}
if(process.argv.includes('--static-only')){console.log(JSON.stringify({staticChecksPassed:true}));process.exit(0);}
rmSync(out+'/browser',{recursive:true,force:true});mkdirSync(out+'/browser',{recursive:true});
const final=run('final-tests',resolve('node_modules/.bin/c8'),['--all=false','--check-coverage=false',...js.map(file=>'--include='+file),
  '--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json',process.execPath,'--test','--test-concurrency=1',...baseline.tests,...own],{allowFailure:true});
assert.deepEqual(failures(final.log).filter(name=>!baseline.failures.includes(name)),[],'No new affected-suite failures');
const focused=run('focused-tests',process.execPath,['--test','--test-concurrency=1',...own]);
run('queue-draft-red',process.execPath,['tools/regular-stock-resolve-queue-red.mjs']);
run('changed-line-coverage',process.execPath,['tools/regular-stock-resolve-coverage.mjs']);
const shuffled=[...own].sort((a,b)=>sha('20261002'+a).localeCompare(sha('20261002'+b)));
for(const [i,file] of shuffled.entries())run('shuffled-'+i,process.execPath,['--test',file]);
const mutants=[
  ['allow-bad-calendar','if (!validDate)','if (false)',own[0],true],
  ['drop-replay','if (saved)','if (false)',own[1],false],
  ['drop-commitment-guard','if (commitments.rowCount)','if (false)',own[1],false],
  ['leave-lines-open',"SET status='closed',regular_decision='po'","SET status=status,regular_decision='po'",own[1],false],
  ['lose-sales-notice','manual_decision_event_id=$2','manual_decision_event_id=manual_decision_event_id',own[1],false]
];
const root=tree(),module='src/regular-stock-resolution.js',path=root+'/'+module,source=readFileSync(module,'utf8');
try{
  for(const [name,needle,replacement,file,property] of mutants){assert.equal(source.split(needle).length,2,name);
    try{writeFileSync(path,source.replace(needle,replacement));const result=run('mutant-'+name,process.execPath,['--test',...(property?['--test-name-pattern=^property:']:[]),file],{cwd:root,allowFailure:true});assert.equal(result.status,1,name+' survived');assert.ok(failures(result.log).length,name+' did not fail an assertion');}
    finally{writeFileSync(path,source);}
  }
}finally{rmSync(root,{recursive:true,force:true});}
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files,...own,'tools/regular-stock-resolve-check.mjs']);
assert.deepEqual(Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))])),hashes);
const result={completed:true,sourceHashes:hashes,baseline:baseline.counts,baselineFailures:baseline.failures,affected:counts(final.log),focused:counts(focused.log),newFailures:[],newTypeDiagnostics:0,newLintFindings:0,
  changedLines:JSON.parse(readFileSync(out+'/changed-lines.json')),mutantsKilled:mutants.length+1,queueDraftMutantKilled:1,propertyMutantsKilled:1,propertyCases:400,shuffledFiles:shuffled,
  dependenciesChanged:false,specApproval:'not obtained (autonomous run)',typeScope:'changed modules; server checked by syntax/lint and authenticated HTTP',
  tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
writeFileSync(out+'/checks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
