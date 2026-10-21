import {cpSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Disposable infrastructure is required.');}
const root=mkdtempSync('/tmp/mbbs-attention-mutation-');
const testFile='test/mbt/integration/app-notification-attention-browser.test.js';
const target='public/app-notifications.js';
const mutants=[
  ['sound repeats for the same event across tabs',
    "if(!soundEnabled() || soundSeen.has(key) || receipts(soundSeenKey())[key]) {return;}",
    "if(!soundEnabled()) {return;}"],
  ['badges clear while MBBS is visible but unfocused',
    "!document.hidden && document.hasFocus()", "!document.hidden"],
  ['the OS plays another sound after the Operator ding or while muted',
    "return !soundPreferred() || soundSeen.has(key) || Boolean(receipts(soundSeenKey())[key]);", "return false;"]
];
const report=[];
try {
  for(const file of [testFile,target,'public/app-alert-sound.js','public/app-sidebar.js','public/staff-manifest.webmanifest',
    'public/manifest.webmanifest','public/driver-manifest.webmanifest','package.json']) {
    const destination=path.join(root,file);mkdirSync(path.dirname(destination),{recursive:true});cpSync(file,destination);
  }
  symlinkSync(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');
  const original=readFileSync(path.join(root,target),'utf8');
  for(const [index,[name,before,after]] of mutants.entries()) {
    if(original.split(before).length!==2) {throw new Error('Mutation anchor is ambiguous: '+name);}
    writeFileSync(path.join(root,target),original.replace(before,after));
    const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',testFile],{
      cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,DELIVERY_UI_COVERAGE:'0'}
    });
    writeFileSync(`test-artifacts/mutation-${index+1}.log`,result.stdout+result.stderr);
    writeFileSync(path.join(root,target),original);
    const failingTests=[...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
    const row={name,killed:result.status===1 && failingTests.length>0,restored:readFileSync(path.join(root,target),'utf8')===original,exitCode:result.status,failingTests};
    report.push(row);process.stdout.write(JSON.stringify(row)+'\n');
  }
  writeFileSync('test-artifacts/mutations.json',JSON.stringify(report,null,2)+'\n');
  process.exitCode=report.every(row=>row.killed && row.restored)?0:1;
} finally {rmSync(root,{recursive:true,force:true});}
