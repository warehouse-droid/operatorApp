import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const output='test-artifacts/special-workflow-review/native-documents';
const pdf='test/mbt/unit/special-workflow-native-documents.test.js', closure='test/mbt/unit/special-workflow-closure.test.js';
const mutants=[
  ['src/netsuite-order-pdf.js','Number(payload.entityId) !== id','false',pdf],
  ['src/special-stock-closure-adapter.js','current.filter(line => !line.closed)','current',closure],
  ['src/special-stock-closure-adapter.js','isClosed: true','isClosed: false',closure],
  ['src/special-stock-closure-adapter.js','Number(row.execution_quantity) !== 0','false',closure],
  ['src/special-stock-planning.js',"plan.status === 'cancelled'",'false',closure],
  ['src/special-stock-documents.js',"kind === 'purchase_order' && audience !== 'scm'",'false','test/mbt/unit/special-workflow-documents.test.js']
];
const directory=mkdtempSync('/app/.native-mutants-'), results=[];
try{
  for(const [i,[target,before,after,testFile]] of mutants.entries()){
    const absolute=resolve(target), mutated=`${directory}/mutated.mjs`;
    const imports=(content,from)=>content.replace(/from (['"])(\.[^'"]+)\1/g,(_full,quote,name)=>{
      const path=resolve(dirname(from),name);return `from ${quote}file://${path===absolute?mutated:path}${quote}`;
    }).replace("new URL('../../../netsuite-smart-scm-picking-ticket-restlet.js', import.meta.url)","new URL('file:///app/netsuite-smart-scm-picking-ticket-restlet.js')");
    const source=readFileSync(target,'utf8');assert.equal(source.split(before).length,2,'Unique mutant anchor');
    writeFileSync(mutated,imports(source.replace(before,after),absolute));
    writeFileSync(`${directory}/contract.test.mjs`,imports(readFileSync(testFile,'utf8'),resolve(testFile)));
    const layers=[];
    for(const layer of (i<5?['contract','property']:['contract'])){
      const result=spawnSync(process.execPath,['--test',...(layer==='property'?['--test-name-pattern=^property:']:[]),`${directory}/contract.test.mjs`],{encoding:'utf8',timeout:60000,maxBuffer:5*1024*1024});
      const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${output}/mutant-${i+1}-${layer}.txt`,log);
      assert.equal(result.status,1,`Surviving ${layer} mutant ${i+1}`);assert.match(log,/not ok \d+ -/);assert.doesNotMatch(log,/ERR_MODULE_NOT_FOUND|SyntaxError/);
      layers.push({layer,killed:true,failures:[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1])});
    }
    results.push({target,before,after,layers});
  }
}finally{rmSync(directory,{recursive:true,force:true});}
writeFileSync(`${output}/mutations.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({killed:results.length,propertyOnlyKilled:5}));
