import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
test('the real app startup starts the durable Delivery worker',()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 const result=spawnSync(process.execPath,['tools/regular-stock-delivery-progress-startup.mjs'],{encoding:'utf8',timeout:25000,maxBuffer:2000000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/Delivery startup worker consumed queued work/);
});
