import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,cpSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import base from '../eslint.mbt.config.js';
const files=['src/yard-movement-repository.js','public/control.js','public/dispatch-loaded-export.js','public/yard-movement-requests.js'];
const globals={...base[1].languageOptions.globals,window:'readonly',document:'readonly',localStorage:'readonly',navigator:'readonly',alert:'readonly',confirm:'readonly',requestAnimationFrame:'readonly',Image:'readonly'};
const rules=Object.fromEntries(['eqeqeq','no-constant-condition','no-duplicate-imports','no-implicit-coercion','no-shadow','no-undef','no-unreachable','no-unused-vars','no-useless-catch','no-var','prefer-const'].map(name=>[name,base[1].rules[name]]));
const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.js'],languageOptions:{...base[1].languageOptions,globals},rules}]});
const tally=items=>items.reduce((result,item)=>{result[item]=(result[item]||0)+1;return result;},{});
function delta(before,after){return Object.fromEntries(Object.entries(after).filter(([key,count])=>count>(before[key]||0)));}
const lint=[];
for(const file of files){
  const before=file.endsWith('yard-movement-requests.js')?'':readFileSync('/baseline/'+file,'utf8');
  const diagnostics=async text=>tally((await eslint.lintText(text,{filePath:file}))[0].messages.map(m=>m.ruleId+': '+m.message));
  const old=await diagnostics(before),current=await diagnostics(readFileSync(file,'utf8'));
  assert.deepEqual(delta(old,current),{},file);
  lint.push({file,baseline:Object.values(old).reduce((a,b)=>a+b,0),current:Object.values(current).reduce((a,b)=>a+b,0),new:0});
}
const beforeRoot='test-artifacts/yard-performance/type-before';mkdirSync(beforeRoot,{recursive:true});
cpSync('src',beforeRoot+'/src',{recursive:true});cpSync('package.json',beforeRoot+'/package.json');
cpSync('/baseline/src/yard-movement-repository.js',beforeRoot+'/src/yard-movement-repository.js');
const typeArgs=['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--target','ES2022','--module','NodeNext','--pretty','false'];
function typecheck(files){
  const result=spawnSync(process.execPath,[...typeArgs,...files],{encoding:'utf8',maxBuffer:30*1024*1024,timeout:120000});
  assert.ok(result.status===0||result.status===1||result.status===2,'Compiler did not finish');
  const output=(result.stdout||'')+(result.stderr||'');
  return {status:result.status,output,diagnostics:tally(output.split('\n').filter(Boolean).map(line=>line.replaceAll(beforeRoot+'/','').replace(/\(\d+,\d+\)/g,'')))};
}
const before=typecheck([beforeRoot+'/src/yard-movement-repository.js']).diagnostics,current=typecheck(['src/yard-movement-repository.js']).diagnostics;
assert.deepEqual(delta(before,current),{});
const declaration='test-artifacts/yard-performance-window.d.ts';
writeFileSync(declaration,'interface Window { MBBSMovementReads: {create: (...args: any[]) => any}; }\n');
const helper=typecheck(['public/yard-movement-requests.js',declaration]);assert.equal(helper.status,0,helper.output);
const result={lint,types:{baseline:Object.values(before).reduce((a,b)=>a+b,0),current:Object.values(current).reduce((a,b)=>a+b,0),new:0,helperErrors:0},scope:'Existing core lint rules; backend dependency graph and new request helper checked with TypeScript. Existing large browser scripts are syntax/lint and Playwright checked.'};
writeFileSync('test-artifacts/yard-performance/static.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
