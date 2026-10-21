import {readdirSync,readFileSync,appendFileSync} from 'node:fs';
import {uptime} from 'node:os';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const ticks=Number(spawnSync('getconf',['CLK_TCK'],{encoding:'utf8'}).stdout);
assert.ok(ticks>0);
const log='/tmp/count-sheet-refresh-test-timeouts.jsonl';
function processes() {
  return readdirSync('/proc').filter(name=>/^\d+$/.test(name)).flatMap(name=>{
    try {
      const stat=readFileSync(`/proc/${name}/stat`,'utf8').split(') ')[1].split(' ');
      return [{pid:Number(name),parent:Number(stat[1]),age:uptime()-Number(stat[19])/ticks,args:readFileSync(`/proc/${name}/cmdline`,'utf8').split('\0')}];
    } catch {return [];}
  });
}
function terminate(pid,rows) {
  for(const child of rows.filter(row=>row.parent===pid)) {terminate(child.pid,rows);}
  try {process.kill(pid,'SIGKILL');} catch { /* Already finished. */ }
}
setInterval(()=>{
  const rows=processes();
  for(const row of rows.filter(entry=>entry.args.includes('--test-reporter=spec') && entry.args.includes('--test-concurrency=1') && entry.age>120)) {
    const record={file:row.args.find(arg=>arg.startsWith('/app/test/')),seconds:Math.round(row.age),reason:'Test file exceeded 120 seconds; recorded as a failure, not skipped.'};
    appendFileSync(log,JSON.stringify(record)+'\n');console.log(JSON.stringify(record));terminate(row.pid,rows);
  }
},2000);
