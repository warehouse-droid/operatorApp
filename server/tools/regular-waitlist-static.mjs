import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,cpSync,rmSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ESLint} from 'eslint';
const out='test-artifacts/regular-waitlist',files=JSON.parse(readFileSync('tools/regular-waitlist-files.json')).filter(file=>file.endsWith('.js'));
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
const linter=new ESLint({overrideConfigFile:'tools/regular-waitlist-eslint.config.mjs'}),after=await linter.lintFiles(files);
const old=await Promise.all(files.filter(f=>existsSync(out+'/before/'+f)).map(async file=>({file,result:(await linter.lintText(readFileSync(out+'/before/'+file,'utf8'),{filePath:resolve(file)}))[0]})));
const signature=message=>message.ruleId+':'+message.message;
const subtract=(current,previous,key)=>{const counts=new Map();for(const value of previous)counts.set(key(value),(counts.get(key(value))||0)+1);return current.filter(value=>{const count=counts.get(key(value))||0;if(!count)return true;counts.set(key(value),count-1);return false;});};
const newLint=after.flatMap(row=>{const file=row.filePath.slice(process.cwd().length+1),known=old.find(x=>x.file===file)?.result.messages||[];
  return subtract(row.messages,known,signature).map(m=>({file,...m}));});
writeFileSync(out+'/lint.json',JSON.stringify({newLint,findings:after.map(r=>({file:r.filePath,messages:r.messages}))},null,2));
const typeFiles=files.filter(f=>f!=='src/server.js');
const flags=['--noEmit','--allowJs','--checkJs','--strict','false','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','tools/regular-waitlist-globals.d.ts'];
const check=(cwd,roots)=>{const result=spawnSync(resolve('node_modules/.bin/tsc'),[...flags,...roots],{cwd,encoding:'utf8',maxBuffer:40000000});assert(!result.error&&!result.signal,'Type checker must finish normally');assert(result.status===0||/^.+\(\d+,\d+\): error TS\d+:/m.test(result.stdout),result.stdout+result.stderr);return result.stdout+result.stderr;};
const baseline=mkdtempSync(resolve(tmpdir(),'waitlist-static-'));
let previousTypes;
try{
  for(const folder of ['src','public','tools'])cpSync(folder,baseline+'/'+folder,{recursive:true});
  symlinkSync(resolve('node_modules'),baseline+'/node_modules','dir');
  for(const file of files){if(existsSync(out+'/before/'+file))cpSync(out+'/before/'+file,baseline+'/'+file);else rmSync(baseline+'/'+file,{force:true});}
  previousTypes=check(baseline,typeFiles.filter(file=>existsSync(out+'/before/'+file)));
}finally{rmSync(baseline,{recursive:true,force:true});}
const currentTypes=check(process.cwd(),typeFiles);
const diagnostics=text=>text.split(/\r?\n/u).reduce((rows,line)=>{if(/^.+\(\d+,\d+\): error TS\d+:/.test(line))rows.push(line.replace(/\(\d+,\d+\)/,'(location)'));else if(line.trim()&&rows.length)rows[rows.length-1]+='\n'+line;return rows;},[]);
const oldTypes=diagnostics(previousTypes),afterTypes=diagnostics(currentTypes),newTypes=subtract(afterTypes,oldTypes,value=>value);
writeFileSync(out+'/types-baseline.log',previousTypes);writeFileSync(out+'/types.log',currentTypes);
writeFileSync(out+'/types.json',JSON.stringify({baselineDiagnostics:oldTypes.length,currentDiagnostics:afterTypes.length,newTypes,serverBoundary:'Server syntax, authenticated HTTP and real startup checks; tsc follows scoped modules.'},null,2));
console.log(JSON.stringify({syntaxFiles:files.length,newLint,baselineTypeDiagnostics:oldTypes.length,currentTypeDiagnostics:afterTypes.length,newTypes}));
assert.deepEqual(newLint,[],'No new lint findings');
assert.deepEqual(newTypes,[],'No new type diagnostics');
