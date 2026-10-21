import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {Linter} from 'eslint';

const files=['public/menu-order-model.js','public/menu-order.js','public/menu-order-admin.js',
  'src/menu-order-repository.js','src/menu-order-router.js'];
const globals=Object.fromEntries(['window','document','localStorage','fetch','AbortSignal','MutationObserver',
  'CustomEvent','structuredClone','console','setTimeout','clearTimeout','setInterval','clearInterval'].map(key=>[key,'readonly']));
const linter=new Linter();
const reports=[];
for(const file of files) {
  const source=readFileSync(file,'utf8');
  assert.equal(spawnSync(process.execPath,['--check',file]).status,0,file);
  const messages=linter.verify(source,{languageOptions:{ecmaVersion:'latest',sourceType:'module',globals},rules:{
    'no-undef':'error','no-unused-vars':['error',{argsIgnorePattern:'^_'}],'no-unreachable':'error',
    'no-dupe-keys':'error','no-var':'error',eqeqeq:['error','always'],'prefer-const':'error'
  }},{filename:file});
  reports.push({file,messages});
}
for(const file of ['public/dispatch-menu.html','public/scm-menu.html']) {
  const html=readFileSync(file,'utf8');
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)) {
    new vm.Script(match[1],{filename:file});
  }
}
writeFileSync('test-artifacts/menu-order-20261006/static.json',JSON.stringify(reports,null,2)+'\n');
assert.ok(reports.every(report=>report.messages.length===0),'Resolve new-file lint errors');
console.log(JSON.stringify({syntax:true,lintDiagnostics:0,files:files.length}));
