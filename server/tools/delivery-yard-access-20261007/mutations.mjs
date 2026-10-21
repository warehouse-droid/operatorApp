import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const out=resolve('test-artifacts/delivery-yard-access-20261007');
const guard='test/mbt/unit/regular-stock-target-yard-access.test.js',selection='test/mbt/unit/regular-stock-delivery-selection.test.js';
const integration='test/mbt/integration/regular-stock-target-yard-access.test.js';
const browser='test/mbt/integration/regular-stock-delivery-selection-browser.test.js';
const mutants=[
  ['deny-every-sales-route','src/regular-stock-delivery-access.js',"if (pairedRoute(source, destination) || discoveringBase)","if (false)",guard],
  ['deny-shared-detail','src/regular-stock-delivery-access.js',"return request.requestType === 'regular' && request.workflowVersion === 2","return false && request.requestType === 'regular' && request.workflowVersion === 2",integration],
  ['wrong-sql-delivery-version','src/regular-stock-delivery-access.js',"AND request.regular_details->>'deliveryMethod'='delivery' AND request.regular_details->>'deliveryVersion'='1'","AND request.regular_details->>'deliveryMethod'='delivery' AND request.regular_details->>'deliveryVersion'='2'",integration],
  ['transfer-all-instead-of-checked','src/regular-stock-delivery-domain.js',"return selected.filter(line => selection.includes(line.remoteLineId));","return selected;",selection],
  ['ignore-submit-selection','src/regular-stock-delivery.js',"const materials = deliveryMaterials(order,route.destinationLocationId,selection);","const materials = deliveryMaterials(order,route.destinationLocationId);",integration],
  ['invert-checkbox-selection','public/regular-stock-delivery.js',"if(checked)selected.add(lineId);else selected.delete(lineId);","if(!checked)selected.add(lineId);else selected.delete(lineId);",browser]
];
const results=[];
for(const [name,file,original,replacement,test] of mutants){
  const root=mkdtempSync('/tmp/mbbs-delivery-mutant-');
  try{
    for(const folder of ['src','public'])cpSync(folder,root+'/'+folder,{recursive:true});
    for(const folder of ['node_modules','tools','migrations','contracts'])symlinkSync(resolve(folder),root+'/'+folder);
    for(const file of [guard,selection,integration,browser,'test/mbt/unit/regular-stock-150-sales.test.js']){
      mkdirSync(root+'/'+file.substring(0,file.lastIndexOf('/')),{recursive:true});cpSync(file,root+'/'+file);
    }
    cpSync('package.json',root+'/package.json');mkdirSync(root+'/test-artifacts',{recursive:true});
    const source=readFileSync(root+'/'+file,'utf8');assert.equal(source.split(original).length,2,name+' must patch once');
    writeFileSync(root+'/'+file,source.replace(original,replacement));
    const result=spawnSync(process.execPath,['--test','--test-concurrency=1',test],{cwd:root,encoding:'utf8',timeout:120000,
      maxBuffer:5*1024*1024,env:{...process.env}});
    writeFileSync(out+'/mutation-'+name+'.log',result.stdout+result.stderr);
    const killed=result.status!==null&&result.status!==0&&/^not ok \d+/m.test(result.stdout);
    const propertyFiles=name==='deny-every-sales-route'?['test/mbt/unit/regular-stock-150-sales.test.js']
      :name==='deny-shared-detail'?[guard]:name==='transfer-all-instead-of-checked'?[selection]:[];
    let propertyOnlyKilled=null;
    if(propertyFiles.length){
      const property=spawnSync(process.execPath,['--test','--test-name-pattern=property',...propertyFiles],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:5*1024*1024});
      writeFileSync(out+'/mutation-property-'+name+'.log',property.stdout+property.stderr);
      propertyOnlyKilled=property.status!==null&&property.status!==0&&/^not ok \d+/m.test(property.stdout);
      assert.ok(propertyOnlyKilled,name+' property suite survived');
    }
    results.push({name,killed,exit:result.status,propertyOnlyKilled});console.log(JSON.stringify(results.at(-1)));assert.ok(killed,name+' survived or failed outside a test');
  }finally{rmSync(root,{recursive:true,force:true});}
}
writeFileSync(out+'/mutations.json',JSON.stringify(results,null,2));
