import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const output='test-artifacts/special-workflow-review/adjustments';
const mutants=[
 ['public/special-stock-pricing.js','return { ...gross, discountPercent, subtotal };','return { ...gross, rate:0, discountPercent, subtotal };','test/mbt/unit/special-workflow-adjustments.test.js'],
 ['public/special-stock-pricing.js','grossCents - discountCents','grossCents + discountCents','test/mbt/unit/special-workflow-adjustments.test.js'],
 ['src/special-stock-adjustment-adapter.js','target.lines.splice(index+1','target.lines.splice(index','test/mbt/unit/special-workflow-adjustment-adapter.test.js'],
 ['src/special-stock-adjustment-adapter.js','&& !specialAdjustmentMatches(order.target,current)','&& false','test/mbt/unit/special-workflow-adjustment-adapter.test.js'],
 ['netsuite-smart-scm-picking-ticket-restlet.js',"fieldId:'rate',line:index,text:line.rate}","fieldId:'rate',line:index,text:line.rate.replace('%','')}",'test/mbt/unit/special-workflow-adjustment-restlet.test.js']
];
const directory=mkdtempSync('/app/.adjustment-mutants-'), results=[];
try{
  for(const [i,[target,before,after,testFile]] of mutants.entries()){
    const absolute=resolve(target), mutated=`${directory}/mutated.mjs`;
    const imports=(content,from)=>content.replace(/from (['"])(\.[^'"]+)\1/g,(_full,quote,name)=>{
      const path=resolve(dirname(from),name);return `from ${quote}file://${path===absolute?mutated:path}${quote}`;
    }).replace("new URL('../../../netsuite-smart-scm-picking-ticket-restlet.js', import.meta.url)","new URL('file:///app/netsuite-smart-scm-picking-ticket-restlet.js')");
    const source=readFileSync(target,'utf8');assert.equal(source.split(before).length,2,'Unique mutant anchor');
    writeFileSync(mutated,imports(source.replace(before,after),absolute));
    writeFileSync(`${directory}/contract.test.mjs`,imports(readFileSync(testFile,'utf8').replace("fs.readFileSync('netsuite-smart-scm-picking-ticket-restlet.js'",`fs.readFileSync('${target.endsWith('restlet.js')?mutated:'/app/netsuite-smart-scm-picking-ticket-restlet.js'}'`),resolve(testFile)));
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
writeFileSync(`${output}/mutations.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({killed:results.length,propertyOnlyKilled:results.length}));
