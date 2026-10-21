import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {withCoTestDatabase} from '../../test/support/co-direct-to-isolation.mjs';
const out='test-artifacts/split-allocation-guard-20261015',testFile='test/dispatch/integration/sales-split-allocation-unsplit.test.js';
const guard='src/dispatch-sales-split-allocation.js',registry='src/dispatch-delivery-group-repository.js',unsplit='src/dispatch-sales-resplit-repository.js';
const mutants=[
 ['ignore-po',guard,"FROM dispatch_so_po_allocations WHERE status='active'","FROM dispatch_so_po_allocations WHERE false",'^PO allocation'],
 ['ignore-to',guard,"FROM order_dependencies WHERE status<>'cancelled'","FROM order_dependencies WHERE false",'^TO allocation'],
 ['block-cancelled-po',guard,"FROM dispatch_so_po_allocations WHERE status='active'","FROM dispatch_so_po_allocations WHERE status IN ('active','cancelled')",'^cancelled PO'],
 ['skip-save-check',registry,'assertSalesOrderSplitUnallocated(changedSalesSplits.flatMap','assertSalesOrderSplitUnallocated([].flatMap','^PO allocation blocks initial'],
 ['drop-fleet-lock',registry,'export async function syncDispatchGlobalOrderSplitsFromPlan(plan = {}) {\n  return withTransaction(async () => {\n    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);',
  'export async function syncDispatchGlobalOrderSplitsFromPlan(plan = {}) {\n  return withTransaction(async () => {','^a link committed'],
 ['reject-legacy-pieces',unsplit,'const legacy = item.itemType === "NonInvtPart"','const legacy = false && item.itemType === "NonInvtPart"','^unsplit restores'],
 ['ignore-sales-conservation',unsplit,'if (Math.abs(total - expected[key]) > 0.000001)','if (key !== "quantity" && Math.abs(total - expected[key]) > 0.000001)','^converted packing'],
 ['discard-unknown-line',unsplit,'if (!keys.has(itemKey(item)) || seen.has(itemKey(item)))','if (false)','^unknown child'],
 ['stale-restored-flags',unsplit,'const [restoredOrder] = await overlayFulfilledSalesDeliveryPlanning(','const [restoredOrder] = await Promise.resolve(','^unsplit immediately'],
 ['lose-restored-pieces',unsplit,'...family.siblings[0].full_order, ...preview, id: family.rootRef','...family.siblings[0].full_order, ...preview, items: preview.items.map(item => ({...item,pieces:0})), id: family.rootRef','^unsplit restores'],
 ['recover-blocked-save','src/server.js','  "DISPATCH_SPLIT_ALLOCATED",\n','','^HTTP rejects'],
 ['false-stale-decimals',unsplit,'Number(Number(item[key] ?? 0).toFixed(6))','Number(item[key] ?? 0)','^property:']
];
const results=[];
for(const [name,file,before,after,pattern] of mutants){
 const root=mkdtempSync('/tmp/split-guard-mutant-');
 try{
  for(const folder of ['src','public','test/dispatch/support'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const path of ['package.json',testFile]){mkdirSync(dirname(root+'/'+path),{recursive:true});cpSync(path,root+'/'+path);}
  for(const folder of ['node_modules','migrations','contracts','test-artifacts'])symlinkSync(resolve(folder),root+'/'+folder);
  const source=readFileSync(root+'/'+file,'utf8');assert.equal(source.split(before).length,2,name);
  writeFileSync(root+'/'+file,source.replace(before,after));
  const run=filter=>withCoTestDatabase('split-mutant-'+name+'-'+filter,databaseUrl=>
   spawnSync(process.execPath,['--test','--test-concurrency=1','--test-name-pattern='+filter,testFile],
    {cwd:root,env:{...process.env,DATABASE_URL:databaseUrl},encoding:'utf8',timeout:90_000,maxBuffer:8*1024*1024}));
  const main=await run(pattern),log=main.stdout+main.stderr;writeFileSync(`${out}/mutant-${name}.log`,log);
  const fail=Number(log.match(/^# fail (\d+)$/mu)?.[1]||0);
  const killed=main.status===1 && fail>0 && !/ERR_MODULE_NOT_FOUND|SyntaxError/u.test(log);
  const property=await run('^property:'),propertyLog=property.stdout+property.stderr;
  writeFileSync(`${out}/mutant-${name}-property.log`,propertyLog);
  const propertyKilled=property.status===1 && /Property failed/u.test(propertyLog);
  results.push({name,killed,failures:fail,exit:main.status,propertyKilled});
  writeFileSync(`${out}/mutations.json`,JSON.stringify(results,null,2)+'\n');
  assert.equal(killed,true,name+' survived: '+log.slice(-1500));
 }finally{rmSync(root,{recursive:true,force:true});}
}
assert.equal(results.filter(row=>row.propertyKilled).length,3,'Quantity property mutants must be detected independently');
console.log(JSON.stringify(results));
