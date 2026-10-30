import {cp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const runtime=path.resolve('test-artifacts/special-independent-po/mutants');
await rm(runtime,{recursive:true,force:true});await mkdir(runtime,{recursive:true});
try {
  for(const folder of ['src','public']) {await cp(folder,path.join(runtime,folder),{recursive:true});}
  await cp('package.json',path.join(runtime,'package.json'));
  await mkdir(path.join(runtime,'test/mbt/unit'),{recursive:true});
  for(const file of ['special-independent-po.test.js','special-stock-request-service.red.test.js']) {
    await cp('test/mbt/unit/'+file,path.join(runtime,'test/mbt/unit',file));
  }
  await symlink(path.resolve('node_modules'),path.join(runtime,'node_modules'));
  const packSource=await readFile(path.join(runtime,'src/special-stock-request-netsuite.js'),'utf8');
  const packing=packSource.includes('\n  if (purchase) Object.assign(payload, specialPackPayload(line));')
    ? ['\n  if (purchase) Object.assign(payload, specialPackPayload(line));','']
    : ['\n  Object.assign(payload, specialPackPayload(line));','\n  if (!purchase) Object.assign(payload, specialPackPayload(line));'];
  const mutants=[
    ['accept invalid unit ID','src/special-stock-purchase-units.js','(!line.unitId || unit.id === Number(line.unitId))','true'],
    ['allow sales-only items','src/special-stock-purchase-units.js',"['Sale','Sales'].includes(row.subtype)",'false'],
    ['discard PO packing','src/special-stock-request-netsuite.js',...packing],
    ['allow new native SO link discovery','src/special-stock-request-service.js','!prepared.purchaseOrderSubmissionStartedAt || prepared.purchaseOrderCustomLinkage','prepared.purchaseOrderCustomLinkage']
  ];
  for(const [name,file,from,to] of mutants) {
    const target=path.join(runtime,file),original=await readFile(target,'utf8');
    if(original.split(from).length!==2) {throw Error('Mutation must match once: '+name);}
    await writeFile(target,original.replace(from,to));
    try {
      const tests=file.includes('service')?['special-stock-request-service.red.test.js']:['special-independent-po.test.js'];
      const result=spawnSync('node',['--test',...tests.map(test=>'test/mbt/unit/'+test)],{cwd:runtime,encoding:'utf8'});
      if(result.status===0 || !result.stdout.includes('not ok')) {throw Error('Mutant survived or failed outside assertions: '+name+'\n'+result.stderr);}
      console.log('Killed:',name);
      if(name==='discard PO packing') {
        const property=spawnSync('node',['--test','--test-name-pattern=property:','test/mbt/unit/special-independent-po.test.js'],{cwd:runtime,encoding:'utf8'});
        if(property.status===0 || !property.stdout.includes('not ok')) {throw Error('Packing property did not kill its mutant');}
        console.log('Property-only kill: discarded PO packing');
      }
    } finally {await writeFile(target,original);}
  }
  console.log('Manual mutations: 4/4 killed');
} finally {await rm(runtime,{recursive:true,force:true});}
