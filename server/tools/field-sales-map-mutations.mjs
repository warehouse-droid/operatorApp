import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const source=readFileSync('public/field-sales/planner-data.js','utf8'),folder=mkdtempSync(join(tmpdir(),'field-sales-planner-mutants-')),results=[];
try {
  for(const [name,from,to,expectedFailure] of [
    ['repeat-existing-jobsite','if(existing.has(id))','if(false)','bulk additions skip equivalent jobsite addresses'],
    ['reject-valid-250-stop-route','stops.length+additions.length>250','stops.length+additions.length>=250','250 is inclusive'],
    ['wrong-ward-name','id===ward','id===String(Number(ward)+1).padStart(2,\'0\')','ward names cover all 25 City wards']
  ]) {
    assert.ok(source.includes(from));const path=join(folder,`${name}.mjs`);writeFileSync(path,source.replace(from,to));
    const result=spawnSync(process.execPath,['--test','test/field-sales/planner.test.js'],{encoding:'utf8',env:{...process.env,FIELD_SALES_PLANNER_MODULE:pathToFileURL(path).href}});
    assert.equal(result.status,1,result.stdout+result.stderr);assert.ok(result.stdout.split('\n').some(line=>line.startsWith('not ok ')&&line.includes(expectedFailure)),result.stdout);assert.doesNotMatch(result.stderr,/SyntaxError|ERR_MODULE_NOT_FOUND/);
    results.push({name,killed:true});
  }
  console.log(JSON.stringify({killed:results.length,results}));
}finally {rmSync(folder,{recursive:true,force:true});}
