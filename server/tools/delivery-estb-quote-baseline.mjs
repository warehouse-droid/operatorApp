import assert from 'node:assert/strict';
import {cpSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const scratch='/tmp/delivery-estb-quote-baseline';
rmSync(scratch,{recursive:true,force:true});mkdirSync(`${scratch}/src`,{recursive:true});
try {
  cpSync('/baseline/src/netsuite-restlet-harness.js',`${scratch}/src/netsuite-restlet-harness.js`);
  cpSync('/baseline/netsuite-smart-scm-picking-ticket-restlet.js',`${scratch}/netsuite-smart-scm-picking-ticket-restlet.js`);
  cpSync('package.json',`${scratch}/package.json`);
  const result=spawnSync(process.execPath,['src/netsuite-restlet-harness.js'],{cwd:scratch,encoding:'utf8'});
  const log=(result.stdout || '')+(result.stderr || '');
  writeFileSync('test-artifacts/baseline-restlet-harness.log',log);
  assert.notEqual(result.status,0);assert.match(log,/actual: '3\.3\.0'/u);assert.match(log,/expected: '3\.2\.2'/u);
  process.stdout.write('Baseline reproduces stale harness version: expected 3.2.2, source 3.3.0.\n');
} finally {rmSync(scratch,{recursive:true,force:true});}
