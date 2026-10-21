import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const artifact='/app/test-artifacts/operator-to-direct-customer/mutations';
const temporary=await mkdtemp('/tmp/direct-to-mutants-');
const mutations=[
  ['post-ir-before-if','transfer-order-posting-domain.js',"return transferVerifiedFulfillment(job,evidence) ? null : 'waiting_fulfillment';",'return null;'],
  ['count-unlinked-material','direct-to-completion-repository.js','if(!completeMaterialCoverage(outbound,allocations))','if(false)'],
  ['borrow-foreign-if','transfer-order-posting-domain.js','Number(transaction.sourceNetSuiteId)!==Number(job.local_to_id)','false'],
  ['ignore-if-quantity','transfer-order-posting-domain.js','return transferQuantitiesCovered(job.snapshot.lines,proof.lines) ? proof : null;','return proof;'],
  ['skip-driver-replay-discovery','order-dependency-repository.js','    await completeDirectTransfersForDependencies(rows.rows);','    void rows;'],
  ['invent-manual-system-actor','operator-netsuite-posting-domain.js','? null : requiredText(input.actorOperatorId, "Operator ID");','? null : String(input.actorOperatorId || "system");'],
  ['omit-direct-audit','direct-to-completion-repository.js',"await writeAudit({actorType:'system'","await (async()=>{})({actorType:'system'"],
  ['accept-missing-system-proof','operator-netsuite-posting-domain.js','if(!directTransferOperation(input) || !directTransferLists(evidence))','if(false)']
];
await mkdir(artifact,{recursive:true});
try {
  await cp('/app/src',`${temporary}/src`,{recursive:true});
  await symlink('/app/node_modules',`${temporary}/node_modules`);
  await symlink('/app/public',`${temporary}/public`);
  await symlink('/app/contracts',`${temporary}/contracts`);
  await cp('/app/package.json',`${temporary}/package.json`);
  const tests=['integration/direct-to-completion.test.js','property/direct-to-completion.property.test.js'];
  await mkdir(`${temporary}/support`);
  const fixture=(await readFile('/app/test/support/operator-to-yard-flow-fixture.mjs','utf8')).replaceAll('../../src/',`${temporary}/src/`);
  await writeFile(`${temporary}/support/fixture.mjs`,fixture);
  for(const name of tests) {
    const source=(await readFile(`/app/test/mbt/${name}`,'utf8')).replaceAll('../../../src/',`${temporary}/src/`)
      .replaceAll('../../support/operator-to-yard-flow-fixture.mjs',`${temporary}/support/fixture.mjs`);
    await writeFile(`${temporary}/${name.replaceAll('/','-')}`,source);
  }
  const results=[];
  for(const [name,file,before,after] of mutations) {
    const path=`${temporary}/src/${file}`,original=await readFile(path,'utf8');
    assert.equal(original.split(before).length,2,`Unique mutation: ${name}`);
    await writeFile(path,original.replace(before,after));
    const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests.map(t=>`${temporary}/${t.replaceAll('/','-')}`)],
      {encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
    await writeFile(path,original);
    const output=(run.stdout || '')+(run.stderr || '');await writeFile(`${artifact}/${name}.log`,output);
    assert.ok(run.status!==0 && /not ok/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output),`Mutant survived or infrastructure failed: ${name}`);
    let propertyKilled=null;
    if(['post-ir-before-if','borrow-foreign-if','ignore-if-quantity'].includes(name)) {
      await writeFile(path,original.replace(before,after));
      const property=spawnSync(process.execPath,['--test',`${temporary}/property-direct-to-completion.property.test.js`],
        {encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
      await writeFile(path,original);
      await writeFile(`${artifact}/${name}-property.log`,(property.stdout || '')+(property.stderr || ''));
      propertyKilled=property.status!==0 && /not ok/u.test(property.stdout || '');
      assert.ok(propertyKilled,`Property-only mutant survived: ${name}`);
    }
    results.push({name,killed:true,propertyKilled});console.log(`Killed ${name}`);
  }
  await writeFile(`${artifact}/results.json`,JSON.stringify(results,null,2)+'\n');
} finally {await rm(temporary,{recursive:true,force:true});}
