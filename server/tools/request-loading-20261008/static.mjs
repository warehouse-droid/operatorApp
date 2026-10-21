import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {ESLint} from 'eslint';

const require=createRequire(import.meta.url);
const files=['src/special-stock-planning.js','src/special-stock-request-repository.js',
  'src/stock-request-repository.js','public/sales-stock-requests.js','public/scm-stock-requests.js'];
const syntax=files.map(file=>{
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  return {file,exit:result.status,diagnostics:result.stdout+result.stderr};
});
const lint=new ESLint({overrideConfigFile:'eslint.mbt.config.js'});
const diagnostics=(await lint.lintFiles(['tools/request-loading-20261008/*.mjs']))
  .map(result=>({file:result.filePath,messages:result.messages}));
const versions={node:process.version};
for(const name of ['typescript','eslint','c8','fast-check','@playwright/test','pg']) {
  versions[name]=require(name+'/package.json').version;
}
const result={syntax,diagnostics,versions};
fs.writeFileSync('test-artifacts/checks/static.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
process.exitCode=syntax.some(row=>row.exit!==0)||diagnostics.some(row=>row.messages.length)?1:0;
