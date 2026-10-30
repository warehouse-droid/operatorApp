import {spawn} from 'node:child_process';
await import('./repair-flow-checks.mjs');
const child=spawn(process.execPath,['tools/repair-requester-mutations.mjs'],{stdio:'inherit',env:process.env});
if(await new Promise(resolve=>child.on('exit',resolve))!==0)throw new Error('Requester/receipt mutation checks failed.');
