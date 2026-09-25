import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import base from './operator-inventory-eslint.config.mjs';
const files=['src/control-damage-domain.js','src/control-damage-netsuite.js','src/control-damage-service.js','src/control-damage-review.js','src/control-damage-router.js','public/control-damage.js'];
const config=base.map(entry=>({...entry,files:[...entry.files,...files]}));
const eslint=new ESLint({overrideConfigFile:true,overrideConfig:config,fix:process.argv.includes('--fix')});
const results=await eslint.lintFiles(files);
if(process.argv.includes('--fix')) writeFileSync('/tmp/control-damage-lint-fixes.json',JSON.stringify(Object.fromEntries(results.filter(row=>row.output).map(row=>[row.filePath.replace('/app/',''),row.output]))));
const messages=results.flatMap(row=>row.messages.map(message=>({file:row.filePath,...message})));
console.log(JSON.stringify({messages},null,2));assert.equal(messages.length,0,'Control ESLint diagnostics');
for(const file of [...files,'src/netsuite.js','src/server.js','public/control.js','public/i18n.js']) {
 const run=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
}
console.log(JSON.stringify({lint:'pass',syntax:'pass',newFiles:files.length}));
