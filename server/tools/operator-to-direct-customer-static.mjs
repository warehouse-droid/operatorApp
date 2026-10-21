import assert from 'node:assert/strict';
import {cp,mkdtemp,writeFile,symlink,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const artifact='/app/test-artifacts/operator-to-direct-customer';
const temporary=await mkdtemp('/tmp/direct-to-baseline-');
const files=['src/operator-netsuite-posting-domain.js','src/order-dependency-repository.js','src/transfer-order-posting-domain.js',
  'src/transfer-order-posting-repository.js','src/transfer-order-posting-service.js'];
const finalFiles=[...files,'src/direct-to-completion-repository.js'];
function execute(command,args,cwd) {
  const run=spawnSync(command,args,{cwd,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
  assert.ok(run.status!==null,(run.stderr || '')+'Check timed out');return run;
}
function delta(before,after) {
  const counts=new Map();for(const value of before){counts.set(value,(counts.get(value) || 0)+1);}
  return after.filter(value=>{const count=counts.get(value) || 0;if(count){counts.set(value,count-1);return false;}return true;});
}
function typeErrors(output,root) {
  return output.split('\n').filter(line=>line.includes(': error TS')).map(line=>{
    const match=/^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/u.exec(line);
    assert.ok(match,line);const filename=path.relative(root,path.resolve(root,match[1]));
    return `${filename}: ${match[2]}: ${match[3].replaceAll(temporary,'/app')}`;
  });
}
function lintErrors(output,root) {
  return JSON.parse(output).flatMap(row=>row.messages.map(message=>`${path.relative(root,row.filePath)}:${message.ruleId}:${message.message.replace(/on line \d+ column \d+/gu,'on line <baseline>')}`));
}
try {
  await cp(`${artifact}/type-baseline/src`,`${temporary}/src`,{recursive:true});
  await cp('/app/package.json',`${temporary}/package.json`);
  await symlink('/app/node_modules',`${temporary}/node_modules`);
  await symlink('/app/public',`${temporary}/public`);
  await symlink('/app/contracts',`${temporary}/contracts`);
  const config={extends:'/app/tsconfig.mbt.json',include:files};
  await writeFile(`${temporary}/tsconfig.json`,JSON.stringify(config));
  await writeFile(`${artifact}/tsconfig.json`,JSON.stringify({...config,include:finalFiles.map(file=>'/app/'+file)}));
  const before=execute(process.execPath,['/app/node_modules/typescript/bin/tsc','--project',`${temporary}/tsconfig.json`,'--pretty','false'],temporary);
  const after=execute(process.execPath,['/app/node_modules/typescript/bin/tsc','--project',`${artifact}/tsconfig.json`,'--pretty','false'],'/app');
  await writeFile(`${artifact}/types-baseline.log`,before.stdout+before.stderr);await writeFile(`${artifact}/types-final.log`,after.stdout+after.stderr);
  const oldTypes=typeErrors(before.stdout,temporary),newTypes=typeErrors(after.stdout,'/app'),typeDelta=delta(oldTypes,newTypes);
  const args=['/app/node_modules/eslint/bin/eslint.js','--config','/app/tools/operator-to-direct-customer-eslint.config.mjs','--format','json'];
  const oldLint=execute(process.execPath,[...args,...files],temporary);
  const finalLint=execute(process.execPath,[...args,...finalFiles,'test/mbt/integration/direct-to-completion.test.js',
    'test/mbt/property/direct-to-completion.property.test.js','tools/operator-to-direct-customer-mutations.mjs',
    'tools/operator-to-direct-customer-static.mjs'],'/app');
  await writeFile(`${artifact}/lint-baseline.json`,oldLint.stdout);await writeFile(`${artifact}/lint-final.json`,finalLint.stdout);
  const lintDelta=delta(lintErrors(oldLint.stdout,temporary),lintErrors(finalLint.stdout,'/app'));
  const result={types:{baseline:oldTypes.length,final:newTypes.length,new:typeDelta},lint:{new:lintDelta}};
  await writeFile(`${artifact}/static.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  assert.equal(typeDelta.length,0,'New type errors');assert.equal(lintDelta.length,0,'New lint errors or warnings');
  const manifest=JSON.parse(await readFile(`${artifact}/manifest.json`,'utf8'));
  for(const candidateFile of Object.keys(manifest.changes).filter(name=>name.endsWith('.js'))) {
    assert.equal(execute(process.execPath,['--check',candidateFile],'/app').status,0,candidateFile);
  }
} finally {await rm(temporary,{recursive:true,force:true});}
