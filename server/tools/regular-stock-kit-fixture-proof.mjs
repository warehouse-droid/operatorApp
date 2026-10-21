import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {query,closeDb} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
try{
 await query("INSERT INTO inventory_items(item_id,item_name) VALUES(9800000000000,'EXISTING BIGINT TEST FIXTURE')");
 const result=spawnSync(process.execPath,['src/smart-scm-vendor-alternative-harness.js'],{encoding:'utf8'});
 const output=result.stdout+result.stderr;
 assert.equal(result.status,1);assert.match(output,/is out of range for type integer/);assert.match(output,/code: '22003'/);
 await writeFile('test-artifacts/fixture-proof.log',output);
 const sourceHash=createHash('sha256').update(await readFile('src/smart-scm-vendor-alternative-harness.js')).digest('hex');
 const proof={preExisting:true,sourceHash,rawHarnessExitCode:result.status,postgresError:'22003',
  cause:'Original harness infers a 32-bit parameter for bigint inventory fixture IDs through integer generate_series addition'};
 await writeFile('test-artifacts/fixture-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}finally{await closeDb();}
