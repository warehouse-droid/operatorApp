import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
const files=JSON.parse(await readFile('tools/regular-stock-purchase-files.json','utf8'));
const additional=['tools/regular-stock-purchase-tests.mjs','tools/regular-stock-purchase-static.mjs','tools/regular-stock-purchase-browser.mjs','tools/regular-stock-purchase-mutations.mjs','tools/regular-stock-purchase-coverage.mjs',
  'test/mbt/unit/regular-stock-purchase-domain.test.js','test/mbt/property/regular-stock-purchase.property.test.js','test/mbt/integration/regular-stock-purchase.test.js','test/mbt/integration/regular-stock-purchase-loads.test.js'];
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'}),newDiagnostics=[];
const baselinePath='test-artifacts/regular-stock-purchase/lint-baseline.json';
const baseline=process.env.REGULAR_PURCHASE_CAPTURE_BASELINE?{}:JSON.parse(await readFile(baselinePath,'utf8'));
let checked=0,existingDiagnostics=0;
const diagnostics=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
for(const file of [...files.filter(name=>name.endsWith('.js')), ...additional]){
  const source=await readFile(file,'utf8');
  const syntax=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  if(process.env.REGULAR_PURCHASE_CAPTURE_BASELINE){
    try{baseline[file]=await diagnostics(await readFile(`${process.env.REGULAR_PURCHASE_CAPTURE_BASELINE}/${file}`,'utf8'),file);}catch(error){if(error.code!=='ENOENT')throw error;baseline[file]=[];}
  }
  const previous=[...(baseline[file]||[])];
  for(const message of await diagnostics(source,file)){
    const index=previous.indexOf(message);
    if(index>=0){previous.splice(index,1);existingDiagnostics++;}else newDiagnostics.push({file,message});
  }
  checked++;
}
if(process.env.REGULAR_PURCHASE_CAPTURE_BASELINE)await writeFile(baselinePath,JSON.stringify(baseline,null,2));
const typeResult=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tools/regular-stock-purchase-tsconfig.json'],{encoding:'utf8'});
const report={syntaxFiles:checked,existingDiagnostics,newDiagnostics,strictPurchaseDomainTypes:{exitCode:typeResult.status,output:typeResult.stdout+typeResult.stderr}};
await writeFile('test-artifacts/regular-stock-purchase/static.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
assert.deepEqual(newDiagnostics,[],'No new static diagnostics');assert.equal(typeResult.status,0,typeResult.stdout+typeResult.stderr);
