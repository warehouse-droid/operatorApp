import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';
import { createSalesCatalog } from '../../src/field-sales/catalog.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
const record=(company,rate='27.125')=>({company,item_id:'981000001',sku:'FS-MATERIAL',description:'Masonry material',unit:'Each',unit_rate:rate,pricing:{source:`NetSuite ${company==='MBBS'?'TRADE-A':'TRADE'} (CAD)`,priceLevel:company==='MBBS'?'TRADE-A':'TRADE',unitId:'7',tiers:rate===null?[]:[{minimumQuantity:'0',unitRate:rate}]}});
test('P1 catalog refresh reads three company Trade sources and retains authoritative sales units',()=>withTransaction(async()=>{
  const repo=createFieldSalesRepository();let rate='27.125';const calls=[];
  const catalog=createSalesCatalog(repo,{reader:{items:async(company,cfg,id)=>{calls.push({company,id});return [record(company,rate)];}}});
  assert.equal((await catalog.refresh()).count,3);
  for(const company of ['MBBS','MBR','MBT']){const items=await catalog.search({company,search:'FS-MAT'});assert.equal(items.length,1);assert.equal(items[0].pricing.priceLevel,company==='MBBS'?'TRADE-A':'TRADE');assert.equal(items[0].unit_rate,'27.125');}
  rate='30';const priced=await catalog.price('MBR','981000001');assert.equal(priced.unit_rate,'30');assert.equal(priced.unit,'Each');assert.equal(priced.pricing.unitId,'7');
  rate=null;assert.equal((await catalog.price('MBBS','981000001')).unit_rate,null);
  await assert.rejects(createSalesCatalog(repo).price('MBBS','981000001'),/not configured/);
  await assert.rejects(catalog.price('MBT','missing'),e=>e.status===404);await assert.rejects(catalog.search({company:'other'}),/Unknown company/);assert.equal(calls.length,5);
},{rollback:true}));
test('P2 failed catalog refresh preserves the previous complete snapshot and missing Trade does not use legacy rates',()=>withTransaction(async()=>{
  const repo=createFieldSalesRepository();const catalog=createSalesCatalog(repo,{reader:{items:async company=>[record(company)]}});await catalog.refresh();
  const before=(await query('SELECT * FROM field_sales_catalog ORDER BY company,item_id')).rows;
  const failed=createSalesCatalog(repo,{reader:{items:async company=>{if(company==='MBT'){throw new Error('NetSuite unavailable');}return [record(company,'99')];}}});await assert.rejects(failed.refresh(),/unavailable/);assert.deepEqual((await query('SELECT * FROM field_sales_catalog ORDER BY company,item_id')).rows,before);
  const missing=createSalesCatalog(repo,{reader:{items:async company=>[record(company,null)]}});
  const result=await missing.price('MBT','981000001',{customerId:'1',distanceMetres:15000});assert.equal(result.unit_rate,null);assert.equal(result.options,undefined);assert.equal((await catalog.search({company:'MBT'}))[0].unit_rate,null);
},{rollback:true}));
test('T10 empty, changed-configuration and unavailable-item refreshes preserve catalog data',()=>withTransaction(async()=>{
  const repo=createFieldSalesRepository(),initial=createSalesCatalog(repo,{reader:{items:async company=>[record(company)]}});await initial.refresh();
  const before=(await query('SELECT * FROM field_sales_catalog ORDER BY company,item_id')).rows;
  await assert.rejects(createSalesCatalog(repo,{reader:{items:async()=>[]}}).refresh(),/empty catalog/);
  const changed=createSalesCatalog(repo,{reader:{items:async company=>{await query('UPDATE field_sales_settings SET revision=revision+1');return [record(company,'99')];}}});
  await assert.rejects(changed.refresh(),/settings changed/);await assert.rejects(changed.price('MBBS','981000001'),/settings changed/);
  await assert.rejects(createSalesCatalog(repo,{reader:{items:async()=>[]}}).price('MBBS','981000001'),/no longer available/);
  await assert.rejects(initial.price('OTHER','981000001'),/Unknown company/);await assert.rejects(initial.price('MBBS','981000001',{quantity:0}),/positive/);
  assert.deepEqual((await query('SELECT * FROM field_sales_catalog ORDER BY company,item_id')).rows,before);
},{rollback:true}));
