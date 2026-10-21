import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'mbbs-special-review-db');
url.pathname='/postgres';const admin=new pg.Client({connectionString:url.toString()});await admin.connect();
const output='test-artifacts/special-workflow-review/native-documents';
const directory=mkdtempSync('/app/.native-baseline-');
const results=[];
try {
  for(const path of ['src','public','test','package.json'])cpSync(path,`${directory}/${path}`,{recursive:true});
  symlinkSync(resolve('node_modules'),`${directory}/node_modules`,'dir');
  cpSync(`${output}/baseline`,directory,{recursive:true});
  for(const mode of ['baseline','current']){
    const name=`mbt_native_${mode}_${Date.now()}`;await admin.query(`CREATE DATABASE ${name} TEMPLATE mbt_test`);
    url.pathname=`/${name}`;
    try {
      const client=new pg.Client({connectionString:url.toString()});await client.connect();
      try{for(const file of readdirSync('migrations').filter(f=>/^\d+.*\.sql$/.test(f)&&Number(f.slice(0,3))>225).sort())await client.query(readFileSync(`migrations/${file}`,'utf8'));}finally{await client.end();}
      const args=['--test','--test-concurrency=1','test/dispatch/integration/dispatch-v2-command-flow.red.test.js'];
      const result=spawnSync(process.execPath,args,{cwd:mode==='baseline'?directory:process.cwd(),env:{...process.env,DATABASE_URL:url.toString()},encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024});
      const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${output}/${mode}-v2.txt`,log);
      results.push({mode,exit:result.status,failures:[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]),tests:Number(/^# tests (\d+)$/m.exec(log)?.[1])});
    }finally{await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);}
  }
  assert.equal(readFileSync(`${directory}/src/dispatch-planner-v2-repository.js`,'utf8'),readFileSync(`${output}/baseline/src/dispatch-planner-v2-repository.js`,'utf8'));
  assert.deepEqual(results[1].failures,results[0].failures,'No new Dispatch V2 failures');
  for(const mode of ['baseline','current']){
    const log=readFileSync(`${output}/${mode}-v2.txt`,'utf8');
    assert.match(log,/Current Dispatch order visibility must remain unchanged outside History Edit Mode/);
    assert.match(log,/A one-order CO change must not return the 609-order feed/);
  }
  assert.equal(results[0].failures.length,2);
  writeFileSync(`${output}/baseline-comparison.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{rmSync(directory,{recursive:true,force:true});await admin.end();}
