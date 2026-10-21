import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';
import config from './operator-inventory-eslint.config.mjs';
const changes=JSON.parse(readFileSync('test/support/count-sheet-refresh-changed-lines.json'));
const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{...config[0],files:['**/*.js'],languageOptions:{...config[0].languageOptions,globals:{...config[0].languageOptions.globals,self:'readonly',caches:'readonly'}}}]});
const errors=[];
for(const [file,change] of Object.entries(changes)) {
  if(!file.endsWith('.js')) {continue;}
  const source=readFileSync(file,'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),change.sha256,'Stale changed-line map: '+file);
  const [result]=await eslint.lintText(source,{filePath:file});
  errors.push(...result.messages.filter(message=>change.lines.includes(message.line)).map(message=>({file,...message})));
}
console.log(JSON.stringify({changedLineDiagnostics:errors},null,2));assert.equal(errors.length,0);
