import {cp,mkdtemp,readFile,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const output='test-artifacts/mbr-contract/mutation';await mkdir(output,{recursive:true});
const mutants=[
  {name:'wrong-currency-unit',file:'public/mbr/domain.js',before:'Number(whole) * 100',after:'Number(whole) * 10',tests:'domain',property:true},
  {name:'accept-at-deadline',file:'public/mbr/domain.js',before:'<= now.getTime()',after:'< now.getTime()',tests:'domain',property:true},
  {name:'expire-completed',file:'public/mbr/domain.js',before:"contract.status === 'pending' && contract.expiresAt",after:'contract.expiresAt',tests:'domain',property:true},
  {name:'allow-other-staff',file:'public/mbr/domain.js',before:"!roles.has('mbr_sales') && !roles.has('admin')",after:'false',tests:'domain'},
  {name:'flip-protection-choice',file:'public/mbr/domain.js',before:'protectionPlanAccepted:data.protectionPlanAccepted',after:'protectionPlanAccepted:!data.protectionPlanAccepted',tests:'domain'},
  {name:'allow-stale-signature',file:'src/mbr/repository.js',before:'row.current_revision!==revision',after:'false',tests:'repository'},
  {name:'omit-insurance-clause',file:'src/mbr/agreement.js',before:'return paragraphs;',after:'return paragraphs.filter((_value,index)=>index!==10);',tests:'repository'}
];
const report=[];
for(const mutant of mutants) {
  let directory=null;
  try {
    directory=await mkdtemp(path.join(os.tmpdir(),'mbr-mutant-'));
    for(const folder of ['src','public','test/mbr']) {await cp(folder,path.join(directory,folder),{recursive:true});}
    await mkdir(path.join(directory,'test/field-sales'),{recursive:true});
    await cp('test/field-sales/pdf-text.js',path.join(directory,'test/field-sales/pdf-text.js'));
    await cp('package.json',path.join(directory,'package.json'));
    await symlink('/app/node_modules',path.join(directory,'node_modules'));
    const filename=path.join(directory,mutant.file),original=await readFile(filename,'utf8');
    if(original.split(mutant.before).length!==2) {throw new Error(`Mutant ${mutant.name} has no unique source location.`);}
    await writeFile(filename,original.replace(mutant.before,mutant.after));
    const result=spawnSync('node',['--test','--test-concurrency=1',`test/mbr/${mutant.tests}.test.js`],{cwd:directory,env:process.env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
    await writeFile(`${output}/${mutant.name}.log`,(result.stdout || '')+(result.stderr || ''));
    let properties=null;
    if(mutant.property) {
      const propertyResult=spawnSync('node',['--test','test/mbr/properties.test.js'],{cwd:directory,env:process.env,encoding:'utf8',timeout:30000});
      await writeFile(`${output}/${mutant.name}-properties.log`,(propertyResult.stdout || '')+(propertyResult.stderr || ''));
      properties=propertyResult.status!==0 && !propertyResult.error;
    }
    const killed=result.status!==0 && !result.error;
    report.push({name:mutant.name,killed,propertyKilled:properties});console.log(JSON.stringify(report.at(-1)));
    if(!killed || properties===false) {throw new Error(`Mutant survived: ${mutant.name}`);}
  } finally {if(directory) {await rm(directory,{recursive:true,force:true});}}
}
await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));
