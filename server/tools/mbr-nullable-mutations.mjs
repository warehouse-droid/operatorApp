import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const out='test-artifacts/mbr-nullable/mutations';await mkdir(out,{recursive:true});
const mutants=[
  {name:'blank-rate-becomes-zero',file:'public/mbr/domain.js',before:'function optionalMoney(value) {return blank(value)?null:',after:'function optionalMoney(value) {return blank(value)?0:',property:true},
  {name:'null-expiry-breaks-links',file:'src/mbr/repository.js',before:'fields.expiryDays ?? 3',after:'fields.expiryDays',http:true},
  {name:'null-printed-in-agreement',file:'src/mbr/agreement.js',before:"return value===null || value===undefined || value===''?placeholder:String(value);",after:'return String(value);'},
  {name:'mismatched-model-accepted',file:'public/mbr/equipment.js',before:'item.model===fields.equipmentModel',after:'true'}
];
const results=[];
for(const mutant of mutants) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'mbr-nullable-mutant-'));
  try {
    for(const folder of ['src','public','test/mbr']) {await cp(folder,path.join(directory,folder),{recursive:true,dereference:true});}
    await mkdir(path.join(directory,'test/field-sales'),{recursive:true});
    await cp('test/field-sales/pdf-text.js',path.join(directory,'test/field-sales/pdf-text.js'));
    await cp('package.json',path.join(directory,'package.json'));
    await symlink(path.resolve('node_modules'),path.join(directory,'node_modules'));
    const file=path.join(directory,mutant.file),original=await readFile(file,'utf8');
    assert.ok(original.includes(mutant.before),'Mutation source exists: '+mutant.name);
    await writeFile(file,original.replaceAll(mutant.before,mutant.after));
    const args=['--test','--test-concurrency=1',mutant.http?'test/mbr/nullable-http.test.js':'test/mbr/nullable.test.js'];
    const result=spawnSync(process.execPath,args,{cwd:directory,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,env:process.env});
    await writeFile(`${out}/${mutant.name}.log`,(result.stdout || '')+(result.stderr || ''));
    let propertyKilled=null;
    if(mutant.property) {
      const property=spawnSync(process.execPath,['--test','--test-name-pattern=property: arbitrary subsets','test/mbr/nullable.test.js'],
        {cwd:directory,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:process.env});
      await writeFile(`${out}/${mutant.name}-property.log`,(property.stdout || '')+(property.stderr || ''));
      propertyKilled=property.status!==0 && !property.error;
      assert.equal(propertyKilled,true,'Property suite must kill '+mutant.name);
    }
    const killed=result.status!==0 && !result.error;
    results.push({name:mutant.name,killed,propertyKilled});console.log(JSON.stringify(results.at(-1)));
    assert.equal(killed,true,'Mutation survived: '+mutant.name);
  } finally {await rm(directory,{recursive:true,force:true});}
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
