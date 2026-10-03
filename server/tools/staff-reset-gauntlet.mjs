import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tests} from './staff-reset-suites.mjs';
const directory='test-artifacts/staff-login-reset-20261003';await fs.mkdir(directory,{recursive:true});
const files=JSON.parse(await fs.readFile('tools/staff-reset-files.json','utf8')),manifest={};
for(const file of files){manifest[file]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}
await fs.writeFile(`${directory}/source-hashes.json`,JSON.stringify(manifest,null,2));
const results=[];
async function run(name,args){
 process.stdout.write(name+'…\n');const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:240000});
 await fs.writeFile(`${directory}/${name}.log`,(result.stdout||'')+(result.stderr||''));results.push({name,status:result.status});
 if(result.status!==0){throw new Error(name+' failed: '+(result.stdout||'').slice(-2500)+(result.stderr||'').slice(-1500));}
}
try{
 for(const file of files.filter(f=>f.endsWith('.js'))){await run('syntax-'+file.replaceAll('/','-'),['--check',file]);}
 await run('types',['tools/staff-reset-typecheck.mjs']);await run('boss-types',['tools/boss-typecheck.mjs']);
 await run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/staff-reset-eslint.config.mjs','src/password-reset-*.js','public/login.js','public/staff-login-routes.js','test/mbt/**/password-reset*.test.js','test/mbt/integration/staff-login-browser.test.js','tools/staff-reset-*.mjs']);
 await run('boss-lint',['node_modules/eslint/bin/eslint.js','--config','tools/boss-eslint.config.mjs','src/boss-approval-*.js','public/boss.js','test/mbt/**/boss-*.test.js']);
 await run('tests',['node_modules/c8/bin/c8.js','--config=tools/boss-c8.json',`--report-dir=${directory}/coverage`,'--include=src/password-reset-*.js','--include=src/boss-approval-*.js','--include=src/auth-repository.js','--include=src/server.js','--reporter=json','--reporter=text','node','--test','--test-concurrency=1',...tests]);
 const shuffled=[...tests].sort((a,b)=>crypto.createHash('sha256').update('staff-reset-20261003'+a).digest('hex').localeCompare(crypto.createHash('sha256').update('staff-reset-20261003'+b).digest('hex')));
 await run('shuffled',['--test','--test-concurrency=1',...shuffled]);
 await run('mutations',['tools/staff-reset-mutations.mjs']);
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
finally{await fs.writeFile(`${directory}/gauntlet-results.json`,JSON.stringify(results,null,2));}
