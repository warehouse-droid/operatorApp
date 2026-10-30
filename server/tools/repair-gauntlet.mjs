import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use docker/run-repair-tests.sh');
const directory='/app/test-artifacts/repair-gauntlet';await fs.mkdir(directory,{recursive:true});
const versions={};for(const name of ['eslint','typescript','c8','fast-check','playwright'])versions[name]=JSON.parse(await fs.readFile(`node_modules/${name}/package.json`,'utf8')).version;console.log(JSON.stringify({toolVersions:versions}));
const files=(await fs.readdir('test/repair')).filter(f=>f.endsWith('.test.js')).map(f=>`test/repair/${f}`);
async function resetRepairFixtures(){const {default:pg}=await import('pg');const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();try{await client.query('TRUNCATE repair_commands,repair_notifications,repair_vehicles,repair_parts,repair_purchases CASCADE');}finally{await client.end();}}
async function run(name,command,args,{expectedFailure=false,baselineFailures=[],timeout=240000,cwd=process.cwd()}={}){
 const logPath=path.join(directory,name+'.log');const handle=await fs.open(logPath,'w');
 const child=spawn(command,args,{cwd,env:process.env,stdio:['ignore',handle.fd,handle.fd],timeout});const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await handle.close();const output=await fs.readFile(logPath,'utf8');
 const lines=output.split('\n');const failures=[];for(let i=0;i<lines.length;i++)if(!lines[i].startsWith('#')&&/^not ok|^✖|error TS|^.+ error |^.+ warning /.test(lines[i]))failures.push(lines.slice(i,i+22).join('\n'));
 const actualFailures=lines.filter(line=>line.startsWith('not ok ')).map(line=>line.replace(/^not ok \d+ - /u,''));
 const acceptedBaseline=result.code===1&&baselineFailures.length>0&&JSON.stringify(actualFailures.sort())===JSON.stringify([...baselineFailures].sort());
 console.log(JSON.stringify({name,...result,...expectedFailure?{mutantKilled:result.code!==0&&!result.signal}:{},...acceptedBaseline?{knownBaselineFailures:actualFailures}:{},summary:lines.filter(l=>/^# (tests|pass|fail|duration_ms)|^ℹ (tests|pass|fail)|All files|^Statements|^Branches|^Lines|^Functions|^Isolated /.test(l)),failures:result.code&&!expectedFailure&&!acceptedBaseline?failures.slice(0,15):[]}));
 if(result.signal||!acceptedBaseline&&((result.code===0)===expectedFailure))throw new Error(`${name} did not meet its expected result.`);return output;
}
const sourceFiles=[...(await fs.readdir('src/repair')).map(f=>`src/repair/${f}`),...(await fs.readdir('public/repair')).map(f=>`public/repair/${f}`),'migrations/310_repair.sql','migrations/313_repair_equipment_masters.sql','migrations/316_repair_local_purchase_orders.sql','migrations/317_repair_quote_scopes.sql','migrations/318_repair_work_jobs.sql','migrations/320_repair_unscoped_parts.sql'];
const digest=createHash('sha256');for(const file of sourceFiles.sort())digest.update(file).update(await fs.readFile(file));console.log(JSON.stringify({sourceHash:digest.digest('hex'),node:process.version}));
const integrationFiles=['src/auth-repository.js','src/config.js','src/server.js','src/netsuite.js','src/dispatch-plan-repository.js','src/driver-repository.js','src/photo-upload.js','src/photo-archive-repository.js','public/mbr/domain.js','public/staff-login-routes.js','public/login.js','public/control.js','public/app-sidebar.js','public/operator.js','public/operator.html','public/service-worker.js','public/driver.js','public/driver.html','public/driver-service-worker.js'];
const integrationDigest=createHash('sha256');for(const file of integrationFiles.sort())integrationDigest.update(file).update(await fs.readFile(file));console.log(JSON.stringify({integrationHash:integrationDigest.digest('hex'),integrationFiles}));
await run('tests','node',['--test','--test-concurrency=1',...files]);
await run('lint','node',['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','src/repair','public/repair','test/repair','tools/repair-gauntlet.mjs','tools/repair-checks.mjs','tools/repair-flow-checks.mjs','tools/repair-flow-mutations.mjs','tools/repair-flow-coverage.mjs']);
await run('types','node',['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/repair/domain.js']);
await resetRepairFixtures();
await run('coverage','node',['node_modules/c8/bin/c8.js','--all=false','--include=src/repair/**/*.js','--include=public/repair/domain.js',`--temp-directory=${directory}/c8`,`--report-dir=${directory}/coverage`,'--reporter=text','--reporter=json-summary','--reporter=json','--check-coverage=false','node','--test','--test-concurrency=1',...files]);
await import('./repair-flow-coverage.mjs');
const mutants=[['credit','const creditMinor=approved.length?feeMinor:0;','const creditMinor=0;'],['yard','&&(actor.yardLocationIds||[]).map(Number).includes(Number(job.yardId))',''],['receipt',"job.receipt==='accepted'&&job.outcome==='repaired'","job.receipt==='accepted'"],['rounding','+500n','+0n']];
const original=await fs.readFile('public/repair/domain.js','utf8');
for(const [name,before,after] of mutants){if(!original.includes(before))throw new Error(`Mutant ${name} anchor changed`);const root=path.join(directory,'mutants',name);await fs.mkdir(path.join(root,'public/repair'),{recursive:true});await fs.mkdir(path.join(root,'test/repair'),{recursive:true});await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');await fs.symlink('/app/node_modules',path.join(root,'node_modules'));await fs.writeFile(path.join(root,'public/repair/domain.js'),original.replace(before,after));await fs.copyFile('test/repair/domain.test.js',path.join(root,'test/repair/domain.test.js'));await run('mutant-'+name,'node',['--test','test/repair/domain.test.js'],{cwd:root,expectedFailure:true});
 if(['credit','rounding'].includes(name))await run('property-mutant-'+name,'node',['--test','--test-name-pattern=propert','test/repair/domain.test.js'],{cwd:root,expectedFailure:true});
}
await resetRepairFixtures();
await run('shuffle','node',['--test','--test-concurrency=1',...files.toReversed()]);
console.log(JSON.stringify({teamMutationChecks:JSON.parse(await run('team-workbench-mutations','node',['tools/repair-team-mutations.mjs']))}));
const migration=await fs.readFile('migrations/310_repair.sql','utf8'),constraint="CHECK(role IN ('operator'",mutated=path.join(directory,'migration-mutant.sql');
if(!migration.includes(constraint))throw new Error('Migration authority mutant anchor changed');
await fs.writeFile(mutated,migration.replace(constraint,"CHECK(role IN ('unknown_authority','operator'").replace('AND role=ANY(roles)',''));
await run('mutant-migration-authority','env',[`REPAIR_MIGRATION_FILE=${mutated}`,'node','--test','test/repair/migration.test.js'],{expectedFailure:true});
await run('affected-regression','node',['tools/repair-regression.mjs']);
await run('legacy-asset-contract','node',['--test','test/mbt/unit/driver-plan-date-execution-wiring.contract.test.js'],{baselineFailures:['S11: the guarded client ships in a new atomic Driver shell generation']});
await run('server-syntax','node',['--check','src/server.js']);
await run('secrets','node',['test/support/scan-diff-secrets.mjs','src/repair','public/repair','test/repair','migrations/310_repair.sql','tools/repair-gauntlet.mjs','tools/repair-regression.mjs','tools/repair-checks.mjs','--unified-diff','/app/test-artifacts/repair-integration.diff']);
console.log('Repair gauntlet complete. Disposable artifacts are removed by the outer runner.');
