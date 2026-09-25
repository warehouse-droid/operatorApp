import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=JSON.parse(readFileSync('tools/sor-rentals-files.json')).filter(file=>file.startsWith('src/')&&file.endsWith('.js'));
const result=spawnSync('node_modules/.bin/c8',['--all','--check-coverage=false',...files.map(file=>'--include='+file),
 '--temp-directory=/tmp/sor-dispatch-coverage','--report-dir=test-artifacts/sor-rentals/dispatch-coverage',
 '--reporter=json','--reporter=json-summary','--reporter=text','npm','run','test:dispatch:performance'],{stdio:'inherit',env:process.env});
process.exitCode=result.status??1;
