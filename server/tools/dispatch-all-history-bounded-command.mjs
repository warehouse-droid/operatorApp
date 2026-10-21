import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const [command,...args] = process.argv.slice(2);
assert.ok(command);
const watchdog = spawn(process.execPath,['tools/dispatch-all-history-test-watchdog.mjs','120'],{stdio: 'inherit'});
const child = spawn(command,args,{stdio: 'inherit',env: process.env});
child.once('error',error => { watchdog.kill(); throw error; });
child.once('exit',(code,signal) => {
  watchdog.kill();
  if (signal) { console.error(`Isolated command exited on ${signal}`); }
  process.exitCode = signal ? 1 : code ?? 1;
});
