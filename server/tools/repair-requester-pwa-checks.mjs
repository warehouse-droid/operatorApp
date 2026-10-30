import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable Repair runner.');
async function run(args){
 const capture=args.includes('--test'),log=capture?await fs.open('/app/test-artifacts/requester-pwa-focused.log','w'):null,child=spawn(process.execPath,args,{stdio:log?['ignore',log.fd,log.fd]:'inherit',env:process.env});const code=await new Promise(resolve=>child.on('exit',resolve));
 if(log){await log.close();const lines=(await fs.readFile('/app/test-artifacts/requester-pwa-focused.log','utf8')).split('\n'),failures=[];for(let i=0;i<lines.length;i++)if(lines[i].startsWith('not ok '))failures.push(lines.slice(i,i+24).join('\n'));console.log(JSON.stringify({focusedTests:lines.filter(l=>/^# (tests|pass|fail|duration_ms)/u.test(l)),failures}));}
 if(code!==0)throw new Error('Requester PWA checks failed.');
}
await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','tools/repair-requester-pwa-checks.mjs','tools/repair-requester-pwa-mutations.mjs']);
if(process.argv.includes('--focused')||process.argv.includes('--targeted')){
 const files=process.argv.includes('--targeted')?['requester-pwa.test.js','job-flow-browser.test.js','master-directory.test.js','portal.test.js'].map(f=>'test/repair/'+f):(await fs.readdir('test/repair')).filter(f=>f.endsWith('.test.js')).map(f=>'test/repair/'+f);await run(['--test','--test-concurrency=1',...files]);
 await run(['node_modules/eslint/bin/eslint.js','--config','eslint.repair.config.js','--max-warnings=0','src/repair','public/repair','test/repair']);
 await run(['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/repair/domain.js']);
}else await import('./repair-office-purchases-checks.mjs');
await run(['tools/repair-requester-pwa-mutations.mjs']);
