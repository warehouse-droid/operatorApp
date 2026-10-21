import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Linter} from 'eslint';

const out='test-artifacts/backorder-pending-po-20261021';
const runtime=JSON.parse(readFileSync('tools/backorder-pending-po-files.json','utf8'));
const support=['test/mbt/unit/backorder-pending-po.test.js','test/mbt/integration/backorder-pending-po.test.js',
  'test/mbt/unit/regular-stock-status.test.js','test/mbt/property/regular-stock-status.property.test.js',
  'test/mbt/unit/regular-stock-input.test.js','test/mbt/unit/already-ordered-arrival.test.js',
  'test/mbt/helpers/backorder-already-ordered.js','test/support/regular-stock-status-browser.mjs',
  'tools/backorder-pending-po-checks.mjs','tools/backorder-pending-po-check.sh'];
const report={hashes:{},syntax:[],lint:[]};
const lint=new Linter(),config={languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{window:'readonly',URLSearchParams:'readonly'}},
  rules:Object.fromEntries(['no-undef','no-unreachable','no-dupe-args','no-dupe-keys','no-duplicate-case','valid-typeof','no-import-assign','no-unsafe-finally'].map(key=>[key,'error']))};
for(const file of [...runtime,...support]){
  const source=readFileSync(file,'utf8');report.hashes[file]=createHash('sha256').update(source).digest('hex');
  if(/\.m?js$/.test(file)){
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);report.syntax.push(file);
  }
  if(runtime.includes(file)&&file.endsWith('.js')){
    const before=`${out}/before/${file}`,old=existsSync(before)?lint.verify(readFileSync(before,'utf8'),config):[];
    const current=lint.verify(source,config),known=old.map(row=>row.ruleId+':'+row.message);
    const added=current.filter(row=>{const index=known.indexOf(row.ruleId+':'+row.message);if(index<0)return true;known.splice(index,1);return false;});
    report.lint.push({file,baseline:old.length,current:current.length,added});assert.deepEqual(added,[]);
  }
}
const types=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--ignoreConfig','--allowJs','--noEmit','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/regular-stock-status.js'],{encoding:'utf8',timeout:60000});
report.types={exit:types.status,output:types.stdout+types.stderr};assert.equal(types.status,0,report.types.output);
assert(readFileSync('public/regular-stock-status-ui.js','utf8').includes('/regular-stock-status.js?v=20261021-pending-po'));
for(const role of ['sales','scm'])assert(readFileSync(`public/${role}-stock-requests.html`,'utf8').includes('/regular-stock-status-ui.js?pendingPo=20261021-v1&'));
writeFileSync(out+'/static.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({syntax:report.syntax.length,newLint:0,typeCheck:types.status,assetVersions:true}));
