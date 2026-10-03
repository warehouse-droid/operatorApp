import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const directory='test-artifacts/boss-approvals';await fs.mkdir(directory,{recursive:true});
const tests=[
 'test/mbt/unit/boss-approval-domain.test.js','test/mbt/unit/boss-approval-service.test.js','test/mbt/unit/boss-approval-refresh-gate.test.js',
 'test/mbt/unit/boss-approval-mail.test.js','test/mbt/unit/boss-approval-runtime.test.js','test/mbt/integration/boss-approvals.test.js',
 'test/mbt/integration/boss-approval-http.test.js','test/mbt/integration/boss-approval-browser.test.js',
 'test/mbt/unit/netsuite-delayed-status-refresh-policy.red.test.js','test/mbt/unit/netsuite-delayed-status-refresh-service.red.test.js',
 'test/mbt/unit/netsuite-delayed-status-refresh-wiring.contract.test.js','test/mbt/property/netsuite-delayed-status-refresh.property.test.js',
 'test/mbt/integration/netsuite-delayed-status-refresh-repository.red.test.js','test/mbt/integration/authority-roles.test.js'
];
const files=(await fs.readdir('src')).filter(file=>file.startsWith('boss-approval-')||file==='account-email.js').map(file=>'src/'+file);
const scripts=['public/boss.js','public/boss-admin.js','src/server.js','src/netsuite.js','src/auth-repository.js','src/netsuite-delayed-status-refresh-service.js','public/control.js','public/app-sidebar.js','public/login.js','public/dispatch-auth.js','public/service-worker.js'];
const manifest={};for(const file of [...files,...scripts,'migrations/261_boss_approvals.sql','package.json','package-lock.json']){manifest[file]=crypto.createHash('sha256').update(await fs.readFile('/workspace/'+file)).digest('hex');}
await fs.writeFile(`${directory}/source-hashes.json`,JSON.stringify(manifest,null,2));
const run=(name,args)=>{
 process.stdout.write(`${name}…\n`);const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:180000});
 requireSuccess(result,name);return result;
};
function requireSuccess(result,name){
 // Save complete output so summary counts and failures can be independently read.
 const data=(result.stdout||'')+(result.stderr||'');
 // Synchronous writes are used only by this evidence runner.
 results.push({name,status:result.status,output:data});
 if(result.status!==0){throw new Error(`${name} failed: ${data.slice(-3500)}`);}
}
const results=[];
try {
 for(const file of [...files,...scripts]){run('syntax '+file,['--check',file]);}
 run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/boss-eslint.config.mjs',...files,'public/boss.js','public/boss-admin.js','test/mbt/**/boss-*.test.js','tools/boss-*.mjs']);
 run('types',['tools/boss-typecheck.mjs']);
 // Measure these changes separately from the repository's global legacy-server
 // threshold; the changed-line report records every unexecuted changed line.
 run('tests',['node_modules/c8/bin/c8.js','--config=tools/boss-c8.json','--all=false','--include=src/boss-approval-*.js','--include=src/account-email.js','--include=src/netsuite-delayed-status-refresh-service.js','--include=src/auth-repository.js','--include=src/netsuite.js','--include=src/server.js',`--report-dir=${directory}/coverage`,'--reporter=json','--reporter=text','node','--test','--test-concurrency=1',...tests]);
 // Deterministic hash order differs from normal ordering, keeping isolated DB
 // suites serial so their test fixtures cannot interfere with one another.
 const shuffled=[...tests].sort((a,b)=>crypto.createHash('sha256').update('20261003'+a).digest('hex').localeCompare(crypto.createHash('sha256').update('20261003'+b).digest('hex')));
 run('shuffled',['--test','--test-concurrency=1',...shuffled]);
 run('mutations',['tools/boss-mutations.mjs']);
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
finally{
 for(const result of results){await fs.writeFile(`${directory}/final-${result.name.replace(/[^a-z0-9]+/gi,'-')}.log`,result.output);}
 await fs.writeFile(`${directory}/gauntlet-results.json`,JSON.stringify(results.map(({name,status})=>({name,status})),null,2));
}
