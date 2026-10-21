import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const files=['src/delivery-request*.js','public/delivery-request*.js','public/app-event-stream.js','test/mbt/**/delivery-request*.js','tools/delivery-request*.mjs'];
const lint=spawnSync('node_modules/.bin/eslint',['--config','tools/delivery-request-eslint.config.mjs','--max-warnings=0','--format=json',...files],{encoding:'utf8'});
writeFileSync('test-artifacts/delivery-requests/feature-lint.json',lint.stdout);
process.stdout.write(lint.stdout+lint.stderr);
process.exitCode=lint.status ?? 1;
