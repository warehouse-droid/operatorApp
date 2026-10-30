import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable Repair runner.');
async function run(args){const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});const code=await new Promise(resolve=>child.on('exit',resolve));if(code!==0)throw new Error('Manual repair flow check failed.');}
await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','tools/repair-manual-checks.mjs','tools/repair-manual-mutations.mjs']);
if(process.argv.includes('--targeted')){
 await run(['--test','--test-concurrency=1',...['manual-flow','manual-netsuite','manual-browser','pdf-layout'].map(name=>`test/repair/${name}.test.js`)]);
 await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','src/repair','public/repair','test/repair','tools/repair-manual-checks.mjs','tools/repair-manual-mutations.mjs']);
}else if(!process.argv.includes('--mutations-only')){await run(['tools/repair-whole-quote-mutations.mjs','stale-rejected-selection']);await import('./repair-whole-quote-checks.mjs');}
await run(['tools/repair-manual-mutations.mjs']);
