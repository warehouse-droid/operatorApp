import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {query,closeDb} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/delivery-instruction-netsuite',temp=await mkdtemp(join(tmpdir(),'di-baseline-'));
try{
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)VALUES('di-baseline','di-baseline','Baseline test','harness','harness','admin',ARRAY['admin'],true) ON CONFLICT DO NOTHING");
 await closeDb();
 for(const dir of ['src','public','package.json'])await cp(dir,join(temp,dir),{recursive:true});
 await symlink('/app/node_modules',join(temp,'node_modules'),'dir');
 for(const file of JSON.parse(await readFile('tools/delivery-instruction-netsuite-files.json','utf8'))){
  const before=out+'/before/'+file;if(existsSync(before))await cp(before,join(temp,file));else await rm(join(temp,file),{force:true});
 }
 const results=[];
 for(const[file,message]of [['src/driver-photo-integrity-harness.js','The recovery shell must use a new cache generation.'],['src/sync-shape-harness.js','Receiving did not use the fixed PO receipt baseline.']]){
  const result=spawnSync(process.execPath,[file],{cwd:temp,encoding:'utf8',maxBuffer:5_000_000});
  await writeFile(`${out}/baseline-${file.split('/').pop()}.log`,result.stdout+result.stderr);
  assert.equal(result.status,1);assert((result.stdout+result.stderr).includes(message));results.push({file,exitCode:result.status,message});
 }
 await writeFile(`${out}/baseline-neighbors.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await rm(temp,{recursive:true,force:true});}
