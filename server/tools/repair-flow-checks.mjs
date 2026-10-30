import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the disposable Repair runner.');
await import('./repair-office-checks.mjs');
if(process.exitCode)throw new Error('Shared-shell regressions failed.');
await import('./repair-flow-coverage.mjs');
const child=spawn(process.execPath,['tools/repair-flow-mutations.mjs'],{stdio:'inherit',env:process.env});
const code=await new Promise(resolve=>child.on('exit',resolve));
if(code!==0)throw new Error('Repair flow mutations failed.');
