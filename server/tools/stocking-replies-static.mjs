import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
const files=JSON.parse(readFileSync('tools/stocking-replies-files.json','utf8')).filter(file=>file.endsWith('.js'));
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs',overrideConfig:[{languageOptions:{globals:{HTMLFormElement:'readonly'}}}]});
const reports=[];
for(const file of files){
  assert.equal(spawnSync(process.execPath,['--check',file]).status,0,file);
  const before='/app/stock-view-before/'+file;
  const messages=async source=>(await lint.lintText(source,{filePath:file}))[0].messages;
  const old=existsSync(before)?await messages(readFileSync(before,'utf8')):[];
  const after=await messages(readFileSync(file,'utf8'));
  const prior=old.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  const added=after.filter(({ruleId,severity,message})=>{
    const key=JSON.stringify({ruleId,severity,message}),index=prior.indexOf(key);if(index<0)return true;prior.splice(index,1);return false;
  });reports.push({file,beforeDiagnostics:old.length,afterDiagnostics:after.length,added});
}
writeFileSync('test-artifacts/stocking-replies-20261006/static.json',JSON.stringify(reports,null,2));
assert.ok(reports.every(report=>report.added.length===0),'Resolve new lint diagnostics');
const typed=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tools/stocking-replies-tsconfig.json'],{encoding:'utf8'});
writeFileSync('test-artifacts/stocking-replies-20261006/types.log',(typed.stdout||'')+(typed.stderr||''));assert.equal(typed.status,0,typed.stdout+typed.stderr);
console.log(JSON.stringify({syntaxFiles:files.length,newLintDiagnostics:0,strictDomainTypes:true}));
