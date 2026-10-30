import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable Repair runner.');
async function run(args){const test=args.includes('--test'),log=test?await fs.open('/app/test-artifacts/control-po.log','w'):null;const child=spawn(process.execPath,args,{env:process.env,stdio:log?['ignore',log.fd,log.fd]:'inherit'});const code=await new Promise(resolve=>child.on('exit',resolve));if(log){await log.close();const lines=(await fs.readFile('/app/test-artifacts/control-po.log','utf8')).split('\n'),failures=[];for(let i=0;i<lines.length;i++)if(lines[i].startsWith('not ok '))failures.push(lines.slice(i,i+24).join('\n'));console.log(JSON.stringify({controlPoTests:lines.filter(l=>/^# (tests|pass|fail|duration_ms)/u.test(l)),failures}));}if(code!==0)throw new Error('Control approval / Office PO checks failed.');}
await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','tools/repair-control-po-checks.mjs','tools/repair-control-po-mutations.mjs']);
if(process.argv.includes('--targeted')||process.argv.includes('--mutations-only')){
 if(!process.argv.includes('--mutations-only'))await run(['--test','--test-concurrency=1',...['control-po','job-flow-browser','office-purchase-browser','assignment-receipt'].map(n=>'test/repair/'+n+'.test.js')]);
 await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','src/repair','public/repair','test/repair']);
 await run(['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/repair/domain.js']);
}else await import('./repair-requester-pwa-checks.mjs');
await run(['tools/repair-control-po-mutations.mjs']);
