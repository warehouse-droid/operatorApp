import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Regression checks require isolated test infrastructure.');}
const phase=process.env.DELIVERY_TEST_PHASE || 'final';
const watchdog=spawn(process.execPath,['tools/delivery-request-watchdog.cjs','120000',`test-artifacts/delivery-requests/${phase}-timeouts.log`],{stdio:'inherit'});
try {
  const child=spawn('npm',['run','test:mbt'],{stdio:'inherit'});
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:(code ?? 1)));});
} finally {watchdog.kill('SIGTERM');}
