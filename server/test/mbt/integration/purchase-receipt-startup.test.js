import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';

test('the real application boots with receipt catch-up scheduling and serves health',async()=>{
  const source=`
    import {startServer} from './src/server.js';
    import {config} from './src/config.js';
    config.port=0;
    config.netsuite.directAccessEnabled=false;
    const server=await startServer();
    if(!server.listening) await new Promise(resolve=>server.once('listening',resolve));
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/health');
    if(response.status!==200 || !(await response.json()).ok) process.exit(1);
    console.log('RECEIPT_APPLICATION_BOOT_OK');
    process.exit(0);
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{env:process.env});
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
  const timer=setTimeout(()=>child.kill('SIGTERM'),30_000);
  try {
    const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
    assert.equal(result.code,0,output.slice(-6000));assert.match(output,/RECEIPT_APPLICATION_BOOT_OK/);
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');}
});
