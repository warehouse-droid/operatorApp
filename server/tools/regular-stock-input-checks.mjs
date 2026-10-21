import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Linter} from 'eslint';
import {scanTextForSecrets,scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';
const out='test-artifacts/regular-stock-input-20261020';mkdirSync(out,{recursive:true});
const runtime=JSON.parse(readFileSync('tools/regular-stock-input-files.json','utf8'));
const support=['test/mbt/unit/regular-stock-input.test.js','test/mbt/integration/regular-stock-input.test.js','tools/regular-stock-input-checks.mjs',
  'test/support/regular-stock-status-browser.mjs','test/mbt/integration/regular-stock-status.test.js','test/mbt/integration/regular-stock-resolution-browser.test.js',
  'test/mbt/unit/regular-stock-status.test.js','test/mbt/unit/sales-stock-multiselect.test.js'];
const report={syntax:[],lint:[],hashes:{},secrets:[],mutations:[],versions:{node:process.version}};
const globals=Object.fromEntries(['window','document','localStorage','sessionStorage','fetch','setTimeout','clearTimeout','setInterval','clearInterval','console','URL','URLSearchParams','Intl','location','navigator','EventSource','FormData','Option','structuredClone','Blob','Image','requestAnimationFrame','cancelAnimationFrame','CSS','performance','AbortController','MutationObserver','ResizeObserver','crypto','indexedDB','FileReader','alert','confirm','prompt','getComputedStyle','Response','Headers','File','Element','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','CustomEvent','Event','process','Buffer','innerWidth','scmStockState'].map(key=>[key,'readonly']));
const rules=Object.fromEntries(['no-undef','no-unreachable','no-dupe-args','no-dupe-keys','no-duplicate-case','valid-typeof','no-import-assign','no-unsafe-finally'].map(key=>[key,'error']));
const lint=new Linter();
for(const file of [...runtime,...support]){
  const source=readFileSync(file,'utf8'),before=`${out}/before/${file}`;report.hashes[file]=createHash('sha256').update(source).digest('hex');
  if(/\.m?js$/.test(file)){
    const syntax=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);report.syntax.push(file);
    const check=source=>lint.verify(source,{languageOptions:{ecmaVersion:'latest',sourceType:'module',globals},rules});
    const old=existsSync(before)?check(readFileSync(before,'utf8')):[],current=check(source),remaining=old.map(d=>d.ruleId+':'+d.message);
    const added=current.filter(d=>{const i=remaining.indexOf(d.ruleId+':'+d.message);if(i<0)return true;remaining.splice(i,1);return false;});
    report.lint.push({file,baseline:old.length,current:current.length,added});
  }
  if(existsSync(before)){
    const diff=spawnSync('diff',['-U0','--label','a/'+file,'--label','b/'+file,before,file],{encoding:'utf8'});assert([0,1].includes(diff.status));report.secrets.push(...scanUnifiedDiff(diff.stdout));
  }else report.secrets.push(...scanTextForSecrets(source,file));
}
const types=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--ignoreConfig','--allowJs','--noEmit','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/regular-stock-status.js','src/regular-stock-domain.js'],{encoding:'utf8',timeout:60000});
report.types={exit:types.status,output:types.stdout+types.stderr};
for(const name of ['typescript','eslint','fast-check','c8','@playwright/test','pg'])report.versions[name]=JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version;
writeFileSync(out+'/static.json',JSON.stringify(report,null,2));
assert.equal(types.status,0,report.types.output);assert(report.lint.every(row=>!row.added.length),'New lint diagnostics');assert.equal(report.secrets.length,0,'Secret scan findings');
const source=readFileSync('public/regular-stock-status.js','utf8');
const mutants=[
  ['status union ignored',"filters.unifiedStatus.split(',').includes(summary.status)",'filters.unifiedStatus === summary.status','selected statuses','generated multi-status'],
  ['proposal remains active',"return state('completed','proposal','proposal')","return state('in_progress','proposal','proposal')",'STREQ-000164','generated purchase handoffs'],
  ['Sales action disappears',"if (!pending) return null;","if (pending) return null;",'Sales input','generated mixed Sales']
];
const dir=mkdtempSync('/tmp/regular-stock-input-mutations-');
try{
  symlinkSync('/app/node_modules',dir+'/node_modules');
  for(const [name,needle,replacement,example,property] of mutants){
    assert.equal(source.split(needle).length,2,needle);
    writeFileSync(dir+'/model.mjs',source.replace(needle,replacement).replace("'./special-stock-workflow.js'","'/app/public/special-stock-workflow.js'"));
    const test=readFileSync('test/mbt/unit/regular-stock-input.test.js','utf8').replace("'../../../public/regular-stock-status.js'","'./model.mjs'").replace("'../../../public/sales-stock-list-filters.js'","'/app/public/sales-stock-list-filters.js'");
    writeFileSync(dir+'/test.mjs',test);
    for(const pattern of [example,property]){
      const result=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,dir+'/test.mjs'],{encoding:'utf8',timeout:60000});
      writeFileSync(out+'/mutation-'+report.mutations.length+'.log',result.stdout+result.stderr);
      report.mutations.push({name,pattern,killed:result.status===1&&result.stdout.includes('not ok'),exit:result.status});
      assert(report.mutations.at(-1).killed,'Surviving mutation: '+name);
    }
  }
}finally{rmSync(dir,{recursive:true,force:true});}
writeFileSync(out+'/static.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({syntax:report.syntax.length,newLint:0,newTypes:0,secrets:0,mutations:report.mutations}));
