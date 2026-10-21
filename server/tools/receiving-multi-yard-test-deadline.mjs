// Bound pre-existing test-file hangs without changing any assertions or skipping tests.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original=childProcess.spawn;
childProcess.spawn=function(...args) {
  const child=original.apply(this,args);
  if(args[0]===process.execPath && args[1]?.includes('--test')) {
    const deadline=setTimeout(()=>{
      process.stderr.write(`TEST_FILE_DEADLINE ${args[1].at(-1)}\n`);
      child.kill('SIGTERM');
    },120000);
    deadline.unref();
    child.once('exit',()=>clearTimeout(deadline));
  }
  return child;
};
syncBuiltinESMExports();
