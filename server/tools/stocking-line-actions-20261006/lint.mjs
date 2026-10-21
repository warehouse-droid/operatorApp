import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {ESLint} from 'eslint';
const task='tools/stocking-line-actions-20261006',out='test-artifacts/stocking-line-actions-20261006';
const runtime=JSON.parse(readFileSync(task+'/files.json')).filter(file=>file.endsWith('.js'));
const tests=['test/mbt/unit/stocking-line-actions.test.js','test/mbt/integration/stocking-line-actions.test.js','test/mbt/integration/stocking-line-actions-browser.test.js',
  'test/mbt/integration/stocking-replies-http.test.js','test/mbt/integration/stocking-replies-browser.test.js','test/mbt/integration/regular-stock-resolution-browser.test.js'];
const files=[...runtime,...tests,...['check.mjs','lint.mjs','repair.mjs','verify-live.mjs','eslint.config.mjs','annotation-coverage.mjs'].map(file=>task+'/'+file)];
const lint=new ESLint({overrideConfigFile:task+'/eslint.config.mjs'}),reports=[];
for(const file of files){
  const baseline=existsSync(task+'/baseline/'+file)?task+'/baseline/'+file:task+'/baseline-tests/'+file;
  const messages=async source=>(await lint.lintText(source,{filePath:file}))[0].messages;
  const old=existsSync(baseline)?await messages(readFileSync(baseline,'utf8')):[],after=await messages(readFileSync(file,'utf8'));
  const prior=old.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  const added=after.filter(({ruleId,severity,message})=>{const key=JSON.stringify({ruleId,severity,message}),index=prior.indexOf(key);if(index<0)return true;prior.splice(index,1);return false;});
  reports.push({file,before:old.length,after:after.length,added});
}
writeFileSync(out+'/lint.json',JSON.stringify(reports,null,2));assert.ok(reports.every(row=>row.added.length===0),JSON.stringify(reports.filter(row=>row.added.length)));
console.log(JSON.stringify({files:files.length,baselineDiagnostics:reports.reduce((sum,row)=>sum+row.before,0),candidateDiagnostics:reports.reduce((sum,row)=>sum+row.after,0),newDiagnostics:0}));
