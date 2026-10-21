import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import base from '../eslint.mbt.config.js';
const out='test-artifacts/damage-posting-retry-20261001';mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/damage-posting-retry-files.json')).filter(file=>file.endsWith('.js'));
const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{...base[1],files,
  languageOptions:{...base[1].languageOptions,globals:{...base[1].languageOptions.globals,
    window:'readonly',document:'readonly',localStorage:'readonly',navigator:'readonly',requestAnimationFrame:'readonly',
    TextEncoder:'readonly',DataView:'readonly',Uint8Array:'readonly',structuredClone:'readonly',self:'readonly',caches:'readonly',Request:'readonly',URL:'readonly'}}}]});
const diagnostics=[];
for(const file of files) {
  const normalize=messages=>messages.map(({ruleId,message,severity})=>JSON.stringify({ruleId,message,severity}));
  const previous=`${out}/baseline-source/${file}`;
  const before=existsSync(previous)?normalize((await eslint.lintText(readFileSync(previous,'utf8'),{filePath:file}))[0].messages):[];
  const after=normalize((await eslint.lintText(readFileSync(file,'utf8'),{filePath:file}))[0].messages);
  for(const message of after) {const at=before.indexOf(message);if(at<0) {diagnostics.push({file,message:JSON.parse(message)});}else {before.splice(at,1);}}
  const check=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
}
writeFileSync(`${out}/static.json`,JSON.stringify({newLintFindings:diagnostics,syntaxFiles:files.length},null,2));
console.log(JSON.stringify({newLintFindings:diagnostics,syntaxFiles:files.length}));
assert.deepEqual(diagnostics,[]);
