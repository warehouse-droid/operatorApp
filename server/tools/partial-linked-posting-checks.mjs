import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
import {primary,regression} from './partial-linked-posting-suites.mjs';
import {ESLint} from 'eslint';
import coverageLibrary from 'istanbul-lib-coverage';
import {scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';

const mode=process.argv[2] || 'tests';
const files=JSON.parse(fs.readFileSync('tools/partial-linked-posting-files.json','utf8'));
const sourceFiles=files.filter(file=>file.endsWith('.js'));
const output=path.resolve('test-artifacts/partial-checks');fs.mkdirSync(output,{recursive:true});
const report={mode,tools:{node:process.version},source:{}};
for(const name of ['fast-check','typescript','eslint','c8']) {
  report.tools[name]=JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`,'utf8')).version;
}
for(const file of files.filter(file=>fs.existsSync(file))) {
  report.source[file]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function run(args,{cwd=process.cwd(),env=process.env}={}) {
  const result=spawnSync(process.execPath,args,{cwd,env,encoding:'utf8',timeout:180000,maxBuffer:64*1024*1024});
  assert.equal(result.signal,null,String(result.error));
  return {code:result.status,text:(result.stdout || '')+(result.stderr || '')};
}
function copyRuntime(destination) {
  fs.mkdirSync(destination,{recursive:true});fs.cpSync('src',`${destination}/src`,{recursive:true});
  for(const name of ['node_modules','public','migrations','contracts']) {fs.symlinkSync(path.resolve(name),`${destination}/${name}`);}
  fs.copyFileSync('package.json',`${destination}/package.json`);
}
function difference(before,after) {
  const counts=new Map();for(const row of before) {counts.set(row,(counts.get(row)||0)+1);}
  return after.filter(row=>{const n=counts.get(row)||0;if(n) {counts.set(row,n-1);return false;}return true;});
}
if(['baseline','tests','focused','reverse','coverage'].includes(mode)) {
  const testFiles=mode==='baseline'?regression:mode==='focused'?primary:[...primary,...regression];
  const environment=mode==='coverage'?{...process.env,NODE_V8_COVERAGE:`${output}/v8`}:process.env;
  const code=await runNodeTestFilesIsolated(mode==='reverse'?[...testFiles].reverse():testFiles,{environment,label:`partial-${mode}`});
  report.files=testFiles.length;report.exit=code;process.exitCode=code;
  if(mode==='coverage') {
    const result=run(['node_modules/c8/bin/c8.js','report','--check-coverage=false',`--temp-directory=${output}/v8`,
      `--report-dir=${output}/coverage`,'--reporter=json',...sourceFiles.map(file=>`--include=${file}`)]);
    assert.equal(result.code,0,result.text);
    const map=coverageLibrary.createCoverageMap(JSON.parse(fs.readFileSync(`${output}/coverage/coverage-final.json`,'utf8')));
    const coverage={covered:0,total:0,misses:[]};
    for(const file of sourceFiles) {
      const before=`/baseline-source/${file}`,empty=`${output}/empty`;fs.writeFileSync(empty,'');
      const diff=spawnSync('diff',['-U0',fs.existsSync(before)?before:empty,file],{encoding:'utf8'}).stdout;
      const lines=map.fileCoverageFor(path.resolve(file)).getLineCoverage();
      for(const match of diff.matchAll(/^@@ .*? \+(\d+)(?:,(\d+))? @@/gm)) {
        for(let i=0;i<Number(match[2]??1);i++) {
          const line=Number(match[1])+i;if(lines[line]===undefined) {continue;}
          coverage.total++;if(lines[line]>0) {coverage.covered++;} else {coverage.misses.push(`${file}:${line}`);}
        }
      }
    }
    report.coverage=coverage;
  }
} else if(mode==='static') {
  const baseline=`${output}/baseline`;copyRuntime(baseline);
  fs.cpSync('/baseline-source/src',`${baseline}/src`,{recursive:true});
  const lint=new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.js'],languageOptions:{ecmaVersion:'latest',sourceType:'module'},
    rules:{eqeqeq:'error','no-unreachable':'error','no-unused-vars':['error',{argsIgnorePattern:'^_'}],'prefer-const':'error'}}]});
  const oldLint=[],newLint=[],secrets=[],changes={};
  for(const file of sourceFiles) {
    assert.equal(run(['--check',file]).code,0,file);
    const before=`/baseline-source/${file}`;
    for(const [old,rows] of [[true,oldLint],[false,newLint]]) {
      if(old && !fs.existsSync(before)) {continue;}
      const [result]=await lint.lintText(fs.readFileSync(old?before:file,'utf8'),{filePath:file});
      rows.push(...result.messages.map(m=>`${file}:${m.ruleId}:${m.message}`));
    }
    const empty=`${output}/empty`;fs.writeFileSync(empty,'');
    const diff=spawnSync('diff',['-U0',fs.existsSync(before)?before:empty,file],{encoding:'utf8'}).stdout;
    secrets.push(...scanUnifiedDiff(diff));changes[file]=diff;
  }
  const types=root=>{
    const result=run(['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck',
      '--module','nodenext','--target','es2022',...sourceFiles.filter(file=>root!==baseline || fs.existsSync(`/baseline-source/${file}`))],{cwd:root});
    fs.writeFileSync(`${output}/types-${root===baseline?'before':'after'}.log`,result.text);
    return result.text.split('\n').filter(line=>sourceFiles.some(file=>line.startsWith(`${file}(`))).map(line=>line.replace(/\(\d+,\d+\)/g,''));
  };
  const before=types(baseline),after=types(process.cwd());
  report.types={before:before.length,after:after.length,new:difference(before,after)};
  report.lint={before:oldLint.length,after:newLint.length,new:difference(oldLint,newLint)};report.secrets=secrets;
  report.complexity=(await new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.js'],rules:{complexity:['error',12]}}]})
    .lintFiles(['src/direct-po-allocation-receipt.js'])).flatMap(row=>row.messages.map(m=>({line:m.line,message:m.message})));
  process.exitCode=report.types.new.length || report.lint.new.length || secrets.length || report.complexity.length ? 1:0;
} else if(mode==='mutations') {
  const mutant=`${output}/mutant`;copyRuntime(mutant);
  for(const file of [...primary.slice(0,2),'test/support/partial-linked-posting-fixture.mjs']) {
    fs.mkdirSync(path.dirname(`${mutant}/${file}`),{recursive:true});fs.copyFileSync(file,`${mutant}/${file}`);
  }
  const mutants=[
    ['whole-line-receipt','src/direct-po-auto-receipt-domain.js','return {...line,quantity};','return {...line};'],
    ['receipt-inflated','src/direct-po-auto-receipt-domain.js','return {...line,quantity};','return {...line,quantity:quantity+1};'],
    ['drop-all-selected-lines','src/direct-po-auto-receipt-domain.js','return {...line,quantity};','return {...line,quantity:0};'],
    ['ignore-cancelled-allocation','src/direct-po-allocation-receipt.js',"row.allocation_status!=='active'",'false'],
    ['repeat-allocation-consumption','src/direct-po-allocation-receipt.js','return rows.filter(row=>!row.claimed_by || row.claimed_by===job.id);','return rows;']
  ];
  report.mutants=[];
  for(const [name,file,before,after] of mutants) {
    const original=fs.readFileSync(`${mutant}/${file}`,'utf8');assert.equal(original.split(before).length,2,name);
    fs.writeFileSync(`${mutant}/${file}`,original.replace(before,after));
    try {
      const result=run(['--test','--test-concurrency=1',...primary.slice(0,2)],{cwd:mutant});
      const property=run(['--test','--test-name-pattern=^property:',primary[0]],{cwd:mutant});
      const failures=[...result.text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
      report.mutants.push({name,killed:result.code===1 && failures.length>0,failures,propertyOnlyKilled:property.code===1});
    } finally {fs.writeFileSync(`${mutant}/${file}`,original);}
  }
  process.exitCode=report.mutants.every(m=>m.killed)?0:1;
} else {throw new Error(`Unknown check mode: ${mode}`);}
console.log(`PARTIAL_POSTING_REPORT ${JSON.stringify(report)}`);
