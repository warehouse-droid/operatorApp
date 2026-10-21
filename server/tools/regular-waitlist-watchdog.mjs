import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readlinkSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
const pid=Number(process.argv[2]),label=process.argv[3];
assert(Number.isSafeInteger(pid)&&pid>1);assert(/^(final|baseline)-full$/.test(label));
const cwd=readlinkSync('/proc/'+pid+'/cwd');assert(cwd.endsWith(label==='final-full'?'-final':'-baseline'));
const timeouts=[];
console.log(JSON.stringify({watching:pid,label,maxExistingFileSeconds:120}));
for(;;){
  const rows=execFileSync('ps',['-eo','pid,ppid,etimes,args'],{encoding:'utf8'}).split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);return m?[{pid:Number(m[1]),parent:Number(m[2]),seconds:Number(m[3]),args:m[4]}]:[];});
  if(!rows.some(row=>row.pid===pid))break;
  for(const child of rows.filter(row=>row.parent===pid&&row.args.includes('--test-reporter=spec')&&row.seconds>=120)){
    const file=child.args.match(/test\/mbt\/[^\s]+\.test\.(?:js|mjs)/)?.[0];assert(file,'Only isolated test files can be stopped');
    const descendantIds=new Set([child.pid]);let size;
    do{size=descendantIds.size;for(const row of rows)if(descendantIds.has(row.parent))descendantIds.add(row.pid);}while(descendantIds.size>size);
    const entry={file,elapsedSeconds:child.seconds,reason:'Existing test exceeded the external 120-second execution limit',at:new Date().toISOString()};
    timeouts.push(entry);writeFileSync('test-artifacts/regular-waitlist/'+label+'-timeouts.json',JSON.stringify(timeouts,null,2));console.log(JSON.stringify(entry));
    for(const id of [...descendantIds].reverse()){try{process.kill(id,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}
    await delay(500);
    for(const id of [...descendantIds].reverse()){try{process.kill(id,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
  }
  await delay(5000);
}
writeFileSync('test-artifacts/regular-waitlist/'+label+'-timeouts.json',JSON.stringify(timeouts,null,2));
