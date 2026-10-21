import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,openSync,closeSync,mkdtempSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {annotationOnlyLines} from './annotation-coverage.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const out='test-artifacts/stocking-backorder-conversion-20261007';mkdirSync(out,{recursive:true});
const mode=process.argv.at(-1),focused=['test/mbt/integration/stocking-backorder-conversion.test.js','test/mbt/integration/stocking-backorder-conversion-browser.test.js','test/mbt/property/stocking-backorder-conversion.property.test.js','test/mbt/integration/backorder-requests.test.js','test/mbt/integration/backorder-routing.test.js','test/mbt/integration/stocking-line-actions.test.js','test/mbt/integration/stocking-line-actions-browser.test.js','test/mbt/integration/stocking-customer-browser.test.js','test/mbt/unit/backorder-workflow.test.js','test/mbt/property/backorder-link-sequence.property.test.js','test/mbt/property/backorder-routing.property.test.js'];
const browserTest='test/mbt/integration/backorder-browser.test.js',enhancementBrowser='test/mbt/integration/backorder-enhancements-browser.test.js';
const runtime=JSON.parse(readFileSync('tools/stocking-backorder-conversion-20261007/files.json'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*?)?$/gm)].filter(match=>!match[0].includes(' # SKIP')).map(match=>match[1].replace(/^.*?(?=\/test\/mbt\/)/,''));
export function run(label,args,{allowFailure=false,env={},cwd=process.cwd()}={}){
  const fd=openSync(out+'/'+label+'.log','w');let r;
  try{r=spawnSync(process.execPath,args,{cwd,env:{...process.env,...env},stdio:['ignore',fd,fd],timeout:1800000});}finally{closeSync(fd);}
  const log=readFileSync(out+'/'+label+'.log','utf8'),result={label,exit:r.status,...counts(log)};
  console.log(JSON.stringify(result));writeFileSync(out+'/'+label+'.json',JSON.stringify(result,null,2));
  assert.notEqual(r.status,null,'Timeout: '+label);if(!allowFailure)assert.equal(r.status,0,log.slice(-5000));return {log,result};
}
function copyTree(baseline=false){
  const root=mkdtempSync('/tmp/mbbs-backorder-check-');
  for(const folder of ['src','public'])cpSync(baseline?'tools/stocking-backorder-conversion-20261007/baseline/'+folder:folder,root+'/'+folder,{recursive:true});
  cpSync(baseline?'tools/stocking-backorder-conversion-20261007/baseline/test':'test',root+'/test',{recursive:true});
  for(const folder of ['node_modules','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
  symlinkSync(resolve('migrations'),root+'/migrations');
  const copyTools=(source,target)=>{
    mkdirSync(target,{recursive:true});
    for(const entry of readdirSync(source,{withFileTypes:true})){
      const from=source+'/'+entry.name,to=target+'/'+entry.name;
      if(entry.isDirectory()&&/^baseline(?:-|$)/.test(entry.name))symlinkSync(resolve(from),to);
      else if(entry.isDirectory())copyTools(from,to);else cpSync(from,to);
    }
  };
  copyTools('tools',root+'/tools');
  for(const file of readdirSync('.').filter(name=>name.endsWith('.js')||name==='package.json'))cpSync(file,root+'/'+file);
  mkdirSync(root+'/test-artifacts',{recursive:true});return root;
}
function resetDb(label,{cwd=process.cwd()}={}){
  run(label+'-reset',['--input-type=module','-e',`import pg from 'pg';const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='db'||u.pathname!=='/mbt_test')throw Error('Not isolated');u.pathname='/postgres';const c=new pg.Client({connectionString:u.href});try{await c.connect();await c.query('DROP DATABASE mbt_test WITH (FORCE)');await c.query('CREATE DATABASE mbt_test');}finally{await c.end();}`]);
  run(label+'-migrate',['src/migrate.js'],{cwd});
}
function regressionGroups(){
  const files=['unit','property','integration'].flatMap(kind=>readdirSync('test/mbt/'+kind).filter(name=>/^(?:(?:regular-stock|regular-waitlist|backorder)[.-]|stock-request-|stocking-|special-).*\.test\.js$/.test(name)&&!name.startsWith('stocking-backorder-conversion')).sort().map(name=>'test/mbt/'+kind+'/'+name));
  const groups=new Map();
  for(const file of files){
    const source=readFileSync(file,'utf8');
    const host=source.match(/hostname\s*,\s*['"](mbbs-special-[^'"]+)['"]/)?.[1]||'db';
    const key=(file.includes('/special-')?'special':'regular')+'-'+host;
    if(!groups.has(key))groups.set(key,{host,files:[]});groups.get(key).files.push(file);
  }
  return groups;
}
function regressions(){
  const results={};
  for(const baseline of [true,false]){
    const root=copyTree(baseline);const kind=baseline?'baseline':'candidate';results[kind]={tests:0,pass:0,fail:0,skipped:0,failures:[],groups:[]};
    try{for(const [name,group] of regressionGroups()){
      resetDb(kind+'-'+name,{cwd:root});
      const db=new URL(process.env.DATABASE_URL);db.hostname=group.host;
      const args=baseline?[]:['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),
        '--temp-directory='+resolve(out+'/c8-regression-'+name),'--report-dir='+resolve(out+'/coverage-regression-'+name),'--reporter=json',process.execPath];
      const runResult=run(kind+'-'+name,[...args,'--test','--test-concurrency=1',...group.files],{cwd:root,allowFailure:true,env:{DATABASE_URL:db.href,
        SPECIAL_HEADER_NOTE_BROWSER_OUTPUT:root+'/test-artifacts/special-header-browser',SPECIAL_DELIVERY_FEE_BROWSER_OUTPUT:root+'/test-artifacts/special-fee-browser',SPECIAL_CUSTOM_PO_BROWSER_OUTPUT:root+'/test-artifacts/special-custom-browser'}});
      for(const field of ['tests','pass','fail','skipped'])results[kind][field]+=runResult.result[field];
      results[kind].failures.push(...failures(runResult.log).map(value=>name+': '+value));results[kind].groups.push(runResult.result);
      if(!baseline){
        const coverage=[];
        const collect=folder=>{for(const entry of readdirSync(folder,{withFileTypes:true})){
          const path=folder+'/'+entry.name;if(entry.isDirectory())collect(path);else if(/coverage.*\.json$|\.coverage\.json$/.test(entry.name)){
            const value=JSON.parse(readFileSync(path));if(Array.isArray(value))coverage.push(...value.filter(row=>row?.url&&row?.source&&row?.functions));
          }
        }};collect(root+'/test-artifacts');
        writeFileSync(out+'/browser-regression-'+name+'.json',JSON.stringify(coverage));
        writeFileSync(out+'/coverage-regression-'+name+'/source.json',JSON.stringify({root,manifest:Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(root+'/'+file))]))},null,2));
      }
    }}finally{rmSync(root,{recursive:true,force:true});}
  }
  const prior=[...results.baseline.failures];results.newFailures=results.candidate.failures.filter(value=>{const index=prior.indexOf(value);if(index<0)return true;prior.splice(index,1);return false;});
  writeFileSync(out+'/regressions.json',JSON.stringify(results,null,2));assert.deepEqual(results.newFailures,[]);return results;
}
function mutations(){
  run('mutation-runner',['tools/stocking-backorder-conversion-20261007/mutations.mjs']);
  const results=JSON.parse(readFileSync(out+'/mutations.json'));
  assert.ok(Array.isArray(results)&&results.length>=3&&results.every(value=>value.killed),'Missing detailed mutation results');
  return results;
}
function reversedSuite(){
  const order=[...focused,browserTest,enhancementBrowser].sort().reverse();
  const result={label:'reversed',exit:0,tests:0,pass:0,fail:0,skipped:0,order},logs=[];
  for(const [index,file] of order.entries()){
    const check=run('reversed-'+index,['--test','--test-concurrency=1',file]);
    for(const field of ['tests','pass','fail','skipped'])result[field]+=check.result[field];
    logs.push(file+'\n'+check.log);
  }
  writeFileSync(out+'/reversed.log',logs.join('\n'));
  writeFileSync(out+'/reversed.json',JSON.stringify(result,null,2));
  return {result};
}
function changedWhitespace(){
  for(const file of runtime){
    const baseline='tools/stocking-backorder-conversion-20261007/baseline/'+file;
    const diff=spawnSync('diff',['-U0',existsSync(baseline)?baseline:'/dev/null',file],{encoding:'utf8'}).stdout;
    assert.ok(!diff.split('\n').some(line=>line.startsWith('+')&&!line.startsWith('+++')&&/[ \t]+$/.test(line)),'Trailing whitespace: '+file);
  }
  return 'pass';
}
function changedCoverage(){
  const covered=Object.values(JSON.parse(readFileSync(out+'/coverage/coverage-final.json'))),roots=[process.cwd()];
  const browserEntries=readdirSync(out+'/browser').filter(name=>/coverage.*\.json$|\.coverage\.json$/.test(name)).flatMap(name=>JSON.parse(readFileSync(out+'/browser/'+name)));
  for(const name of readdirSync(out)){
    if(name.startsWith('browser-regression-')&&name.endsWith('.json'))browserEntries.push(...JSON.parse(readFileSync(out+'/'+name)));
    if(name.startsWith('coverage-regression-')&&existsSync(out+'/'+name+'/coverage-final.json')){
      const identity=JSON.parse(readFileSync(out+'/'+name+'/source.json'));
      assert.ok(Object.entries(identity.manifest).every(([file,value])=>value===hash(readFileSync(file))),'Stale regression coverage '+name);
      roots.push(identity.root);covered.push(...Object.values(JSON.parse(readFileSync(out+'/'+name+'/coverage-final.json'))));
    }
  }
  const lines=[],missing=[],annotations=[],branches=[];
  for(const file of runtime.filter(f=>f.endsWith('.js'))){
    const old='tools/stocking-backorder-conversion-20261007/baseline/'+file,source=readFileSync(file,'utf8'),sourceLines=source.split('\n');
    const annotationLines=annotationOnlyLines(existsSync(old)?readFileSync(old,'utf8'):'',source);
    const diff=spawnSync('diff',['-U0',existsSync(old)?old:'/dev/null',file],{encoding:'utf8'}).stdout;
    const entries=covered.filter(value=>roots.some(root=>value.path===root+'/'+file));
    const browser=browserEntries.filter(value=>value.url.split('?')[0].endsWith('/'+file.split('/').at(-1))&&value.source===source);
    let line=0;
    for(const text of diff.split('\n')){
      const hunk=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk)line=Number(hunk[1]);
      else if(text.startsWith('+')&&!text.startsWith('+++')){
        if(annotationLines.has(line)){annotations.push(file+':'+line);line++;continue;}
        if(file.startsWith('public/')){
          const value=sourceLines[line-1],trim=value.trim();
          if(trim&&!trim.startsWith('//')&&!trim.startsWith('/*')&&!trim.startsWith('*')&&!/^[{});]+$/.test(trim)){
            const offset=sourceLines.slice(0,line-1).join('\n').length+(line>1?1:0)+value.indexOf(trim);
            const hit=entries.some(entry=>Object.entries(entry.statementMap).some(([key,value])=>value.start.line<=line&&value.end.line>=line&&entry.s[key]>0))||browser.some(value=>value.functions.flatMap(fn=>fn.ranges).filter(range=>range.startOffset<=offset&&range.endOffset>offset).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset))[0]?.count>0);
            lines.push(file+':'+line);if(!hit)missing.push(file+':'+line);
          }
        }else{
          const executable=entries.some(entry=>Object.values(entry.statementMap).some(value=>value.start.line<=line&&value.end.line>=line));
          const hit=entries.some(entry=>Object.entries(entry.statementMap).some(([key,value])=>value.start.line<=line&&value.end.line>=line&&entry.s[key]>0));
          if(executable){lines.push(file+':'+line);if(!hit)missing.push(file+':'+line);}
          else if(!entries.length&&sourceLines[line-1].trim()&&!/^\s*(\/\/|\/\*|\*)/.test(sourceLines[line-1]))missing.push(file+':'+line);
        }
        line++;
      }else if(!text.startsWith('-')&&!text.startsWith('\\'))line++;
    }
    for(const entry of entries)branches.push({file,path:entry.path,total:Object.values(entry.b).flat().length,covered:Object.values(entry.b).flat().filter(value=>value>0).length});
  }
  const result={total:lines.length,covered:lines.length-missing.length,lines,missing,annotationOnly:annotations,branches};
  writeFileSync(out+'/changed-coverage.json',JSON.stringify(result,null,2));assert.deepEqual(missing,[]);return result;
}
function finalChecks(regression){
  assert.deepEqual(regression.newFailures,[]);
  assert.ok(regression.baseline.tests>0&&regression.candidate.tests>0,'Missing baseline/candidate regression results');
  resetDb('before-focused-final');
  const final=run('focused-final',['--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);
  resetDb('before-coverage');rmSync(out+'/browser',{recursive:true,force:true});
  run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);
  run('static-final',['tools/stocking-backorder-conversion-20261007/check.mjs','static']);
  const coverage=changedCoverage(),mutation=mutations();resetDb('before-reversed');
  const reversed=reversedSuite();
  const taskTools=readdirSync('tools/stocking-backorder-conversion-20261007').filter(file=>file!=='EVIDENCE.md'&&/\.(?:mjs|py|sql|json|md)$/.test(file));
  run('secrets',['test/support/scan-diff-secrets.mjs',...runtime,...focused,browserTest,enhancementBrowser,...taskTools.map(file=>'tools/stocking-backorder-conversion-20261007/'+file)]);
  const whitespace=changedWhitespace();
  const summary={whitespace,regression,newFailures:regression.newFailures,focused:final.result,reversed:reversed.result,types:'pass',typeComparison:JSON.parse(readFileSync(out+'/types.json')),lint:'pass',changedLines:coverage,mutations:mutation,
    manifest:Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(file))])),
    dependencyLockHash:hash(readFileSync('package-lock.json')),testManifest:Object.fromEntries([...focused,browserTest,enhancementBrowser].map(file=>[file,hash(readFileSync(file))])),
    toolManifest:Object.fromEntries(taskTools.map(file=>[file,hash(readFileSync('tools/stocking-backorder-conversion-20261007/'+file))])),node:process.version,
    versions:Object.fromEntries(['@playwright/test','c8','typescript','eslint','fast-check','espree'].map(name=>[name,JSON.parse(readFileSync('/app/node_modules/'+name+'/package.json')).version]))};
  writeFileSync(out+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify({gauntlet:'pass',focused:summary.focused,changed:coverage.total,mutants:mutation.length}));
}

if(mode==='red'){
  const r=run('red-api',['--test','--test-concurrency=1',focused[0]],{allowFailure:true});assert.equal(r.result.exit,1);assert.ok(r.result.fail>=5);assert.ok(!r.log.includes("failureType: 'hookFailed'"));
  const b=run('red-browser',['--test','--test-name-pattern=^SCM converts the whole',focused[1]],{allowFailure:true});assert.equal(b.result.fail,1);
  const prop=run('red-property',['--test',focused[2]],{allowFailure:true});assert.equal(prop.result.fail,3);
}
else if(mode==='static'){
  const files=JSON.parse(readFileSync('tools/stocking-backorder-conversion-20261007/files.json')).filter(file=>file.endsWith('.js'));
  const args=['/app/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext'];
  const root=mkdtempSync('/tmp/mbbs-backorder-types-');
  try{
    for(const folder of ['src','public'])cpSync('tools/stocking-backorder-conversion-20261007/baseline/'+folder,root+'/'+folder,{recursive:true});
    for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
    cpSync('package.json',root+'/package.json');
    run('types-baseline',[...args,...files.filter(file=>existsSync('tools/stocking-backorder-conversion-20261007/baseline/'+file))],{allowFailure:true,cwd:root});
    run('types-candidate',[...args,...files],{allowFailure:true});
    const messages=label=>readFileSync(out+'/'+label+'.log','utf8').split('\n').filter(line=>/error TS\d+:/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/,'').replace(/error TS2551: (.*) Did you mean '[^']+'\?/u,'error TS2339: $1'));
    const baseline=messages('types-baseline'),candidate=messages('types-candidate'),remaining=[...baseline];
    const added=candidate.filter(message=>{const index=remaining.indexOf(message);if(index<0)return true;remaining.splice(index,1);return false;});
    writeFileSync(out+'/types-new-errors.json',JSON.stringify(added,null,2));writeFileSync(out+'/types.json',JSON.stringify({baseline:baseline.length,candidate:candidate.length,newErrors:added.length},null,2));
    assert.deepEqual(added,[]);
    run('lint',['tools/stocking-backorder-conversion-20261007/lint.mjs']);
    for(const file of files)run('syntax-'+file.split('/').at(-1),['--check',file]);
  }finally{rmSync(root,{recursive:true,force:true});}
}
else if(mode==='quick')run('conversion',['--test','--test-concurrency=1',...focused.slice(0,3)]);
else if(mode==='browser')run('browser',['--test','--test-concurrency=1',focused[1]]);
else if(mode==='regression'||mode==='baseline')regressions();
else if(mode==='all')finalChecks(regressions());
else if(mode==='finish')finalChecks(JSON.parse(readFileSync(out+'/regressions.json')));
else if(mode==='mutations')mutations();
else if(mode==='coverage'){
  run('coverage',['/app/node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...runtime.filter(file=>file.endsWith('.js')).map(file=>'--include='+file),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);changedCoverage();
}else run('focused',['--test','--test-concurrency=1',...focused,browserTest,enhancementBrowser]);
