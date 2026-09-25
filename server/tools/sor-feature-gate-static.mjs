import {writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
const mode=process.argv[2];
const files=['src/sor-feature-gate.js','src/sor-rental-service.js','src/mbt/feature-gate-catalog.js',
 'src/netsuite.js','src/driver-repository.js','src/dispatch-repository.js','src/server.js',
 'src/dispatch-order-catalog-repository.js','src/sor-rental-routes.js','public/sor-admin.js'].filter(existsSync);
for(const file of files){const check=spawnSync('node',['--check',file],{encoding:'utf8'});if(check.status)throw new Error(check.stderr);}
const engine=new ESLint({overrideConfigFile:'tools/sor-rentals-eslint.config.mjs'});
const rows=await engine.lintFiles(files);
const diagnostics=rows.flatMap(row=>row.messages.map(message=>({file:row.filePath.replace('/app/',''),rule:message.ruleId,message:message.message.replace(/on line \d+ column \d+/g,'on line LINE column COLUMN'),severity:message.severity})));
writeFileSync(`test-artifacts/sor-rentals/gate-lint-${mode}.json`,JSON.stringify(diagnostics));
const types=spawnSync('node_modules/.bin/tsc',['--ignoreConfig','--noEmit','--allowJs','--checkJs','--strict','false','--skipLibCheck','--target','ES2022','--lib','ES2022,DOM','--module','NodeNext','--moduleResolution','NodeNext','--moduleDetection','force',...files.filter(f=>f.includes('sor-')&&f.startsWith('src/'))],{encoding:'utf8'});
writeFileSync(`test-artifacts/sor-rentals/gate-types-${mode}.log`,types.stdout+types.stderr);
console.log(JSON.stringify({syntax:true,files:files.length,lint:diagnostics.length,typeExit:types.status}));
