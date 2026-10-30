import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the disposable Repair runner.');
async function run(args){const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});if(await new Promise(resolve=>child.on('exit',resolve))!==0)throw new Error('Office purchase checks failed.');}
await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','tools/repair-office-purchases-checks.mjs','tools/repair-office-purchases-mutations.mjs']);
if(process.argv.includes('--focused')){
 await run(['--test','--test-concurrency=1','test/repair/office-purchase-flow.test.js','test/repair/office-purchase-browser.test.js']);
 await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','src/repair','public/repair','test/repair']);
 await run(['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/repair/domain.js']);
}else await import('./repair-requester-checks.mjs');
await run(['tools/repair-office-purchases-mutations.mjs']);
