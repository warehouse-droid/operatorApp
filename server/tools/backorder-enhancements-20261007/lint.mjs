import assert from 'node:assert/strict';
import {ESLint} from 'eslint';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const task='tools/backorder-enhancements-20261007',out='test-artifacts/backorder-enhancements-20261007';
const runtime=JSON.parse(readFileSync(task+'/files.json')).filter(file=>file.endsWith('.js'));
const files=[...runtime,'test/mbt/unit/backorder-workflow.test.js','test/mbt/integration/backorder-requests.test.js','test/mbt/integration/backorder-browser.test.js','test/mbt/integration/backorder-routing.test.js','test/mbt/property/backorder-routing.property.test.js','test/mbt/integration/backorder-enhancements-browser.test.js',task+'/check.mjs',task+'/lint.mjs',task+'/annotation-coverage.mjs',task+'/migration-check.mjs',task+'/verify-live.mjs'];
const lint=new ESLint({overrideConfigFile:task+'/eslint.config.mjs'}),reports=[];
for(const file of files){
  const messages=async source=>(await lint.lintText(source,{filePath:file}))[0].messages;
  const baseline=file.startsWith(task+'/worker-candidate/')?file.replace('/worker-candidate/','/baseline-worker/'):task+'/baseline/'+file,old=existsSync(baseline)?await messages(readFileSync(baseline,'utf8')):[],next=await messages(readFileSync(file,'utf8'));
  const prior=old.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  const added=next.filter(({ruleId,severity,message})=>{const key=JSON.stringify({ruleId,severity,message}),i=prior.indexOf(key);if(i<0)return true;prior.splice(i,1);return false;});
  reports.push({file,before:old.length,after:next.length,added});
}
writeFileSync(out+'/lint-diagnostics.json',JSON.stringify(reports,null,2));
assert.ok(reports.every(row=>!row.added.length),JSON.stringify(reports.filter(row=>row.added.length)));
console.log(JSON.stringify({files:files.length,baselineDiagnostics:reports.reduce((n,r)=>n+r.before,0),candidateDiagnostics:reports.reduce((n,r)=>n+r.after,0),newDiagnostics:0}));
