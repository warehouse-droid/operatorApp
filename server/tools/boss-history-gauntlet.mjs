import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tests} from './boss-history-suites.mjs';
const directory='test-artifacts/boss-search-history-20261003';await fs.mkdir(directory,{recursive:true});
const files=JSON.parse(await fs.readFile('tools/boss-history-files.json','utf8')),manifest={};
for(const file of files){manifest[file]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}
await fs.writeFile(`${directory}/source-hashes.json`,JSON.stringify(manifest,null,2));
const results=[];
async function run(name,args){
 process.stdout.write(name+'…\n');const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:240000,maxBuffer:20*1024*1024});
 await fs.writeFile(`${directory}/${name}.log`,(result.stdout||'')+(result.stderr||''));results.push({name,status:result.status});
 if(result.status!==0){throw new Error(name+' failed: '+(result.stdout||'').slice(-2500)+(result.stderr||'').slice(-1500));}
}
try{
 for(const file of files.filter(f=>f.endsWith('.js'))){await run('syntax-'+file.replaceAll('/','-'),['--check',file]);}
 await run('types',['tools/boss-typecheck.mjs']);
 await run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/boss-eslint.config.mjs','src/boss-approval-*.js','public/boss.js','test/mbt/**/boss-*.test.js','tools/boss-history-*.mjs']);
 await run('tests',['node_modules/c8/bin/c8.js','--config=tools/boss-c8.json',`--report-dir=${directory}/coverage`,'--include=src/boss-approval-*.js','--include=src/auth-repository.js','--reporter=json','--reporter=text','node','--test','--test-concurrency=1',...tests]);
 const shuffled=[...tests].sort((a,b)=>crypto.createHash('sha256').update('boss-history-20261003'+a).digest('hex').localeCompare(crypto.createHash('sha256').update('boss-history-20261003'+b).digest('hex')));
 await run('shuffled',['--test','--test-concurrency=1',...shuffled]);
 await run('mutations',['tools/boss-history-mutations.mjs']);
 await run('coverage',['tools/boss-history-coverage.mjs']);
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
finally{await fs.writeFile(`${directory}/gauntlet-results.json`,JSON.stringify(results,null,2));}
