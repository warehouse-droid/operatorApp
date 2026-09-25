import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {createFieldSalesRepository} from '../src/field-sales/repository.js';
import {createSalesCatalog} from '../src/field-sales/catalog.js';
import {createNetSuiteCatalogReader} from '../src/field-sales/netsuite-catalog.js';
try{
  const repo=createFieldSalesRepository();
  assert.notEqual(process.env.FIELD_SALES_NETSUITE_WRITES_ENABLED,'true','Do not change publication gates during catalog activation.');
  const refreshed=await withTransaction(async()=>{
    const current=await repo.settings();assert.equal(current.data.postingEnabled,false);
    const companies=structuredClone(current.data.companies);
    for(const [company,subsidiaryId] of [['MBBS','1'],['MBR','7'],['MBT','3']]){companies[company]={...companies[company],subsidiaryId,currencyId:'1'};}
    await repo.saveSettings({id:'system:field-sales-trade-release',role:'admin'},{revision:current.revision,data:{companies}});
    const result=await createSalesCatalog(repo,{reader:createNetSuiteCatalogReader()}).refresh();
    await repo.audit({id:'system:field-sales-trade-release'},'catalog.trade.activate','catalog',{...result,policies:{MBBS:'TRADE-A',MBR:'TRADE',MBT:'TRADE'}});
    return result;
  });
  const counts=(await query(`SELECT company,count(*)::int AS items,count(unit_rate)::int AS priced FROM field_sales_catalog WHERE active GROUP BY company ORDER BY company`)).rows;
  for(const row of counts){assert.ok(row.items>0);}
  assert.equal(counts.length,3);console.log(JSON.stringify({passed:true,postingEnabled:false,...refreshed,counts}));
}finally{await closeDb();}
