import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

test('real application bootstrap starts with the hourly worker and serves healthy assets',async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
 const preload='data:text/javascript,'+encodeURIComponent('import {takeCoverage} from "node:v8";process.on("SIGTERM",()=>{takeCoverage();process.exit(0);});');
 const child=spawn(process.execPath,['--import',preload,'src/server.js'],{env:{...process.env,PORT:'31976',APP_BASE_URL:'http://127.0.0.1:31976'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output=(output+chunk).slice(-5000);});child.stderr.on('data',chunk=>{output=(output+chunk).slice(-5000);});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try {
  let health;for(let i=0;i<100;i++){
   if(child.exitCode!==null)break;
   try{health=await fetch('http://127.0.0.1:31976/health');if(health.ok)break;}catch{}
   await delay(200);
  }
  assert.equal(health?.status,200,output);assert.equal((await health.json()).ok,true);
  const ui=await fetch('http://127.0.0.1:31976/regular-stock-ui.js');assert.equal(ui.status,200);assert.match(await ui.text(),/salesOrderProgress/);
 } finally {child.kill('SIGTERM');await exited;}
});
