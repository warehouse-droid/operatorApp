import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const out='test-artifacts/mbr-equipment/mutations';await mkdir(out,{recursive:true});
const mutants=[
  {name:'wrong-model-SNs',file:'public/mbr/equipment.js',before:'items.filter(item=>item.active && item.model===model)',after:'items.filter(item=>item.active)',property:true},
  {name:'inactive-models-shown',file:'public/mbr/equipment.js',before:'items.filter(item=>item.active).map(item=>item.model)',after:'items.map(item=>item.model)',property:true},
  {name:'wrong-SN-accepted',file:'public/mbr/equipment.js',before:' && item.serialNumber===fields.serialNumber',after:'',property:true},
  {name:'unknown-equipment-accepted',file:'public/mbr/equipment.js',before:'if(!items.some',after:'if(false && !items.some',property:true},
  {name:'stale-setup-overwrite',file:'src/mbr/equipment-repository.js',before:'WHERE id=$1 AND revision=$9 RETURNING',after:'WHERE id=$1 AND $9::integer>0 RETURNING',http:true},
  {name:'public-unsigned-download',file:'src/mbr/repository.js',before:"if(credential) {throw new MbrError('The signed PDF",after:"if(false && credential) {throw new MbrError('The signed PDF",http:true},
  {name:'swallowed-storage-error',file:'src/mbr/equipment-repository.js',before:'  throw error;',after:'  return undefined;',http:true}
];
const results=[];
for(const mutant of mutants) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'mbr-equipment-mutant-'));
  try {
    for(const folder of ['src','public','test/mbr']) {await cp(folder,path.join(directory,folder),{recursive:true,dereference:true});}
    await mkdir(path.join(directory,'test/field-sales'),{recursive:true});
    await cp('test/field-sales/pdf-text.js',path.join(directory,'test/field-sales/pdf-text.js'));
    await cp('package.json',path.join(directory,'package.json'));
    await symlink(path.resolve('node_modules'),path.join(directory,'node_modules'));
    const file=path.join(directory,mutant.file),original=await readFile(file,'utf8');
    assert.equal(original.split(mutant.before).length,2,'Unique mutation source: '+mutant.name);
    await writeFile(file,original.replace(mutant.before,mutant.after));
    const args=['--test','--test-concurrency=1',mutant.http?'test/mbr/equipment-http.test.js':'test/mbr/equipment.test.js'];
    const result=spawnSync(process.execPath,args,{cwd:directory,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,env:process.env});
    await writeFile(`${out}/${mutant.name}.log`,(result.stdout || '')+(result.stderr || ''));
    let propertyKilled=null;
    if(mutant.property) {
      const property=spawnSync(process.execPath,['--test','--test-name-pattern=sound and complete','test/mbr/equipment.test.js'],
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
