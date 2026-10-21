import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Runtime mutation checks require the isolated test database.');}
const root=process.cwd(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'stock-check-runtime-mutants-'));
const definitions=[
  {name:'claim a queued job despite another worker holding the lock',file:'runtime.js',from:'if(!locked) {return;}',
    to:'if(!locked) {await repo.claimNextJob();return;}',pattern:'two app workers'},
  {name:'ignore a changed account revision',file:'runtime.js',from:'account.revision!==job.payload.accountRevision',to:'false',pattern:'changed vendor credentials'},
  {name:'persist an external error without removing the vendor password',file:'runtime.js',from:'sanitizeFailure(error,[credentials?.password])',
    to:'sanitizeFailure(error,[])',pattern:'login worker saves private screenshot'},
  {name:'recover queued jobs instead of interrupted running jobs',file:'repository.js',from:"WHERE status='running'`,",to:"WHERE status='queued'`,",pattern:'cancelled queued jobs'}
];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const originals={};for(const file of ['runtime.js','repository.js']) {originals[file]=await fs.readFile('src/stock-check/'+file,'utf8');}
const report=[];
try {
  await fs.cp('src',path.join(temp,'src'),{recursive:true});
  await fs.writeFile(path.join(temp,'package.json'),'{"type":"module"}');
  await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'));
  const testFile='test/mbt/integration/stock-check-runtime.test.js';
  await fs.mkdir(path.dirname(path.join(temp,testFile)),{recursive:true});await fs.copyFile(testFile,path.join(temp,testFile));
  for(const mutant of definitions) {
    for(const [file,source] of Object.entries(originals)) {await fs.writeFile(path.join(temp,'src/stock-check',file),source);}
    const source=originals[mutant.file];if(!source.includes(mutant.from)) {throw new Error('Runtime mutation target moved: '+mutant.name);}
    await fs.writeFile(path.join(temp,'src/stock-check',mutant.file),source.replace(mutant.from,mutant.to));
    const run=spawnSync(process.execPath,['--test','--test-name-pattern='+mutant.pattern,testFile],{cwd:temp,encoding:'utf8',timeout:30000,killSignal:'SIGKILL'});
    const behavioralFailure=/not ok \d/u.test(run.stdout)&&!/(SyntaxError|ERR_MODULE_NOT_FOUND)/u.test(run.stderr);
    report.push({name:mutant.name,pattern:mutant.pattern,killed:run.status!==0&&behavioralFailure,timedOutAfterAssertion:run.error?.code==='ETIMEDOUT'&&behavioralFailure});
    await fs.writeFile('test-artifacts/stock-check/runtime-mutant-'+(report.length-1)+'.log',run.stdout+run.stderr);
  }
  for(const [file,source] of Object.entries(originals)) {if(hash(await fs.readFile('src/stock-check/'+file))!==hash(source)) {throw new Error('Source changed during runtime mutation testing.');}}
  await fs.writeFile('test-artifacts/stock-check/runtime-mutations.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({mutants:report.length,killed:report.filter(row=>row.killed).length,sourceUnchanged:true}));
  if(report.some(row=>!row.killed)) {process.exitCode=1;}
} finally {await fs.rm(temp,{recursive:true,force:true});}
