import {cp,mkdir,access,rm,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const out=path.resolve('test-artifacts/special-independent-po/regressions');
await mkdir(out,{recursive:true});
const failures=text=>[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]).sort();
function run(cwd,label) {
  const result=spawnSync('npm',['run','test:special-stock-request'],{cwd,encoding:'utf8',maxBuffer:32*1024*1024});
  return {status:result.status,output:result.stdout+'\n'+result.stderr,failures:failures(result.stdout),label};
}
let baseline;
let hasBaseline=true;
try {await access('/baseline');}catch {hasBaseline=false;}
const knownFailures=[
  'multi-line case transitions atomically from Sales to SCM and back to an exact SO draft',
  'Sales and SCM Special tabs are real feature-gated interfaces'
].sort();
const runtime=path.join(out,'baseline');
try {
  if(hasBaseline) {
    await mkdir(runtime,{recursive:true});
    for(const folder of ['src','public','migrations','test','contracts'])await cp(folder,path.join(runtime,folder),{recursive:true});
    await cp('package.json',path.join(runtime,'package.json'));await symlink(path.resolve('node_modules'),path.join(runtime,'node_modules'));
    await cp('/baseline',runtime,{recursive:true});
    baseline=run(runtime,'baseline');await writeFile(path.join(out,'baseline.log'),baseline.output);
    if(baseline.status!==1 || JSON.stringify(baseline.failures)!==JSON.stringify(knownFailures)) {
      console.error(baseline.output.slice(-18000));throw Error('Legacy baseline differs from the recorded failures');
    }
  } else baseline={status:1,failures:knownFailures};
  const current=run(process.cwd(),'current');await writeFile(path.join(out,'current.log'),current.output);
  console.log(JSON.stringify({baseline:{status:baseline.status,failures:baseline.failures},current:{status:current.status,failures:current.failures}},null,2));
  console.log(current.output.split('\n').filter(line=>/^# (tests|pass|fail|skipped)/.test(line)).join('\n'));
  if(current.status!==(current.failures.length?1:0) || current.failures.some(name=>!baseline.failures.includes(name))) {
    console.error(current.output.slice(-18000));throw Error('Legacy-suite failures differ from the baseline');
  }
  console.log('Existing Special Request suite: zero new failures.');
}finally{await rm(runtime,{recursive:true,force:true});}
