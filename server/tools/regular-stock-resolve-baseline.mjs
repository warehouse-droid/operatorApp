import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {regularTests} from './regular-stock-v2-suites.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out='test-artifacts/regular-stock-resolve-20261002';
const tests=[...regularTests.filter(file=>!file.includes('regular-stock-resolution')),
  'test/mbt/unit/stock-request-ui-contract.test.js','test/mbt/integration/stock-request-repository.test.js'];
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests],{encoding:'utf8',timeout:300000,maxBuffer:40000000});
assert.ok([0,1].includes(result.status),result.stderr);
const log=result.stdout+result.stderr;writeFileSync(out+'/baseline-tests.log',log);
const counts=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
const failures=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const files=JSON.parse(readFileSync('tools/regular-stock-resolve-files.json'));
writeFileSync(out+'/baseline.json',JSON.stringify({counts,failures,tests,sourceHashes:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))},null,2));
console.log(JSON.stringify({baselineCompleted:true,...counts,failures}));
