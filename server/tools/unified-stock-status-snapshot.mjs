import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,symlinkSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const root=mkdtempSync('/tmp/unified-status-snapshot-'),files=process.argv.slice(2);
const branches=new Set(['src','public','test','test/mbt','test/mbt/integration']);
try{
  for(const folder of ['',...branches]){
    mkdirSync(`${root}/${folder}`,{recursive:true});
    for(const entry of readdirSync(`/app/${folder}`)){
      const relative=folder?`${folder}/${entry}`:entry;
      if(branches.has(relative))continue;
      const snapshot=`/app/test-artifacts/unified-stock-status/before/${relative}`;
      if(/^(src|public)\//.test(relative)&&existsSync(snapshot))copyFileSync(snapshot,`${root}/${relative}`);
      else if(files.includes(relative))copyFileSync(`/app/${relative}`,`${root}/${relative}`);
      else symlinkSync(`/app/${relative}`,`${root}/${relative}`);
    }
  }
  const result=spawnSync(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','--test','--test-concurrency=1',...files],{
    cwd:root,env:{...process.env,NODE_V8_COVERAGE:''},encoding:'utf8',maxBuffer:24*1024*1024,timeout:180000});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status??1;
}finally{rmSync(root,{recursive:true,force:true});}
