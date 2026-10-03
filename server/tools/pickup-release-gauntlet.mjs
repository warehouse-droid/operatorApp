import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tests} from './boss-close-suites.mjs';
const directory='test-artifacts/pickup-release';await fs.mkdir(directory,{recursive:true});
const results=[];
async function run(name,args){
 process.stdout.write(name+'…\n');
 const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:300000,maxBuffer:50*1024*1024});
 await fs.writeFile(directory+'/'+name+'.log',(r.stdout||'')+(r.stderr||''));results.push({name,status:r.status});
 if(r.status!==0){throw Error(name+' failed: '+(r.stdout||'').slice(-2200)+(r.stderr||'').slice(-1200));}
}
try{
 await run('pickup',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false','--include=src/dispatch-pickup-visits.js','--include=src/scm-dependency-plan-reconciler.js','--temp-directory=test-artifacts/pickup-override/c8','--reporter=json','--reports-dir=test-artifacts/pickup-override/coverage','node','tools/pickup-release-check.mjs','all']);
 await run('boss-regression',['--test','--test-concurrency=1',...tests]);
 const shuffled=['test/dispatch/frontend/dispatch-pickup-address-grouping.test.js','test/mbt/unit/scm-dependency-plan-reconciler.red.test.js'].sort((a,b)=>crypto.createHash('sha256').update(a).digest('hex').localeCompare(crypto.createHash('sha256').update(b).digest('hex')));
 await run('pickup-shuffled',['--test','--test-concurrency=1',...shuffled]);
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
finally{await fs.writeFile(directory+'/gauntlet-results.json',JSON.stringify(results,null,2));}
