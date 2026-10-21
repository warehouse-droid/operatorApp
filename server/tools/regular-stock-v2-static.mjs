import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {ESLint} from 'eslint';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const files=JSON.parse(readFileSync('tools/regular-stock-v2-files.json'));
const out='test-artifacts/regular-stock-v2';mkdirSync(out,{recursive:true});
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
const baselinePath='tools/regular-stock-v2-lint-baseline.json';
const baseline=process.env.REGULAR_BASELINE?{}:JSON.parse(readFileSync(baselinePath));
const diagnostics=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
const failures=[];let checked=0,existing=0;
for(const file of files.filter(file=>file.endsWith('.js'))){
 const source=readFileSync(file,'utf8');
 const check=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
 if(process.env.REGULAR_BASELINE){const old=`${process.env.REGULAR_BASELINE}/${file}`;baseline[file]=existsSync(old)?await diagnostics(readFileSync(old,'utf8'),file):[];}
 const allowed=[...(baseline[file]||[])];
 for(const message of await diagnostics(source,file)){const index=allowed.indexOf(message);if(index<0)failures.push({file,message});else{allowed.splice(index,1);existing++;}}
 checked++;
}
if(process.env.REGULAR_BASELINE)writeFileSync(`${out}/lint-baseline.json`,JSON.stringify(baseline,null,2)+'\n');
writeFileSync(`${out}/static.json`,JSON.stringify({checked,unchangedLegacyDiagnostics:existing,newDiagnostics:failures},null,2));
assert.deepEqual(failures,[],'New static violations');
const types=spawnSync('node_modules/.bin/tsc',['-p','tools/regular-stock-v2-tsconfig.json'],{encoding:'utf8'});assert.equal(types.status,0,types.stdout+types.stderr);
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(hashes,null,2));console.log(JSON.stringify({syntaxFiles:checked,unchangedLegacyDiagnostics:existing,newDiagnostics:0,strictCoreTypes:'passed',sourceTreeSha256:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')}));
