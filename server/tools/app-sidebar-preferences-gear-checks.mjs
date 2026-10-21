import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Bounded disposable infrastructure is required.');}
mkdirSync('test-artifacts',{recursive:true});
const syntax=spawnSync(process.execPath,['--check','public/app-sidebar.js'],{encoding:'utf8'});
if(syntax.status!==0) {process.stdout.write(syntax.stdout+syntax.stderr);process.exit(syntax.status || 1);}
const lint=spawnSync('node_modules/.bin/eslint',['--config','tools/app-notification-attention-eslint.config.mjs','--max-warnings=0',
  'test/mbt/integration/app-notification-preferences-browser.test.js','tools/app-sidebar-preferences-gear-checks.mjs'],{encoding:'utf8'});
writeFileSync('test-artifacts/lint.log',lint.stdout+lint.stderr);
if(lint.status!==0) {process.stdout.write(lint.stdout+lint.stderr);process.exit(lint.status || 1);}
process.argv[2]='green';await import('./app-notification-preferences-checks.mjs');
