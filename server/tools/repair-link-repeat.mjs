import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable runner.');
for(let run=1;run<=3;run++){const child=spawn(process.execPath,['--test','test/repair/assignment-receipt.test.js'],{stdio:'inherit',env:process.env});const code=await new Promise(resolve=>child.on('exit',resolve));if(code)throw new Error('Customer link reproduction failed at run '+run);console.log('Customer link repeat '+run+' passed.');}
