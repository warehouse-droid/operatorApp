import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
const label=process.argv[2];
const files=['public/operator.js','public/service-worker.js','src/sor-rental-service.js','src/dispatch-delivery-group-repository.js'];
for(const file of files){const check=spawnSync('node',['--check',file],{encoding:'utf8'});if(check.status)throw new Error(check.stderr);}
const lint=await new ESLint({overrideConfigFile:'tools/sor-rentals-eslint.config.mjs'}).lintFiles(files);
const diagnostics=lint.flatMap(row=>row.messages.map(message=>({file:row.filePath.replace('/app/',''),rule:message.ruleId,message:message.message.replace(/on line \d+ column \d+/g,'on line LINE column COLUMN'),severity:message.severity})));
writeFileSync(`test-artifacts/sor-rentals/responsiveness-lint-${label}.json`,JSON.stringify(diagnostics));
const types=spawnSync('node_modules/.bin/tsc',['--ignoreConfig','--noEmit','--allowJs','--checkJs','--strict','false','--skipLibCheck','--target','ES2022','--lib','ES2022,DOM','--module','NodeNext','--moduleResolution','NodeNext','--moduleDetection','force','src/sor-rental-service.js','src/dispatch-delivery-group-repository.js'],{encoding:'utf8',maxBuffer:20e6});
writeFileSync(`test-artifacts/sor-rentals/responsiveness-types-${label}.log`,types.stdout+types.stderr);
console.log(JSON.stringify({syntax:true,files:files.length,lint:diagnostics.length,typeExit:types.status}));
