import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const files=[
 'test/dispatch/integration/sor-admin-http.test.js',
 'test/dispatch/integration/sor-feature-gate.test.js',
 'test/dispatch/integration/sor-return-lock.test.js',
 'test/dispatch/integration/sor-return-lifecycle.test.js',
 'test/dispatch/integration/sor-rental-repository.test.js',
 'test/dispatch/integration/sor-rental-concurrency.test.js',
 'test/dispatch/integration/sor-signature-evidence.test.js',
 'test/dispatch/unit/sor-rental-policy.test.js',
 'test/mbt/unit/feature-gate-catalog.test.js',
 'test/mbt/unit/driver-instruction-route-comparison.test.js',
 'test/mbt/unit/driver-pwa-recovery-assets.test.js'
];
const result=spawnSync('node_modules/.bin/c8',['--all','--check-coverage=false',
 '--include=src/sor-feature-gate.js','--include=src/sor-rental-service.js',
 '--temp-directory=/tmp/sor-gate-coverage','--report-dir=test-artifacts/sor-rentals/gate-coverage',
 '--reporter=json','--reporter=json-summary','--reporter=text',
 'node','--test','--test-concurrency=1',...files],{stdio:'inherit'});
process.exitCode=result.status??1;
const sourceHashes=Object.fromEntries(['src/sor-rental-service.js','src/sor-feature-gate.js','src/netsuite.js'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync('test-artifacts/sor-rentals/gate-focused.json',JSON.stringify({passed:result.status===0,sourceHashes,tests:files},null,2));
