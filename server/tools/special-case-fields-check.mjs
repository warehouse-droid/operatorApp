import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ESLint } from 'eslint';
import { existing, own } from './special-case-fields-suites.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out=resolve('test-artifacts/special-case-fields-20261003');mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/special-case-fields-files.json'));
const js=files.filter(file=>file.endsWith('.js'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const hashes=()=>Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
function run(label,cmd,args,cwd=process.cwd()) {
 const result=spawnSync(cmd,args,{cwd,encoding:'utf8',timeout:600000,maxBuffer:40000000,env:{...process.env,SPECIAL_BATCH_BROWSER_OUTPUT:out+'/browser',SPECIAL_CASE_EDITS_BROWSER_OUTPUT:out+'/browser'}});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/'+label+'.log',log);
 assert.ok([0,1,2].includes(result.status),label+' did not finish: '+result.error);
 console.log(JSON.stringify({label,status:result.status,...counts(log)}));return {status:result.status,log};
}
function baseline() {
 const root='/tmp/special-case-fields-baseline-'+mode;
 rmSync(root,{force:true,recursive:true});mkdirSync(root);
 for(const folder of ['src','public','migrations','test','tools']) cpSync(folder,root+'/'+folder,{recursive:true});
 for(const file of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,root+'/'+file);
 symlinkSync('/app/node_modules',root+'/node_modules');
 for(const file of files) { const old=out+'/before/'+file;if(existsSync(old))cpSync(old,root+'/'+file);else rmSync(root+'/'+file,{force:true}); }
 return root;
}
const mode=process.argv[2]||'all';
if(['baseline','static','all'].includes(mode)) {
 const root=baseline();
 if(mode!=='static') {
  const result=run('baseline',process.execPath,['--test','--test-concurrency=1',...existing],root);
  assert.ok(counts(result.log).tests > 0, result.log);
  writeFileSync(out+'/baseline.json',JSON.stringify({counts:counts(result.log),failures:failures(result.log)}));
 }
 if(mode!=='baseline') {
  for(const file of js)assert.equal(run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]).status,0);
  const args=['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext'];
  const before=run('types-before','/app/node_modules/.bin/tsc',[...args,...js.filter(file=>existsSync(root+'/'+file))],root);
  const after=run('types-after','/app/node_modules/.bin/tsc',[...args,...js]);
  const messages=log=>log.split('\n').filter(line=>/error TS\d+/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/,''));
  const old=messages(before.log), added=messages(after.log).filter(line=>{const i=old.indexOf(line);if(i<0)return true;old.splice(i,1);return false;});
  writeFileSync(out+'/new-types.json',JSON.stringify(added,null,2));
  const lint=new ESLint({overrideConfigFile:resolve('tools/stock-request-layout-eslint.config.mjs')});
  const lintMessages=async(file,source)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  const newLint=[];
  for(const file of js) {
   const old=existsSync(root+'/'+file)?await lintMessages(file,readFileSync(root+'/'+file,'utf8')):[];
   const next=await lintMessages(file,readFileSync(file,'utf8'));
   for(const message of next) {const i=old.indexOf(message);if(i<0)newLint.push({file,message});else old.splice(i,1);}
  }
  writeFileSync(out+'/new-lint.json',JSON.stringify(newLint,null,2));
  console.log(JSON.stringify({newTypes:added,newLint}));assert.deepEqual(added,[]);assert.deepEqual(newLint,[]);
  writeFileSync(out+'/static.json',JSON.stringify({passed:true,sourceHashes:hashes()}));
 }
}
if(['tests','all'].includes(mode)) {
 function clearBrowserCoverage(dir) { if(!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})) {
  const path=dir+'/'+entry.name;if(entry.isDirectory())clearBrowserCoverage(path);else if(/^(?:browser-)?coverage-.*\.json$/.test(entry.name))rmSync(path);
 } }
 clearBrowserCoverage(resolve('test-artifacts'));
 const result=run('affected','/app/node_modules/.bin/c8',['--all=false','--check-coverage=false',...js.map(file=>'--include='+file),'--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json',process.execPath,'--test','--test-concurrency=1',...existing,...own]);
 const baseline=JSON.parse(readFileSync(out+'/baseline.json'));
 const added=failures(result.log).filter(name=>!baseline.failures.includes(name));
 writeFileSync(out+'/tests.json',JSON.stringify({sourceHashes:hashes(),counts:counts(result.log),newFailures:added,failures:failures(result.log)},null,2));
 console.log(JSON.stringify({newFailures:added}));assert.deepEqual(added,[]);
 const focus=run('focused',process.execPath,['--test','--test-concurrency=1',...own]);assert.equal(focus.status,0);
 writeFileSync(out+'/focused.json',JSON.stringify({sourceHashes:hashes(),counts:counts(focus.log)},null,2));
}
