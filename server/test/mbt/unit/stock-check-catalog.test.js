import test from 'node:test';
import assert from 'node:assert/strict';
import {scrapeUnilockCatalog} from '../../../src/stock-check/unilock-catalog.js';
import {catalogPortal} from '../../support/stock-check-catalog-portal.js';

test('catalog visits pages and colour controls, deduplicates exact SKUs and uses selected plant labels',async()=>{
  const portal=await catalogPortal(),imported=[];
  try {
    const result=await scrapeUnilockCatalog({baseUrl:portal.baseUrl,allowTestOrigin:true,throttleMs:0,onProduct:async row=>imported.push(row)});
    assert.equal(result.products.length,3); assert.equal(imported.length,3); assert.equal(new Set(imported.map(row=>row.sku)).size,3);
    assert.equal(imported.find(row=>row.sku==='177ECS0163703-0').pickupLocation,'Pickering');
    assert.equal(imported.find(row=>row.sku==='0262XL0631907-0').pickupLocation,'Ayr');
    assert.equal(result.errors.length,0);
    assert.equal(portal.requests.some(row=>row.fields['ctl00$cpholder$itemlist$PageSizectl$dlPageSize']==='200'),true);
    assert.equal(portal.requests.some(row=>row.query.includes('page=2')),true);
    assert.equal(portal.requests.some(row=>/shoppingCart|checkout|login/iu.test(row.path)),false);
  } finally {await portal.close();}
});
test('one unknown pickup is recorded as a partial scrape failure without guessing or discarding good variants',async()=>{
  const portal=await catalogPortal({invalidPickup:true});
  try {
    const result=await scrapeUnilockCatalog({baseUrl:portal.baseUrl,allowTestOrigin:true,throttleMs:0});
    assert.equal(result.products.length,2); assert.equal(result.errors.length,1);
    assert.equal(result.errors[0].sku,'177ECSF163703-0'); assert.match(result.errors[0].reason,/pickup/iu);
    assert.equal(result.products.some(row=>row.sku==='177ECSF163703-0'),false);
  } finally {await portal.close();}
});
test('catalog cancellation stops before any portal requests and closes browser resources',async()=>{
  const portal=await catalogPortal(),controller=new AbortController();controller.abort();
  try {
    await assert.rejects(scrapeUnilockCatalog({baseUrl:portal.baseUrl,allowTestOrigin:true,signal:controller.signal}),error=>error.code==='STOCK_CHECK_CANCELLED');
    assert.equal(portal.requests.length,0);
  } finally {await portal.close();}
});
test('SCM catalog mode retains an unfamiliar displayed plant as a review record without guessing its code',async()=>{
  const portal=await catalogPortal({invalidPickup:true});
  try {
    const result=await scrapeUnilockCatalog({baseUrl:portal.baseUrl,allowTestOrigin:true,throttleMs:0,retainUnmapped:true});
    assert.equal(result.products.length,3);
    const row=result.products.find(product=>product.sku==='177ECSF163703-0');
    assert.equal(row.pickupLocation,'Unknown plant'); assert.equal(row.pickupCode,null); assert.equal(row.pickupNeedsReview,true);
    assert.equal(result.errors.length,1);
  } finally {await portal.close();}
});
