import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const out='test-artifacts/receiving-multi-yard';
const manifest=JSON.parse(readFileSync('test/receiving-multi-yard-manifest.json','utf8'));
const baseline=mkdtempSync(path.join(tmpdir(),'receiving-multiyard-static-'));
mkdirSync(out,{recursive:true});

function run(label,cmd,args,cwd) {
  const result=spawnSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:50e6});
  if(result.error) {throw result.error;}
  const output=result.stdout+result.stderr;
  writeFileSync(`${out}/${label}.log`,output);
  assert.ok(result.status!==null && result.status<=2,`${label}: ${output.slice(-1000)}`);
  return output;
}

try {
  for(const folder of ['src','public']) {cpSync(folder,path.join(baseline,folder),{recursive:true});}
  cpSync('package.json',path.join(baseline,'package.json'));
  symlinkSync(path.resolve('node_modules'),path.join(baseline,'node_modules'),'dir');
  for(const file of manifest.runtimeFiles) {
    const target=path.join(baseline,file);
    if(manifest.before[file]) {cpSync(path.join('test/support/receiving-multi-yard-baseline',file),target);}
    else {rmSync(target);}
  }
  const config=path.resolve('tools/receiving-multi-yard-eslint.config.mjs');
  const lintArgs=['--config',config,'--format','json'];
  const oldFiles=manifest.runtimeFiles.filter(file=>manifest.before[file] && file.endsWith('.js'));
  const files=[...manifest.runtimeFiles.filter(file=>file.endsWith('.js')),...manifest.testFiles];
  const oldLint=JSON.parse(run('lint-baseline',path.resolve('node_modules/.bin/eslint'),[...lintArgs,...oldFiles],baseline));
  const newLint=JSON.parse(run('lint',path.resolve('node_modules/.bin/eslint'),[...lintArgs,...files],process.cwd()));
  const messages=(rows,root)=>rows.flatMap(row=>row.messages.map(message=>({file:path.relative(root,row.filePath),rule:message.ruleId,
    message:message.message.replace(/on line \d+ column \d+/g,'on an existing line')})));
  const previous=messages(oldLint,baseline);
  const current=messages(newLint,process.cwd());
  const remaining=new Map();
  for(const message of previous) {
    const key=JSON.stringify(message);
    remaining.set(key,(remaining.get(key)||0)+1);
  }
  const newErrors=current.filter(message=>{
    const key=JSON.stringify(message);
    const count=remaining.get(key)||0;
    if(!count) {return true;}
    remaining.set(key,count-1);
    return false;
  });
  writeFileSync(`${out}/lint-new.json`,JSON.stringify(newErrors,null,2));
  assert.equal(newErrors.length,0,JSON.stringify(newErrors));
  const typeArgs=['--allowJs','--noEmit','--module','nodenext','--target','es2023','--skipLibCheck','--strict','--checkJs','false'];
  const typed=['src/operator-yard-authorization.js','src/operator-netsuite-posting-targets.js','src/operator-netsuite-posting-controller.js'];
  const beforeTypes=run('types-baseline',path.resolve('node_modules/.bin/tsc'),[...typeArgs,...typed],baseline);
  const afterTypes=run('types',path.resolve('node_modules/.bin/tsc'),[...typeArgs,...typed,'src/receiving-yard-scope.js'],process.cwd());
  const errors=text=>text.split('\n').filter(line=>line.includes('error TS')).map(line=>line.replace(/\(\d+,\d+\)/,'')).sort();
  const beforeErrors=errors(beforeTypes);
  const afterErrors=errors(afterTypes);
  const newTypes=afterErrors.filter(error=>!beforeErrors.includes(error));
  writeFileSync(`${out}/types-new.json`,JSON.stringify(newTypes,null,2));
  assert.equal(newTypes.length,0,JSON.stringify(newTypes));
  const summary={lintBaseline:previous.length,lintCurrent:current.length,newLint:newErrors.length,
    typeBaseline:beforeErrors.length,typeCurrent:afterErrors.length,newTypes:newTypes.length};
  writeFileSync(`${out}/static.json`,JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
} finally {rmSync(baseline,{recursive:true,force:true});}
