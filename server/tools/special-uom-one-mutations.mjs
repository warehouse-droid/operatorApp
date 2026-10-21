import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out=resolve('test-artifacts/special-uom-one-20261003'),root='/tmp/special-uom-one-mutants';
const files=JSON.parse(readFileSync('tools/special-uom-one-files.json'));
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const original=hashes();rmSync(root,{force:true,recursive:true});mkdirSync(root);
for(const folder of ['src','public','migrations','test'])cpSync(folder,root+'/'+folder,{recursive:true});
cpSync('package.json',root+'/package.json');symlinkSync('/app/node_modules',root+'/node_modules');
const mutations=[
 ['client-controls-conversion','src/special-stock-request-repository.js','const conversion = 1;','const conversion = line.conversionToPc ?? 1;',
   'test/mbt/integration/special-case-fields-http.test.js','property: issued adjustments'],
 ['require-conversion-entry','src/special-stock-request-repository.js','const conversion = 1;',
   "const conversion = 1; if (fields.uom && line.conversionToPc == null) throw workflowError('Conversion entry required',400,'SPECIAL_CONVERSION_INVALID');",
   'test/mbt/integration/special-case-fields-http.test.js','issued order metadata'],
 ['restore-conversion-control','public/special-stock-line-fields.js','return `<div class="stock-request-line-fields special-case-initial-grid">',
   'return `<input name="conversionToPc" value="1" /><div class="stock-request-line-fields special-case-initial-grid">',
   'test/mbt/unit/special-case-fields.test.js','fixed unit conversion']
];
const results=[];
try {
 for(const [name,file,before,after,suite,pattern] of mutations) {
  const source=readFileSync(root+'/'+file,'utf8');assert.equal(source.split(before).length,2,name);
  try {
   writeFileSync(root+'/'+file,source.replace(before,after));
   const result=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,suite],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:10000000});
   const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/mutant-'+name+'.log',log);
   assert.equal(result.status,1,name+' survived');assert.match(log,/not ok \d+ - /,name+' must fail a behavior test');
   results.push({name,killed:true,propertiesOnly:pattern.startsWith('property:')});console.log(name+': killed');
  } finally {writeFileSync(root+'/'+file,source);}
 }
} finally {rmSync(root,{force:true,recursive:true});}
assert.deepEqual(hashes(),original);
writeFileSync(out+'/mutations.json',JSON.stringify({sourceHashes:original,total:results.length,killed:results.length,propertyMutants:1,results},null,2));
