import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {ESLint} from 'eslint';
const lint=new ESLint({overrideConfigFile:'tools/sor-rentals-eslint.config.mjs'});
const results={};
for(const name of ['driver.js','driver-service-worker.js']){
 const [before]=await lint.lintText(readFileSync('test-artifacts/driver-workflow/before/public/'+name,'utf8'),{filePath:'public/'+name});
 const [after]=await lint.lintText(readFileSync('public/'+name,'utf8'),{filePath:'public/'+name});
 const key=message=>JSON.stringify([message.ruleId,message.message.replace(/line \d+/g,'line #'),message.severity]);
 const old=new Map();for(const message of before.messages){const id=key(message);old.set(id,(old.get(id)||0)+1);}
 const added=[];for(const message of after.messages){const id=key(message);if(old.get(id))old.set(id,old.get(id)-1);else added.push(message);}
 assert.deepEqual(added,[],name+' has new lint diagnostics');
 results[name]={baseline:before.messages.length,current:after.messages.length,new:added.length};
}
writeFileSync('test-artifacts/driver-workflow/static.json',JSON.stringify({passed:true,lint:results},null,2));
console.log(JSON.stringify({passed:true,lint:results}));
