import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readPortalDocument,selectedProductFromDocument} from '../../../src/stock-check/unilock-dom.js';
import {selectedProductHtml,cartHtml,ENDURA_SKU,UNILOCK_FIXTURE_ORIGIN} from '../../support/stock-check-fixture.js';
let browser;
test.after(async()=>{await browser?.close();});
test.before(async()=>{browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});});
async function documentFor(html) {
  const page=await browser.newPage();
  try {return await readPortalDocument(page,html);}
  finally {await page.close();}
}
test('selected Endura label supplies Pickering even when shipping and tile label say Ayr',async()=>{
  const doc=await documentFor(selectedProductHtml());
  const row=selectedProductFromDocument(doc,{productUrl:UNILOCK_FIXTURE_ORIGIN+'/products/products/endura-coping?child='+ENDURA_SKU,expectedSku:ENDURA_SKU});
  assert.equal(row.pickupLocation,'Pickering'); assert.equal(row.pickupCode,'03'); assert.equal(row.sku,ENDURA_SKU);
  assert.equal(row.name,'Endura™ Coping 24x14 Cham Oat Beige'); assert.equal(row.colour,'OAT BEIGE'); assert.equal(row.finish,'SMOOTH');
  assert.equal(row.shape,'COPING'); assert.match(row.dimensions,/600mm/); assert.match(row.imageUrl,/177ECS0163703-0/);
});
test('native colour controls retain duplicate captions and distinct postback identities',async()=>{
  const doc=await documentFor(selectedProductHtml());
  assert.equal(doc.colours.length,2); assert.notEqual(doc.colours[0].event,doc.colours[1].event);
  assert.equal(doc.children[0].sku,ENDURA_SKU); assert.equal(doc.fields.__VIEWSTATE,'synthetic-viewstate');
  assert.equal(JSON.stringify(doc).includes('fixture-secret-never-returned'),false);
  assert.equal(doc.errors.length,0);
});
test('unknown, missing, and mismatched selected labels fail closed',async()=>{
  const doc=await documentFor(selectedProductHtml({pickup:'Unknown plant'}));
  assert.throws(()=>selectedProductFromDocument(doc,{productUrl:UNILOCK_FIXTURE_ORIGIN+'/products/products/endura-coping',expectedSku:ENDURA_SKU}),error=>error.code==='STOCK_CHECK_PICKUP_UNKNOWN');
  const good=await documentFor(selectedProductHtml());
  assert.throws(()=>selectedProductFromDocument(good,{productUrl:UNILOCK_FIXTURE_ORIGIN+'/products/products/endura-coping',expectedSku:'OTHER-SKU'}),error=>error.code==='STOCK_CHECK_PRODUCT_MISMATCH');
  const blank=await documentFor('<html><body>Temporary portal error</body></html>');
  assert.throws(()=>selectedProductFromDocument(blank,{productUrl:UNILOCK_FIXTURE_ORIGIN+'/products/products/endura-coping'}),error=>error.code==='STOCK_CHECK_PRODUCT_SELECTION_MISSING');
});
test('full cart rows are paired with their own SKU, unit, quantity and removal control',async()=>{
  const doc=await documentFor(cartHtml());
  assert.equal(doc.cartRows.length,2); assert.equal(doc.cartRows[0].sku,ENDURA_SKU); assert.equal(doc.cartRows[0].quantity,5);
  assert.equal(doc.cartRows[1].sku,'OTHER-1'); assert.equal(doc.cartRows[1].quantity,2); assert.equal(doc.cartRows[1].uom,'BNDL');
  assert.match(doc.cartRows[1].removeEvent,/ctl02\$removefromcart$/); assert.match(doc.cartRows[0].quantityField,/ctl01\$QuantityTextBox$/);
});
test('availability belongs to its own exact cart row, including a scheduled Urban item beside an available Beacon Hill item',async()=>{
  const doc=await documentFor(cartHtml([{sku:'0262XL0631907-0',quantity:5,uom:'BNDL',availabilityText:'Available'},
    {sku:'02U1183661507-0',quantity:2,uom:'BNDL',availabilityText:'Production Scheduled for - 2026-10-20'}]));
  assert.equal(doc.cartRows[0].availabilityText,'Available');assert.equal(doc.cartRows[1].availabilityText,'Production Scheduled for - 2026-10-20');
  assert.equal(doc.cartRows[1].sku,'02U1183661507-0');assert.equal(doc.cartRows[1].quantity,2);
});
test('the selected BNDL option supplies a product production schedule independently of a generic stock label',async()=>{
  const html=selectedProductHtml().replace('</form>','<select id="ctl00_cpholder_uomctl_iuom"><option value="BNDL">BNDL | 52.31 sqft | Production Scheduled for - 2026-10-20</option></select></form>');
  const doc=await documentFor(html);assert.equal(doc.productBundleAvailability,'Production Scheduled for - 2026-10-20');
  assert.equal(doc.productAvailabilityId,'ctl00_cpholder_uomctl_iuom');
});
test('blank bundle availability falls back to its visible product label and records the label control',async()=>{
  const html=selectedProductHtml().replace('</form>','<select id="ctl00_cpholder_uomctl_iuom"><option value="BNDL">BNDL | 52.31 sqft | </option></select></form>');
  const doc=await documentFor(html);assert.equal(doc.productBundleAvailability,'Available - Low in Stock');
  assert.equal(doc.productAvailabilitySource,'product_label');assert.match(doc.productAvailabilityId,/_stockAvail$/u);
});
test('conflicting bundle labels and hidden product availability never become an available result',async()=>{
  const html=selectedProductHtml().replace('</form>','<select id="ctl00_cpholder_uomctl_iuom"><option value="BNDL">BNDL | 52.31 sqft | Available</option><option value="BNDL">BNDL | 52.31 sqft | Not available</option></select></form>');
  assert.equal((await documentFor(html)).productBundleAvailability,'Available | Not available');
  assert.equal((await documentFor(selectedProductHtml().replace('id="ctl00_cpholder_ctl00_stockAvail"','hidden id="ctl00_cpholder_ctl00_stockAvail"'))).productBundleAvailability,'');
});
