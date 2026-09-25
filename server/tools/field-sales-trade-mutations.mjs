import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const folder=mkdtempSync(join(tmpdir(),'field-sales-trade-mutants-')),results=[];
try{
  writeFileSync(join(folder,'package.json'),'{"type":"module"}');symlinkSync(resolve('node_modules'),join(folder,'node_modules'));
  for(const name of ['src','public']){mkdirSync(join(folder,name));for(const entry of readdirSync(name)){if(entry==='field-sales'){cpSync(join(name,entry),join(folder,name,entry),{recursive:true});}else{symlinkSync(resolve(name,entry),join(folder,name,entry));}}}
  cpSync('test/field-sales',join(folder,'test/field-sales'),{recursive:true});mkdirSync(join(folder,'migrations'));cpSync('migrations/211_field_sales_trade.sql',join(folder,'migrations/211_field_sales_trade.sql'));
  const mutants=[
    ['wrong-level','public/field-sales/pricing.js',"return 'TRADE-A'","return 'TRADE'",'trade-pricing.test.js','T1'],
    ['threshold-boundary','public/field-sales/pricing.js','minimum<=q','minimum<q','trade-pricing.test.js','T1'],
    ['missing-tier-fallback','public/field-sales/pricing.js','return rate;','return rate??item.unit_rate;','trade-pricing.test.js','T1'],
    ['omit-mbr','public/field-sales/domain.js',"['MBBS', 'MBR', 'MBT']","['MBBS', 'MBT']",'properties.test.js','property exact'],
    ['replace-entered-price','src/field-sales/quotes.js','line.unit=item.unit;','line.unitRate=rate??line.unitRate;line.unit=item.unit;','trade-storage.test.js','T5'],
    ['drop-serialization','src/field-sales/catalog.js',`await db.query("SELECT pg_advisory_xact_lock(hashtext('field-sales-trade-catalog'))");`,'await Promise.resolve();','trade-storage.test.js','T7'],
    ['omit-mbr-settings','migrations/211_field_sales_trade.sql','\'{"MBR":{"name":"MBR","taxBps":1300}}\'::jsonb','\'{}\'::jsonb','trade-storage.test.js','T6'],
    ['empty-catalog-accepted','src/field-sales/catalog.js','if(!items.length)','if(false)','catalog.test.js','T10'],
    ['ambiguous-price-accepted','src/field-sales/netsuite-catalog.js','if(existing&&!sameDecimal','if(false&&existing&&!sameDecimal','trade-pricing.test.js','T11']
  ];
  for(const [name,file,from,to,test,expected] of mutants){
    const path=join(folder,file),original=readFileSync(path,'utf8');assert.ok(original.includes(from),name);writeFileSync(path,original.replace(from,to));
    try{
      const run=args=>{const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:90000});const log=(r.stdout||'')+(r.stderr||'');assert.doesNotMatch(log,/SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);return {r,log};};
      const {r,log}=run(['--test',join(folder,'test/field-sales',test)]);writeFileSync(join(process.env.FIELD_SALES_ARTIFACT_DIR,`mutant-${name}.log`),log);assert.equal(r.status,1,log);assert.ok(log.split('\n').some(l=>l.startsWith('not ok ')&&l.includes(expected)),log);
      const property=run(['--test','--test-name-pattern=^property',join(folder,'test/field-sales/trade-pricing.test.js'),join(folder,'test/field-sales/properties.test.js')]);assert.ok([0,1].includes(property.r.status),property.log);
      results.push({name,killed:true,test:expected,propertyKilled:property.r.status===1});
    }finally{writeFileSync(path,original);}
  }
  console.log(JSON.stringify({killed:results.length,results}));
}finally{rmSync(folder,{recursive:true,force:true});}
