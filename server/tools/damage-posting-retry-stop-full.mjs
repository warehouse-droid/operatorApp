// Stop only this isolated runner's in-progress full suite for a fresh source run.
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
const rows=readdirSync('/proc').filter(name=>/^\d+$/.test(name)).flatMap(name=>{
  try {const stat=readFileSync(`/proc/${name}/stat`,'utf8').replace(/^\d+ \(.*\) /,'').split(' ');
    return [{pid:Number(name),parent:Number(stat[1]),args:readFileSync(`/proc/${name}/cmdline`,'utf8').split('\0')}];}catch{return [];}
});
const roots=rows.filter(row=>row.args.some(arg=>arg==='test/support/run-node-tests.mjs'||arg.endsWith('/run-node-tests.mjs')));
const stopped=[];
function stop(pid) {for(const row of rows.filter(row=>row.parent===pid))stop(row.pid);try{process.kill(pid,'SIGTERM');stopped.push(pid);}catch{}}
for(const root of roots)stop(root.pid);
console.log(JSON.stringify({isolatedFullSuiteOnly:true,roots:roots.map(row=>row.pid),stopped:stopped.length}));
