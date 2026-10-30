import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable runner.');
async function run(args){const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});if(await new Promise(resolve=>child.on('exit',resolve))!==0)throw new Error('Quote approval policy checks failed.');}
await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','tools/repair-quote-policy-checks.mjs','tools/repair-quote-policy-mutations.mjs']);
if(process.argv.includes('--targeted')){await run(['--test','--test-concurrency=1','test/repair/quote-auto-approval.test.js']);await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','src/repair','public/repair','test/repair/quote-auto-approval.test.js']);}
else if(!process.argv.includes('--mutations-only'))await import('./repair-manual-checks.mjs');
await run(['tools/repair-quote-policy-mutations.mjs']);
