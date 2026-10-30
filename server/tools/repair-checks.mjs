import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
if(process.env.MBT_TEST_ISOLATED!=='1') throw new Error('Use docker/run-isolated-tests.sh');
const directory='/app/test-artifacts/repair';fs.mkdirSync(directory,{recursive:true});
async function run(label,command,args){
 const logfile=path.join(directory,label+'.log');const log=fs.createWriteStream(logfile);
 const child=spawn(command,args,{env:process.env,stdio:['ignore','pipe','pipe'],timeout:180000});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 const code=await new Promise(resolve=>child.on('exit',resolve));await new Promise(resolve=>log.end(resolve));
 const output=fs.readFileSync(logfile,'utf8');
 const summary=output.split('\n').filter(line=>/^# (tests|pass|fail|skipped|duration_ms)|^not ok|error TS|error:|^✖|^ℹ (tests|pass|fail)|^FAIL|^PASS .*file|^ERROR/.test(line));
 console.log(JSON.stringify({label,code,summary:summary.slice(-130)}));
 if(code && !['baseline','red'].includes(label)) process.exitCode=1;
 return code;
}
const mode=process.argv[2]||'domain';
if(mode==='baseline') await run('baseline','npm',['test']);
else await run(mode==='red'?'red':'repair','node',['--test','--test-concurrency=1',...(process.argv.slice(3).length?process.argv.slice(3):['test/repair/domain.test.js'])]);
