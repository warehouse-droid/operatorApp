import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const root='/tmp/backorder-confirmed-mutants',results=[];
const file='public/backorder-workflow.js',property='test/mbt/property/backorder-link-sequence.property.test.js';
await rm(root,{recursive:true,force:true});
try{
  await mkdir(root+'/test/mbt/property',{recursive:true});
  await cp('public',root+'/public',{recursive:true});
  await cp('package.json',root+'/package.json');
  await cp(property,root+'/'+property);
  await symlink('/app/node_modules',root+'/node_modules');
  const source=await readFile(file,'utf8');
  const mutants=[
    ['restore-so-planning-prerequisite',"return ['sales_order','purchase_order'].includes(kind) && backorderPurchaseReady(detail);","return kind === 'sales_order' ? Boolean(detail.purchaseOrderId && detail.dispatchPlanning?.purchaseOrder?.planned) : backorderPurchaseReady(detail);"],
    ['skip-material-readiness',"return ['sales_order','purchase_order'].includes(kind) && backorderPurchaseReady(detail);","return ['sales_order','purchase_order'].includes(kind);"],
    ['reject-ready-orders',"return ['sales_order','purchase_order'].includes(kind) && backorderPurchaseReady(detail);","return false;"],
    ['allow-pending-sales-decision',"line.salesDecision === 'accepted'","line.salesDecision !== 'request_update'"],
    ['ignore-stock-review',"Boolean(line.supplyStatus && line.stockCheckedAt)","Boolean(line.supplyStatus)"]
  ];
  for(const [name,from,to] of mutants){
    assert.equal(source.split(from).length,2,name+' unique mutation anchor');
    await writeFile(root+'/'+file,source.replace(from,to));
    const result=spawnSync(process.execPath,['--test',property],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2_000_000});
    const output=(result.stdout||'')+(result.stderr||'');
    await writeFile('test-artifacts/mutant-'+name+'.log',output);
    assert.equal(result.signal,null);assert.equal(result.status,1,name+' survived');assert.match(output,/AssertionError/);
    results.push({name,killed:true,layer:'property suite alone'});
  }
  await writeFile(root+'/'+file,source);
  const clean=spawnSync(process.execPath,['--test',property],{cwd:root,encoding:'utf8',timeout:60000});
  assert.equal(clean.status,0,clean.stdout+clean.stderr);
  await writeFile('test-artifacts/mutations.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify({killed:results.length,total:mutants.length,restoredPass:true}));
}finally{await rm(root,{recursive:true,force:true});}
