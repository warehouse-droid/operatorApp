import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out=resolve('test-artifacts/special-scm-lines-20261003'),root='/tmp/special-scm-lines-mutants';
const files=JSON.parse(readFileSync('tools/special-scm-lines-files.json'));
const hashes=()=>Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const original=hashes();rmSync(root,{force:true,recursive:true});mkdirSync(root);
for(const folder of ['src','public','migrations','test'])cpSync(folder,root+'/'+folder,{recursive:true});
cpSync('package.json',root+'/package.json');symlinkSync('/app/node_modules',root+'/node_modules');
const mutations=[
 ['date-default-off-by-one','public/special-stock-line-fields.js','date.getUTCDate() + 14','date.getUTCDate() + 13',
   'test/mbt/unit/special-case-fields.test.js','new line required dates'],
 ['drop-scm-required-date','public/special-stock-line-fields.js',"SPECIAL_LINE_SCM_FIELDS = [...SPECIAL_LINE_MATERIAL_FIELDS, 'requiredDate']","SPECIAL_LINE_SCM_FIELDS = [...SPECIAL_LINE_MATERIAL_FIELDS]",
   'test/mbt/integration/special-case-fields-http.test.js','SCM required-date correction persists'],
 ['small-scm-description','public/scm-special-stock-requests.js','<p class="special-scm-item-description">${escapeHtml(specialItemDescription(line))}</p>','<small>${escapeHtml(specialItemDescription(line))}</small>',
   'test/mbt/integration/special-case-fields-browser.test.js','SCM description is normal size'],
 ['wrap-desktop-packing','public/special-stock-scm-line.css','repeat(6, minmax(0, 1fr))','repeat(3, minmax(0, 1fr))',
   'test/mbt/integration/special-case-fields-browser.test.js','SCM description is normal size']
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
writeFileSync(out+'/mutations.json',JSON.stringify({sourceHashes:original,total:results.length,killed:results.length,propertyMutants:0,results},null,2));
