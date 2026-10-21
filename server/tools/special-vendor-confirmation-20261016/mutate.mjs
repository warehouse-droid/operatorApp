import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const root='/tmp/special-vendor-mutants',results=[];
const file='public/special-stock-workflow.js',property='test/mbt/property/special-vendor-confirmation.property.test.js';
await rm(root,{recursive:true,force:true});
try{
  await mkdir(root+'/test/mbt/property',{recursive:true});
  await cp('public',root+'/public',{recursive:true});
  await cp('package.json',root+'/package.json');
  await cp(property,root+'/'+property);
  await symlink('/app/node_modules',root+'/node_modules');
  const source=await readFile(file,'utf8');
  const mutants=[
    ['missing-so-confirms',"if (!evidence.salesOrderId && !evidence.salesOrderSkipped)","if (false)"],
    ['sent-po-stays-confirmed',"return evidence.purchaseOrderSentToVendorAt ? 'waiting_vendor_confirmation' : 'confirmed';","return 'confirmed';"],
    ['unsent-po-waits-for-vendor',"return evidence.purchaseOrderSentToVendorAt ? 'waiting_vendor_confirmation' : 'confirmed';","return 'waiting_vendor_confirmation';"],
    ['closed-request-keeps-waiting',"if (evidence.closed || evidence.cancelled) return 'closed';","if (false) return 'closed';"],
    ['queued-po-keeps-waiting',"if (evidence.purchaseOrderApproved !== false && specialPurchaseOrderDispatchReady(evidence)","if (false && specialPurchaseOrderDispatchReady(evidence)"]
  ];
  for(const [name,from,to] of mutants){
    assert.equal(source.split(from).length,2,name+' unique mutation anchor');
    await writeFile(root+'/'+file,source.replace(from,to));
    const result=spawnSync(process.execPath,['--test',property],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2_000_000});
    const output=(result.stdout||'')+(result.stderr||'');
    await writeFile('test-artifacts/mutant-'+name+'.log',output);
    assert.equal(result.signal,null);assert.equal(result.status,1,name+' survived');assert.match(output,/Property failed after \d+ tests/);assert.match(output,/Counterexample:/);
    results.push({name,killed:true,layer:'property suite alone'});
  }
  await writeFile(root+'/'+file,source);
  const clean=spawnSync(process.execPath,['--test',property],{cwd:root,encoding:'utf8',timeout:60000});
  assert.equal(clean.status,0,clean.stdout+clean.stderr);
  await writeFile('test-artifacts/mutations.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify({killed:results.length,total:mutants.length,restoredPass:true}));
}finally{await rm(root,{recursive:true,force:true});}
