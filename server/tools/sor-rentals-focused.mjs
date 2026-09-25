import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const tests=['test/dispatch/unit/sor-rental-policy.test.js',
 'test/dispatch/integration/sor-rental-repository.test.js','test/dispatch/integration/sor-return-lifecycle.test.js',
 'test/dispatch/integration/sor-rental-concurrency.test.js','test/dispatch/integration/sor-signature-evidence.test.js',
 'test/dispatch/integration/sor-admin-http.test.js','test/mbt/unit/driver-pwa-recovery-assets.test.js'];
const seed=Number(process.env.SOR_SHUFFLE_SEED||0);
if(seed){let state=seed>>>0;for(let n=tests.length-1;n>0;n--){state=(Math.imul(state,1664525)+1013904223)>>>0;const target=Math.floor(state/0x100000000*(n+1));[tests[n],tests[target]]=[tests[target],tests[n]];}}
const files=JSON.parse(readFileSync('tools/sor-rentals-files.json')).filter(file=>file.startsWith('src/')&&file.endsWith('.js'));
const result=spawnSync('node_modules/.bin/c8',['--all','--check-coverage=false',...files.map(file=>'--include='+file),
 '--temp-directory=/tmp/sor-coverage','--report-dir=test-artifacts/sor-rentals/coverage',
 '--reporter=json','--reporter=json-summary','--reporter=text','node','--test','--test-concurrency=1',...tests],{stdio:'inherit',env:process.env});
process.exitCode=result.status??1;
