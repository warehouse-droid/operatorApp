import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED,'1','Disposable database required.');
const folder=mkdtempSync(join(tmpdir(),'field-sales-recent-mutants-')),results=[];
try {
  writeFileSync(join(folder,'package.json'),'{"type":"module"}');
  symlinkSync(resolve('node_modules'),join(folder,'node_modules'));
  for(const name of ['src','public']) {
    mkdirSync(join(folder,name));
    for(const entry of readdirSync(name)) {
      if(entry==='field-sales'){cpSync(join(name,entry),join(folder,name,entry),{recursive:true});}
      else{symlinkSync(resolve(name,entry),join(folder,name,entry));}
    }
  }
  mkdirSync(join(folder,'test/field-sales'),{recursive:true});
  for(const name of ['recent.test.js','recent-policy.test.js','recent-fixture.js']){cpSync(join('test/field-sales',name),join(folder,'test/field-sales',name));}
  const mutants=[
    ['old-detail-filtered','src/field-sales/repository.js','WHERE jobsite_id=$1 ORDER BY source,source_key',"WHERE jobsite_id=$1 AND data->>'date'>'2025-01-01' ORDER BY source,source_key".replaceAll("'","\\'"),'recent.test.js','R7'],
    ['cutoff-off-by-one','public/field-sales/lead-policy.js','Math.min(day,last)','Math.min(day,last)-1','recent-policy.test.js','P1'],
    ['milestone-stays-recommended','public/field-sales/lead-policy.js',"next.source='planning'","next.source='recommended'",'recent-policy.test.js','P2'],
    ['application-date-ignored','src/field-sales/lead-filters.js',"validDate(\"s.data#>>'{raw,APPLICATION_DATE}'\")","validDate(\"s.data#>>'{raw,ISSUED_DATE}'\")",'recent-policy.test.js','P3'],
    ['legacy-date-mislabeled','public/field-sales/lead-policy.js',"application?'application':'record'","application?'application':'issued'",'recent-policy.test.js','P4']
  ];
  for(const [name,file,from,to,test,expected] of mutants) {
    const path=join(folder,file),original=readFileSync(path,'utf8');assert.ok(original.includes(from),name);
    writeFileSync(path,original.replace(from,to));
    try {
      const result=spawnSync(process.execPath,['--test',join(folder,'test/field-sales',test)],{encoding:'utf8',timeout:45000,env:process.env});
      const log=(result.stdout||'')+(result.stderr||'');
      writeFileSync(join(process.env.FIELD_SALES_ARTIFACT_DIR||'/tmp',`mutant-${name}.log`),log);
      assert.equal(result.status,1,log);assert.ok(result.stdout.split('\n').some(line=>line.startsWith('not ok ')&&line.includes(expected)),log);
      assert.doesNotMatch(log,/SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);
      results.push({name,killed:true,test:expected});
    }finally{writeFileSync(path,original);}
  }
  console.log(JSON.stringify({killed:results.length,results}));
}finally{rmSync(folder,{recursive:true,force:true});}
