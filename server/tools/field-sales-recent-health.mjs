import assert from 'node:assert/strict';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const files=readdirSync('test/field-sales').filter(name=>name.endsWith('.test.js')).sort(),output=process.env.FIELD_SALES_ARTIFACT_DIR||'/tmp';
let seed=20260919;
for(let i=files.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[files[i],files[j]]=[files[j],files[i]];}
for(const name of files) {
  const result=spawnSync(process.execPath,['--test',join('test/field-sales',name)],{encoding:'utf8',timeout:120000});
  writeFileSync(join(output,`health-${name}.log`),(result.stdout||'')+(result.stderr||''));
  assert.equal(result.status,0,`${name}: ${result.stdout}\n${result.stderr}`);
}
const require=createRequire(import.meta.url),versions=Object.fromEntries(['@playwright/test','c8','eslint','fast-check','typescript'].map(name=>[name,JSON.parse(readFileSync(require.resolve(name+'/package.json'),'utf8')).version]));
console.log(JSON.stringify({passed:true,seed:20260919,order:files,node:process.version,versions}));
