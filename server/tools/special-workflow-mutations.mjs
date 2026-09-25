import { cp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root='/tmp/special-workflow-mutants';
await rm(root,{recursive:true,force:true}); await mkdir(root,{recursive:true});
for(const dir of ['src','public','test']) await cp(dir,path.join(root,dir),{recursive:true});
await cp('package.json',path.join(root,'package.json'));
await symlink('/app/node_modules',path.join(root,'node_modules'));
const tests=['test/mbt/unit/special-workflow-adapter.test.js','test/mbt/unit/special-workflow-review.test.js','test/mbt/unit/special-stock-request-service.red.test.js','test/mbt/unit/special-workflow-deploy-readiness.test.js'];
const mutants=[
 ['production stage loses priority','public/special-stock-workflow.js',"if (evidence.waitingForProduction) return 'wait_for_production';",''],
 ['ETA postponement hides reminder','public/special-stock-workflow.js','if (previousDue && previousDue <= today) return previousDue;',''],
 ['zero pallets falls back to inferred quantity','src/dispatch-special-order-pallets.js','specialPalletTotal !== null && specialPalletTotal !== undefined','Number(specialPalletTotal) > 0'],
 ['non-Special product accepted','src/special-stock-request-domain.js','if (normalized.itemId !== 2055)','if (false)'],
 ['description PATCH targets first repeated item','src/special-stock-netsuite-adapter.js','({ line: lineId, description: change.description })','({ line: 1, description: change.description })'],
 ['conflicting remote description overwritten','src/special-stock-netsuite-adapter.js',"|| ![change.previousDescription, change.description].includes(String(line.description || ''))",''],
 ['SO uncertain submission posted twice','src/special-stock-request-service.js','if (claimed.salesOrderSubmissionStartedAt)','if (false)'],
 ['PO uncertain submission posted twice','src/special-stock-request-service.js','if (claimed.purchaseOrderSubmissionStartedAt)','if (false)'],
 ['cost privacy fails open','src/special-stock-request-policy.js','if (audience === "scm" || audience === "admin")','if (true)'],
 ['ambiguous SO identity assigned arbitrarily','src/special-stock-request-domain.js','if (matches.length > 1)','if (false)'],
 ['configured native UOM ID replaced by item ID','src/special-stock-netsuite-adapter.js','unitId: [...configured][0]','unitId: itemId'],
 ['ambiguous configured UOM accepted','src/special-stock-netsuite-adapter.js','if (configured.size > 1)','if (false)']
];
let killed=0;
let propertyKills=0;
for(const [name,file,from,to] of mutants){
 const filename=path.join(root,file),source=await readFile(filename,'utf8');
 if(source.split(from).length!==2) throw new Error(`Mutation target not unique: ${name}`);
 try {
  await writeFile(filename,source.replace(from,to));
  const run=spawnSync(process.execPath,['--test',...tests],{cwd:root,encoding:'utf8',timeout:30000});
  if(run.status!==1 || !run.stdout.includes('not ok') || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(run.stderr+run.stdout)) throw new Error(`Mutant survived or failed for an invalid reason: ${name}\n${run.stdout}\n${run.stderr}`);
  killed++; console.log(`KILLED: ${name}`);
  const properties=spawnSync(process.execPath,['--test','--test-name-pattern=property:|round-trips|terminal siblings|markers remain','test/mbt/unit/special-workflow-adapter.test.js','test/mbt/property/special-stock-request-domain.property.test.js'],{cwd:root,encoding:'utf8',timeout:30000});
  if (![0,1].includes(properties.status) || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(properties.stderr+properties.stdout)) throw new Error(`Invalid property-only mutation run: ${name}`);
  if(properties.status===1){propertyKills++;console.log(`PROPERTY-ONLY KILLED: ${name}`);}
  else console.log(`PROPERTY-ONLY SURVIVED (covered by scenario tests): ${name}`);
 } finally { await writeFile(filename,source); }
}
const restored=spawnSync(process.execPath,['--test',...tests],{cwd:root,encoding:'utf8',timeout:30000});
if(restored.status!==0) throw new Error(`Restored suite failed: ${restored.stdout}`);
console.log(`Manual mutation: ${killed}/${mutants.length} killed. Original workspace was never mutated.`);
console.log(`Property-only mutation: ${propertyKills}/${mutants.length} killed; other mutations expose the limits of the four properties, not failures of the full scenario suite.`);
