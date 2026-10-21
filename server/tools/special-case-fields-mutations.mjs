import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out=resolve('test-artifacts/special-case-fields-20261003'),root='/tmp/special-case-fields-mutants';
const files=JSON.parse(readFileSync('tools/special-case-fields-files.json'));
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const original=hashes();
rmSync(root,{force:true,recursive:true});mkdirSync(root);
for(const folder of ['src','public','migrations','test'])cpSync(folder,root+'/'+folder,{recursive:true});
cpSync('package.json',root+'/package.json');symlinkSync('/app/node_modules',root+'/node_modules');
const definitions=[
 ['discard-corrections','public/special-stock-line-fields.js','if (value !== saved[field]) changes[field] = value;','if (false) changes[field] = value;','test/mbt/unit/special-case-fields.test.js','property:'],
 ['skip-material-review','public/special-stock-case-edits.js','restart: lines.some(change => change.reviewChanged)','restart: false','test/mbt/unit/special-case-fields.test.js','property:'],
 ['ignore-discount','public/special-stock-line-fields.js',"else if (field === 'discountPercent') value = normalizeSpecialDiscount(value);","else if (field === 'discountPercent') value = 0;",'test/mbt/unit/special-case-fields.test.js','property:'],
 ['omit-remote-packing','src/special-stock-rest-orders.js',"payload[native] = line.pack[field] ?? 0;","payload[native] = source[native] ?? 0;",'test/mbt/unit/special-case-fields-orders.test.js','approved SO/PO description'],
 ['omit-service-corrections','src/special-stock-quantity-service.js','return { ...line, ...corrected, rate:','return { ...line, rate:','test/mbt/unit/special-case-fields-orders.test.js','service carries reviewed'],
 ['omit-review-details','public/special-stock-line-fields.js','return Object.entries(change.toFields || {})','return Object.entries({})','test/mbt/integration/special-case-fields-browser.test.js','pending adjustment shows']
];
const results=[];
for(const [name,file,before,after,suite,pattern] of definitions){
 const source=readFileSync(root+'/'+file,'utf8');assert.equal(source.split(before).length,2,name);
 try{
  writeFileSync(root+'/'+file,source.replace(before,after));
  const result=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,suite],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:10000000});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/mutant-'+name+'.log',log);
  assert.equal(result.status,1,name+' survived');assert.match(log,/not ok \d+ - /,name+' must fail an assertion');
  results.push({name,killed:true,propertiesOnly:pattern==='property:'});console.log(name+': killed');
 }finally{writeFileSync(root+'/'+file,source);}
}
assert.deepEqual(hashes(),original);
writeFileSync(out+'/mutations.json',JSON.stringify({sourceHashes:original,total:results.length,killed:results.length,propertyMutants:3,results},null,2));
rmSync(root,{force:true,recursive:true});
