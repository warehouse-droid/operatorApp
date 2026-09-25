import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import config from './operator-inventory-eslint.config.mjs';
const files = ['src/inventory-workflow-domain.js','src/count-sheet-repository.js','src/inventory-damage-repository.js',
  'src/inventory-damage-service.js','src/inventory-damage-netsuite.js','src/operator-inventory-router.js',
  'public/counting-calculator.js','public/operator-inventory.js','public/control-count-sheets.js'];
const eslint = new ESLint({overrideConfigFile:true,overrideConfig:config,fix:process.argv.includes('--fix')});
const results = await eslint.lintFiles(files);
if(process.argv.includes('--fix')) {
  // The runner mounts sources read-only. Export fixes for the host to apply explicitly.
  writeFileSync('/tmp/operator-inventory-lint-fixes.json',JSON.stringify(Object.fromEntries(results.filter(r=>r.output).map(r=>[r.filePath.replace('/app/',''),r.output]))));
}
const messages = results.flatMap(result=>result.messages.map(message=>({file:result.filePath,...message})));
console.log(JSON.stringify({messages},null,2));
assert.equal(messages.length,0,'ESLint diagnostics');
for(const file of [...files,'src/server.js','src/netsuite.js','src/photo-upload.js','src/photo-archive-repository.js','src/operator-yard-authorization.js','public/operator.js','public/control.js','public/app-sidebar.js','public/i18n.js','public/service-worker.js']) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}
const typecheck=spawnSync('node_modules/.bin/tsc',['--allowJs','--checkJs','--noEmit','--strict','--skipLibCheck','--target','ES2023','--module','NodeNext','--noUncheckedIndexedAccess','src/inventory-workflow-domain.js','--pretty','false'],{encoding:'utf8'});
console.log(typecheck.stdout+typecheck.stderr);
assert.equal(typecheck.status,0,'Domain type checking');
const pkg=JSON.parse(readFileSync('package.json','utf8'));
assert.ok(pkg.scripts['test:operator-inventory']);
console.log(JSON.stringify({syntax:'pass',lint:'pass',domainTypes:'pass',files:files.length}));
