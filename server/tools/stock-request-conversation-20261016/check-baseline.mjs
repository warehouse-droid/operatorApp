import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../src/db.js';
const url=new URL(process.env.DATABASE_URL);url.pathname='/mbt_verify';
try {
 await query('CREATE DATABASE mbt_verify TEMPLATE mbt_test');
 const result=spawnSync(process.execPath,['--test','test/mbt/integration/special-stock-updates.test.js'],{env:{...process.env,DATABASE_URL:url.href},encoding:'utf8'});
 const log=result.stdout+result.stderr;writeFileSync('test-artifacts/stock-request-conversation-20261016/baseline-special-information.log',log);
 assert.equal(result.status,1);assert.match(log,/# pass 2\n# fail 1/);assert.match(log,/not ok 3 - Accepted Low inventory/);assert.match(log,/actual: 'confirmed'/);assert.match(log,/expected: 'dispatch_arrangement'/);
 console.log('Baseline reproduced: 2 passed, 1 pre-existing Low inventory stage expectation failure.');
}finally{await query('DROP DATABASE IF EXISTS mbt_verify WITH (FORCE)');await closeDb();}
