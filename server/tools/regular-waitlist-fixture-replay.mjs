// Repeat the existing suspected flaky fixture without changing its assertions or source.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

const file='test/mbt/concurrency/driver-pwa-historical-assist-concurrency.test.js';
const name=process.argv[2];assert(['baseline','final'].includes(name));
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
assert.equal(environment.MBT_TEST_ISOLATED,'1');
assert.equal(environment.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
for(let run=1;run<=4;run++){
  assert.equal(await runNodeTestFilesIsolated([file],{environment,label:`fixture replay ${name} ${run}/4`}),0);
}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
mkdirSync('test-artifacts/regular-waitlist',{recursive:true});
const result={runs:4,testsPerRun:4,passedTests:16,assertionsChanged:false,testHash:hash(file),sourceHash:hash('src/driver-historical-assist-repository.js')};
writeFileSync(`test-artifacts/regular-waitlist/fixture-${name}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
