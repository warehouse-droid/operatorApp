import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const tests=['test/mbt/integration/driver-direct-pickup-online-offline.test.js',
 'test/mbt/integration/driver-retained-completion-photos.test.js',
 'test/mbt/integration/driver-completed-photo-evidence-repository.test.js',
 'test/dispatch/integration/sor-signature-evidence.test.js'];
if(process.argv[2]==='child'){
 process.exitCode=await runNodeTestFilesIsolated(tests,{environment:process.env,label:'SOR integration compatibility'});
}else{
 const files=JSON.parse(readFileSync('tools/sor-rentals-files.json')).filter(file=>file.startsWith('src/')&&file.endsWith('.js'));
 const result=spawnSync('node_modules/.bin/c8',['--all','--check-coverage=false',...files.map(file=>'--include='+file),
 '--temp-directory=/tmp/sor-integration-coverage','--report-dir=test-artifacts/sor-rentals/integration-coverage',
 '--reporter=json','--reporter=json-summary','--reporter=text','node','tools/sor-rentals-integration-coverage.mjs','child'],{stdio:'inherit',env:process.env});
 process.exitCode=result.status??1;
}
