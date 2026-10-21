import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const out='test-artifacts/mbr-rates/mutations';await mkdir(out,{recursive:true});
const mutants=[
  {name:'null-default-becomes-zero',file:'public/mbr/rates.js',before:'?null:moneyMinor(value)',after:'?0:moneyMinor(value)',property:true},
  {name:'defaults-from-another-model',file:'public/mbr/rates.js',before:'item.model===model',after:'item.model!==model',property:true},
  {name:'weekly-default-copies-daily',file:'public/mbr/rates.js',before:'weeklyRateMinor:optionalRate(data.weeklyRate)',after:'weeklyRateMinor:optionalRate(data.dailyRate)',property:true},
  {name:'stale-rate-update-overwrites',file:'src/mbr/rates-repository.js',before:'WHERE model=$1 AND revision=$6 RETURNING',after:'WHERE model=$1 AND revision>=$6 RETURNING',http:true},
  {name:'model-selection-does-not-copy-rates',file:'public/mbr/staff.js',before:"form.elements[name].value=moneyValue(rates[name+'Minor']);",after:"void moneyValue(rates[name+'Minor']);",browser:true}
];
const results=[];
for(const mutant of mutants) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'mbr-rates-mutant-'));
  try {
    for(const folder of ['src','public','migrations','test/mbr']) {await cp(folder,path.join(directory,folder),{recursive:true,dereference:true});}
    await mkdir(path.join(directory,'test/field-sales'),{recursive:true});
    await cp('test/field-sales/pdf-text.js',path.join(directory,'test/field-sales/pdf-text.js'));
    await cp('package.json',path.join(directory,'package.json'));
    await symlink(path.resolve('node_modules'),path.join(directory,'node_modules'));
    await symlink(path.resolve('test-artifacts'),path.join(directory,'test-artifacts'));
    const file=path.join(directory,mutant.file),original=await readFile(file,'utf8');
    assert.equal(original.split(mutant.before).length,2,'Unique mutation source: '+mutant.name);
    await writeFile(file,original.replace(mutant.before,mutant.after));
    const args=mutant.browser?['test/mbr/rates-browser.mjs']:['--test','--test-concurrency=1',
      ...(mutant.http?['--test-name-pattern=Setup persists nullable and zero']:[]),mutant.http?'test/mbr/rates-http.test.js':'test/mbr/rates.test.js'];
    const run=extra=>spawnSync(process.execPath,extra,{cwd:directory,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024,env:process.env});
    const result=run(args);
    const output=(result.stdout || '')+(result.stderr || '');
    await writeFile(`${out}/${mutant.name}.log`,output);
    assert.doesNotMatch(output,/ERR_MODULE_NOT_FOUND|SyntaxError|ENOSPC/u,'Mutation must fail on behavior, not tooling');
    assert.match(output,mutant.browser?/toHaveValue/u:/not ok|Property failed/u,'Mutation must produce an assertion failure');
    let propertyKilled=null;
    if(mutant.property) {
      const property=run(['--test','--test-name-pattern=property: arbitrary nullable','test/mbr/rates.test.js']);
      await writeFile(`${out}/${mutant.name}-property.log`,(property.stdout || '')+(property.stderr || ''));
      propertyKilled=property.status!==0 && !property.error;
      assert.equal(propertyKilled,true,'Property suite must kill '+mutant.name);
    }
    const killed=result.status!==0 && !result.error && !result.signal;
    results.push({name:mutant.name,killed,propertyKilled});console.log(JSON.stringify(results.at(-1)));
    assert.equal(killed,true,'Mutation survived: '+mutant.name);
  } finally {await rm(directory,{recursive:true,force:true});}
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
