import assert from 'node:assert/strict';
import {createFieldSalesRepository} from './src/field-sales/repository.js';
import {createSalesCatalog} from './src/field-sales/catalog.js';
import {closeDb} from './src/db.js';
assert.equal(process.env.FIELD_SALES_RELEASE_ACTIVATION,'1','Run through the authorized deployment command.');
try {
  const repo=createFieldSalesRepository(),before=await repo.settings();
  const catalog=await createSalesCatalog(repo).refresh();
  const settings=await repo.saveSettings({id:'deployment:field-sales-20260918',role:'admin',roles:['admin']},
    {revision:before.revision,data:{...before.data,enabled:true,importsEnabled:true,postingEnabled:false}});
  assert.equal(settings.data.enabled,true);assert.equal(settings.data.importsEnabled,true);assert.equal(settings.data.postingEnabled,false);
  console.log(JSON.stringify({enabled:settings.data.enabled,importsEnabled:settings.data.importsEnabled,postingEnabled:settings.data.postingEnabled,catalog}));
}finally{await closeDb();}
