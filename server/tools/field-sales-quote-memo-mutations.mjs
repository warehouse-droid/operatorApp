import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const folder=mkdtempSync(join(tmpdir(),'field-sales-memo-mutants-')),output=process.env.FIELD_SALES_ARTIFACT_DIR,results=[];
try{
  writeFileSync(join(folder,'package.json'),'{"type":"module"}');symlinkSync(resolve('node_modules'),join(folder,'node_modules'));
  for(const name of ['src','public']){mkdirSync(join(folder,name));for(const entry of readdirSync(name)){if(entry==='field-sales'){cpSync(join(name,entry),join(folder,name,entry),{recursive:true});}else{symlinkSync(resolve(name,entry),join(folder,name,entry));}}}
  cpSync('test/field-sales',join(folder,'test/field-sales'),{recursive:true});mkdirSync(join(folder,'tools'));cpSync('tools/field-sales-trade-browser.mjs',join(folder,'tools/field-sales-trade-browser.mjs'));
  const mutants=[
    ['restore-reason-guard','src/field-sales/quotes.js','line.unit=item.unit;',"if(rate!==line.unitRate&&!line.overrideReason){throw fail('Item reason required.');}line.unit=item.unit;",'Q9'],
    ['drop-memo','src/field-sales/quotes.js','note:text(p.note,10000)',"note:''",'M2'],
    ['replace-entered-rate','src/field-sales/quotes.js','line.unit=item.unit;','line.unitRate=rate??line.unitRate;line.unit=item.unit;','M1'],
    ['detach-memo-form','public/field-sales/quotes.js','form="quote-details"','data-form="quote-details"','browser']
  ];
  const run=(args,artifacts)=>{
    const r=spawnSync(process.execPath,args,{cwd:folder,env:{...process.env,FIELD_SALES_ARTIFACT_DIR:artifacts},encoding:'utf8',timeout:90000}),log=(r.stdout||'')+(r.stderr||'');
    assert.doesNotMatch(log,/SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);assert.equal(r.error,undefined);return {r,log};
  };
  for(const [name,file,from,to,expected] of mutants){
    const path=join(folder,file),original=readFileSync(path,'utf8');assert.equal(original.split(from).length,2,name);writeFileSync(path,original.replace(from,to));
    try{
      const artifacts=join(output,'mutants',name);mkdirSync(artifacts,{recursive:true});
      const {r,log}=run(expected==='browser'?['tools/field-sales-trade-browser.mjs']:['--test','test/field-sales/quote-validation.test.js'],artifacts);
      writeFileSync(join(artifacts,'result.log'),log);assert.equal(r.status,1,log);
      if(expected==='browser'){assert.match(log,/Expected:.*Builder memo:/s);}else{assert.ok(log.split('\n').some(line=>line.startsWith('not ok ')&&line.includes(expected)),log);}
      let propertyKilled=null;
      if(expected!=='browser'){const property=run(['--test','--test-name-pattern=^M1 property','test/field-sales/quote-validation.test.js'],artifacts);writeFileSync(join(artifacts,'property.log'),property.log);assert.equal(property.r.status,1,property.log);propertyKilled=true;}
      results.push({name,killed:true,test:expected,propertyKilled});
    }finally{writeFileSync(path,original);}
  }
  console.log(JSON.stringify({killed:results.length,results}));
}finally{rmSync(folder,{recursive:true,force:true});}
