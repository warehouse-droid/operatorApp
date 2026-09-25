import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
const artifact='test-artifacts/load-followup';
const sources=[...JSON.parse(fs.readFileSync(`${artifact}/files.json`)).filter(file=>file.startsWith('src/')),'src/operator-load-state.js','src/operator-load-state-repository.js'];
const tests=['test/mbt/unit/load-followup.test.js','test/mbt/unit/load-followup-posting.test.js','test/mbt/integration/load-followup.test.js','test/mbt/integration/load-followup-repair.test.js','test/workload/integration/load-followup-webhook.test.js'];
const adjacent=['test/workload/unit/netsuite-order-webhook-queue-policy.red.test.js','test/workload/integration/netsuite-order-webhook-queue.red.test.js',
 'test/mbt/unit/operator-direct-orderline-service.test.js','test/mbt/unit/operator-direct-orderline-client.test.js','test/mbt/unit/operator-netsuite-posting-service.red.test.js','test/mbt/unit/operator-netsuite-posting-domain.red.test.js','test/mbt/unit/operator-netsuite-posting-admission.red.test.js',
 'test/mbt/integration/operator-netsuite-posting-repository.red.test.js','test/mbt/integration/operator-ui-enhancements.test.js','test/mbt/integration/receiving-followup.test.js','test/mbt/integration/operator-direct-orderline.test.js','test/mbt/property/operator-netsuite-posting.property.test.js'];
const hashes=()=>Object.fromEntries([...sources,'public/operator.js','tools/sob120541-repair.mjs'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
function run(args,name){const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:180000});const output=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(`${artifact}/${name}.log`,output);assert.ok(!result.error,String(result.error));return{status:result.status,output};}
function save(name,result){fs.writeFileSync(`${artifact}/${name}.json`,JSON.stringify({...result,sourceHashes:hashes()},null,2));console.log(JSON.stringify(result));}
const mode=process.argv[2];
if(mode==='baseline-static'||mode==='static'){
 const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.{js,mjs}'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{process:'readonly',console:'readonly',Buffer:'readonly',structuredClone:'readonly',setTimeout:'readonly',clearTimeout:'readonly',setInterval:'readonly',clearInterval:'readonly',fetch:'readonly',URL:'readonly',AbortSignal:'readonly'}},rules:{'no-undef':'error','no-unused-vars':'error','no-unreachable':'error','eqeqeq':'error'}}]});
 const lint=(await eslint.lintFiles(sources)).flatMap(row=>row.messages.map(message=>({file:row.filePath.split('/app/').at(-1),rule:message.ruleId,message:message.message})));
 const types=run(['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','nodenext','--target','ES2022',...sources],`${mode}-types`);
 const diagnostics=types.output.split('\n').filter(line=>/error TS\d+/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/,'(line,column)')).sort();
 for(const file of [...sources,'public/operator.js','tools/sob120541-repair.mjs',...tests])assert.equal(run(['--check',file],`${mode}-syntax-${file.split('/').at(-1)}`).status,0,file);
 if(mode==='static'){
  const baseline=JSON.parse(fs.readFileSync(`${artifact}/baseline-static.json`));
  const extra=(after,before)=>{const remaining=[...before];return after.filter(item=>{const i=remaining.indexOf(item);if(i>=0){remaining.splice(i,1);return false;}return true;});};
  const newLint=extra(lint.map(JSON.stringify),baseline.lint.map(JSON.stringify)),newTypes=extra(diagnostics,baseline.diagnostics);
  assert.deepEqual(diagnostics.filter(line=>/^src\/operator-load-state(?:-repository)?\.js/.test(line)),[], 'New modules must typecheck without diagnostics');
  save('static',{lint,diagnostics,newLint,newTypes});assert.deepEqual(newLint,[]);assert.deepEqual(newTypes,[]);
 }else save(mode,{lint,diagnostics});
}else if(mode==='suite'){
 const result=run(['--test','--test-concurrency=1',...tests,...adjacent],'suite');
 save('suite',{status:result.status,counts:result.output.split('\n').filter(line=>/^# (tests|pass|fail|cancelled|skipped)/.test(line))});assert.equal(result.status,0);
}else if(mode==='coverage'){
 const covered=[...sources,'tools/sob120541-repair.mjs'];
 const result=run(['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false','--reporter=json','--reporter=json-summary',`--temp-directory=${artifact}/c8-tmp`,`--report-dir=${artifact}/coverage`,...covered.map(file=>`--include=${file}`),'node','--test','--test-concurrency=1',...tests,...adjacent,'test/mbt/integration/operator-direct-orderline-http.test.js','test/mbt/unit/consolidation-load-posting.test.js','test/mbt/integration/consolidation-load.test.js'],'coverage');
 assert.equal(result.status,0,result.output);
 const coverage=JSON.parse(fs.readFileSync(`${artifact}/coverage/coverage-final.json`)),changed={};
 for(const file of covered){
  const old=fs.existsSync(`${artifact}/baseline/${file}`)?`${artifact}/baseline/${file}`:'/dev/null';
  const patch=spawnSync('diff',['-U0',old,file],{encoding:'utf8'}).stdout,lines=[];
  for(const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm))for(let i=0;i<Number(match[2]??1);i++)lines.push(Number(match[1])+i);
  const c=Object.values(coverage).find(row=>row.path.endsWith('/'+file));assert.ok(c,`No coverage for ${file}`);
  const executable=lines.filter(line=>Object.values(c.statementMap).some(loc=>loc.start.line<=line&&loc.end.line>=line));
  const missing=executable.filter(line=>!Object.entries(c.statementMap).some(([id,loc])=>loc.start.line<=line&&loc.end.line>=line&&c.s[id]>0));
  changed[file]={total:executable.length,executed:executable.length-missing.length,missing};
 }
 save('coverage',{changed,missing:Object.values(changed).flatMap(row=>row.missing)});
}else if(mode==='shuffle'){
 const results=[];
 for(const [index,order] of [[...tests].reverse(),[tests[2],tests[0],tests[4],tests[3],tests[1]]].entries()){
  const result=run(['--test','--test-concurrency=1',...order],`shuffle-${index}`);assert.equal(result.status,0,result.output);
  results.push({order,counts:result.output.split('\n').filter(line=>/^# (tests|pass|fail|cancelled|skipped)/.test(line))});
 }
 save('shuffle',{results});
}else throw new Error('Expected baseline-static, static, suite, coverage or shuffle');
