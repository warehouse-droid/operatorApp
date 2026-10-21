import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const artifact='/app/test-artifacts/operator-to-yard-flow-deployment/partial-mutations';
const temporary=await mkdtemp('/tmp/to-partial-mutant-');
async function detectMutation(testFile,name,pattern=null) {
  const source=(await readFile(`/app/test/mbt/integration/${testFile}`,'utf8'))
    .replaceAll('../../../src/',`${temporary}/src/`).replaceAll('../../support/','/app/test/support/')
    .replaceAll('../../../tools/','/app/tools/');
  const path=`${temporary}/${testFile}`;
  await writeFile(path,source);
  const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...(pattern?[`--test-name-pattern=${pattern}`]:[]),path],
    {encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  const output=(run.stdout || '')+(run.stderr || '');
  await writeFile(`${artifact}/${name}.log`,output);
  assert.ok(run.status!==0 && /not ok/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output),'The mutation survived or failed infrastructure');
  console.log(`Killed ${name}`);
  return {name,killed:true};
}
try {
  await mkdir(artifact,{recursive:true});
  await mkdir(`${temporary}/src`);
  await symlink('/app/node_modules',`${temporary}/node_modules`);
  await writeFile(`${temporary}/package.json`,JSON.stringify({type:'module'}));
  for(const entry of await readdir('/app/src')) {
    if(!['receiving-repository.js','delivery-repository.js'].includes(entry)){await symlink(`/app/src/${entry}`,`${temporary}/src/${entry}`);}
  }
  const original=await readFile('/app/src/receiving-repository.js','utf8');
  const anchor="const completionLines=order.order_type==='transfer_order' && !allowNetSuiteCompleted\n    ? await transferReceiptCompletionLines(orderId) : order.lines || [];";
  assert.equal(original.split(anchor).length,2);
  await writeFile(`${temporary}/src/receiving-repository.js`,original.replace(anchor,'const completionLines=order.lines || [];'));
  const delivery=await readFile('/app/src/delivery-repository.js','utf8');
  await writeFile(`${temporary}/src/delivery-repository.js`,delivery);
  const results=[await detectMutation('operator-to-legacy-receiving.test.js','forget-unloaded-items')];
  await writeFile(`${temporary}/src/receiving-repository.js`,original);
  const gate="           AND (outbound_operator_status IS DISTINCT FROM 'loaded' OR receiving_status IS DISTINCT FROM 'received')\n";
  assert.equal(delivery.split(gate).length,2);
  await writeFile(`${temporary}/src/delivery-repository.js`,delivery.replace(gate,''));
  results.push(await detectMutation('operator-to-yard-flow-reconciliation.test.js','reopen-historical-outbound','historical completion retains'));
  await writeFile(`${artifact}/results.json`,JSON.stringify(results,null,2)+'\n');
} finally {await rm(temporary,{recursive:true,force:true});}
