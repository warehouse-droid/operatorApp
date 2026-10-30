import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable Repair runner.');
async function run(args){const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});const code=await new Promise(resolve=>child.on('exit',resolve));if(code!==0)throw new Error('Whole-quote / parts receiving check failed.');}
await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','tools/repair-whole-quote-checks.mjs','tools/repair-whole-quote-mutations.mjs','tools/repair-whole-quote-correction.mjs','tools/repair-mutation-baseline.mjs','tools/repair-team-mutations.mjs','tools/repair-flow-mutations.mjs','tools/repair-requester-mutations.mjs','tools/repair-office-purchases-mutations.mjs','tools/repair-requester-pwa-mutations.mjs','tools/repair-control-po-mutations.mjs']);
if(process.argv.includes('--targeted')||process.argv.includes('--mutations-only')){
 if(!process.argv.includes('--mutations-only'))await run(['--test','--test-concurrency=1',...['whole-quote-receiving','control-po','domain','repository','quote-scopes','browser','team-workbench'].map(n=>'test/repair/'+n+'.test.js')]);
 await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','src/repair','public/repair','test/repair','tools/repair-whole-quote-checks.mjs','tools/repair-whole-quote-mutations.mjs']);
 await run(['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/repair/domain.js']);
}else await import('./repair-control-po-checks.mjs');
await run(['tools/repair-whole-quote-mutations.mjs']);
