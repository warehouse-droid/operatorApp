import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';

const files=['public/stock-request-view.js','public/special-stock-queue.js','public/sales-stock-requests.js',
  'public/scm-stock-requests.js','public/sales-special-stock-requests.js','public/scm-special-stock-requests.js','public/scm-waitlist.js'];
const lint=new ESLint({overrideConfigFile:'tools/stock-request-layout-eslint.config.mjs',overrideConfig:[{languageOptions:{globals:{structuredClone:'readonly'}}}]});
const reports=[];
for(const file of files) {
  assert.equal(spawnSync(process.execPath,['--check',file]).status,0,file);
  const before='/app/stock-view-before/'+file;
  const messages=async source=>(await lint.lintText(source,{filePath:file}))[0].messages;
  const old=existsSync(before)?await messages(readFileSync(before,'utf8')):[];
  const after=await messages(readFileSync(file,'utf8'));
  const prior=old.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  const added=after.filter(({ruleId,severity,message})=>{
    const key=JSON.stringify({ruleId,severity,message}), index=prior.indexOf(key);
    if(index<0)return true;prior.splice(index,1);return false;
  });
  reports.push({file,beforeDiagnostics:old.length,afterDiagnostics:after.length,added});
}
writeFileSync('test-artifacts/stock-request-view-20261006/static.json',JSON.stringify(reports,null,2)+'\n');
assert.ok(reports.every(report=>report.added.length===0),'Resolve new lint diagnostics');
console.log(JSON.stringify({syntaxFiles:files.length,newLintDiagnostics:0}));
