import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupForLabel, validateQuantity, normalizeProduct, effectiveProduct, matchingProducts,
  stockVerdict, allowedPortalUrl, publicAccount, sanitizeFailure, canUseStockCheck,parseAvailability,stockCheckResultView,productAvailabilityVerdict } from '../../../src/stock-check/domain.js';

const sample={sku:'177ECS0163703-0',name:'Endura™ Coping 24x14 Cham Oat Beige',series:'Endura Coping',
  finish:'SMOOTH',colour:'OAT BEIGE',shape:'COPING',size:'24 x 14 Cham',pickupLocation:'Pickering',
  url:'https://ontario.order.unilock.com/products/products/endura-coping?child=177ECS0163703-0'};
const cart=(quantity=5,uom='BNDL',sku=sample.sku)=>[{sku,quantity,uom,availabilityText:'Available'}];
const verdict=(extra={})=>stockVerdict({actionAccepted:true,expectedSku:sample.sku,requestedQuantity:5,
  baselineQuantity:0,cartRows:cart(),pickupMatches:true,dateMatches:true,...extra});

test('Endura selected label resolves to Pickering, never the paver or wall default',()=>{
  const row=normalizeProduct(sample);
  assert.equal(row.pickupLocation,'Pickering'); assert.equal(row.pickupCode,'03'); assert.equal(row.sku,sample.sku);
  assert.deepEqual(pickupForLabel('Plant Produced: Ayr'),{code:'07',name:'Ayr'});
  assert.deepEqual(pickupForLabel('Loc 05 - Unilock Gormley'),{code:'05',name:'Gormley'});
});
test('unknown or missing selected pickup is an extraction failure instead of a guess',()=>{
  for(const label of ['',null,'Ontario','Georgetown / Pickering']) {
    assert.throws(()=>pickupForLabel(label),error=>error.code==='STOCK_CHECK_PICKUP_UNKNOWN');
  }
});
test('bundle quantity accepts only positive whole portal quantities',()=>{
  for(const value of [1,'5',99999]) {assert.equal(validateQuantity(value),Number(value));}
  for(const value of [0,-1,1.5,'1.5','1e2',NaN,Infinity,100000,'',null,true]) {
    assert.throws(()=>validateQuantity(value),error=>error.code==='STOCK_CHECK_QUANTITY_INVALID');
  }
});
test('SCM overrides survive a fresh scrape, and clearing restores the scraped value',()=>{
  const fresh=normalizeProduct({...sample,pickupLocation:'Ayr'});
  const manual=effectiveProduct({...fresh,overrides:{pickupLocation:'Pickering',name:'SCM item label'}});
  assert.equal(manual.pickupLocation,'Pickering'); assert.equal(manual.pickupCode,'03'); assert.equal(manual.name,'SCM item label');
  const reset=effectiveProduct({...fresh,overrides:{}}); assert.equal(reset.pickupLocation,'Ayr'); assert.equal(reset.name,sample.name);
});
test('search handles trademarks, punctuation, colour and exact SKU without picking an ambiguous variant',()=>{
  const second={...sample,sku:'177ECSF163703-0',name:'Endura Coping 24x14 FN Oat Beige',size:'24x14 Fullnose'};
  assert.deepEqual(matchingProducts([sample,second],'177ECS0163703-0').map(x=>x.sku),[sample.sku]);
  assert.equal(matchingProducts([sample,second],'endura coping oat beige').length,2);
  assert.deepEqual(matchingProducts([sample,second],'24 x 14 cham oat beige').map(x=>x.sku),[sample.sku]);
  assert.equal(matchingProducts([sample],'unrelated product').length,0);
});
test('exact five-bundle native cart acceptance confirms stock',()=>{
  assert.equal(verdict().status,'stock_confirmed'); assert.equal(verdict().verifiedQuantity,5);
  assert.equal(verdict().availabilityEvidenceVersion,1);assert.equal(verdict().availabilityText,'Available');
});
test('vendor availability distinguishes Available from production schedules, negative labels and unknown text',()=>{
  for(const text of ['Available','In Stock','  available  ']) {assert.equal(parseAvailability(text).status,'in_stock');}
  const production=parseAvailability('Production Scheduled for - 2026-10-20');assert.equal(production.status,'in_production');assert.equal(production.eta,'2026-10-20');
  assert.equal(parseAvailability('In production | ETA 2026-10-20').status,'in_production');
  for(const text of ['Out of stock','Not available','Not in stock']) {assert.equal(parseAvailability(text).status,'out_of_stock');}
  assert.equal(parseAvailability('Available - Low in Stock').status,'low_stock');
  for(const text of ['',null,'Unexpected portal text','Available | In production']) {assert.equal(parseAvailability(text).status,'unknown');}
});
test('pre-cart product availability never claims a verified bundle quantity or cart acceptance',()=>{
  for(const [text,status] of [['Available','stock_available'],['Available - Low in Stock','low_stock'],
    ['Production Scheduled for - 2026-10-20','in_production'],['Not available','insufficient_stock'],['Ask sales','scrape_failure']]) {
    const result=productAvailabilityVerdict({availabilityText:text,availabilitySource:'product_bundle',requestedQuantity:5});
    assert.equal(result.status,status);assert.equal(result.verifiedQuantity,null);assert.equal(result.acceptedQuantity,null);
    assert.equal(result.quantityVerified,false);assert.equal(result.cartAcceptanceVerified,false);
    assert.deepEqual(stockCheckResultView(result),result);
  }
  assert.equal(productAvailabilityVerdict({availabilityText:'Available',availabilitySource:'cart',requestedQuantity:5}).status,'scrape_failure');
});
test('an accepted cart row scheduled for production is not immediate stock and retains its ETA',()=>{
  const result=verdict({cartRows:[{...cart()[0],availabilityText:'Production Scheduled for - 2026-10-20'}]});
  assert.equal(result.status,'in_production');assert.equal(result.eta,'2026-10-20');assert.equal(result.verifiedQuantity,null);
  assert.equal(result.acceptedQuantity,5);assert.equal(result.cartAcceptanceVerified,true);assert.equal(result.availabilitySource,'cart');
});
test('an accepted cart row explicitly out of stock cannot confirm immediate availability',()=>{
  const result=verdict({cartRows:[{...cart()[0],availabilityText:'Not available'}]});assert.equal(result.status,'insufficient_stock');assert.equal(result.verifiedQuantity,0);
});
test('missing, unfamiliar or ambiguous cart availability fails for SCM review despite accepted quantities',()=>{
  for(const extra of [{availabilityText:''},{availabilityText:undefined},{availabilityText:'Please ask sales'},{availabilityAmbiguous:true}]) {
    const result=verdict({cartRows:[{...cart()[0],...extra}]});assert.equal(result.status,'scrape_failure');assert.equal(result.requiresScmReview,true);
  }
});
test('historical cart-only confirmations are displayed unverified without changing the stored result',()=>{
  const stored={status:'stock_confirmed',verifiedQuantity:5,reason:'Cart accepted',cartTotalQuantity:5};
  const result=stockCheckResultView(stored);assert.equal(result.status,'availability_unverified');assert.equal(result.verifiedQuantity,null);assert.equal(result.acceptedQuantity,5);
  assert.equal(stored.status,'stock_confirmed');assert.equal(stored.verifiedQuantity,5);
  const modern=verdict();assert.deepEqual(stockCheckResultView(modern),modern);
});
test('a generic available label, HTTP success, or missing native acceptance never confirms stock',()=>{
  assert.equal(verdict({actionAccepted:false,portalLabel:'Available - Low in Stock',httpStatus:200}).status,'scrape_failure');
});
test('wrong SKU, partial quantity, wrong unit, or duplicate cart rows are scrape failures',()=>{
  for(const rows of [cart(4),cart(5,'SQFT'),cart(5,'BNDL','OTHER'),[...cart(),...cart()]]) {
    assert.equal(verdict({cartRows:rows}).status,'scrape_failure');
  }
});
test('wrong pickup or request date invalidates the quantity result',()=>{
  assert.equal(verdict({pickupMatches:false}).status,'scrape_failure');
  assert.equal(verdict({dateMatches:false}).status,'scrape_failure');
});
test('native increment accounts for an existing cart without mistaking it for a new stock test',()=>{
  const result=verdict({baselineQuantity:1,cartRows:cart(6)});
  assert.equal(result.status,'stock_confirmed'); assert.equal(result.verifiedQuantity,5); assert.equal(result.cartTotalQuantity,6);
  assert.equal(verdict({baselineQuantity:1,cartRows:cart(5)}).status,'scrape_failure');
});
test('explicit shortages are distinguished from portal bugs and pre-existing-cart ambiguity',()=>{
  assert.equal(verdict({actionAccepted:false,explicitStockShortage:true,cartRows:[]}).status,'insufficient_stock');
  assert.equal(verdict({actionAccepted:false,explicitStockShortage:true,baselineQuantity:1}).status,'scrape_failure');
  assert.equal(verdict({otherError:'Portal failed',explicitStockShortage:true}).status,'scrape_failure');
});
test('portal navigation rejects foreign origins, embedded credentials, checkout and unsafe paths',()=>{
  assert.equal(allowedPortalUrl(sample.url).hostname,'ontario.order.unilock.com');
  for(const url of ['https://evil.invalid/products/products/endura-coping','http://ontario.order.unilock.com/login.aspx',
    'https://someone:secret@ontario.order.unilock.com/login.aspx','https://ontario.order.unilock.com/checkout.aspx',
    'https://ontario.order.unilock.com/submitOrder.aspx','file:///etc/passwd']) {
    assert.throws(()=>allowedPortalUrl(url),error=>error.code==='STOCK_CHECK_ORIGIN_INVALID');
  }
});
test('localhost portal fixtures require explicit test permission',()=>{
  const url='http://127.0.0.1:19017/login.aspx';
  assert.throws(()=>allowedPortalUrl(url));
  assert.equal(allowedPortalUrl(url,{baseUrl:'http://127.0.0.1:19017',allowTestOrigin:true}).hostname,'127.0.0.1');
  assert.throws(()=>allowedPortalUrl('http://169.254.169.254/latest/meta-data',{baseUrl:'http://169.254.169.254',allowTestOrigin:true}));
});
test('account responses contain configuration state and never stored secrets',()=>{
  const row=publicAccount({id:3,vendor_id:2,label:'Main login',username:'fixture-user',encrypted_secret:{data:'ciphertext'},active:true});
  assert.equal(row.configured,true); assert.equal(row.username,'fixture-user');
  assert.equal(JSON.stringify(row).includes('ciphertext'),false); assert.equal('encrypted_secret' in row,false); assert.equal('password' in row,false);
});
test('credential and bearer values are redacted from recorded failures',()=>{
  const message=sanitizeFailure(new Error('Login rejected fixture-password; Authorization: Bearer sensitive-token; Cookie: abc=secret'),['fixture-password']);
  for(const secret of ['fixture-password','sensitive-token','abc=secret']) {assert.equal(message.includes(secret),false);}
});
test('only SCM and admin roles may use Stock Check or read evidence',()=>{
  for(const actor of [{role:'admin'},{role:'scm'},{roles:['sales','SCM Staff']}]) {assert.equal(canUseStockCheck(actor),true);}
  for(const actor of [null,{role:'sales'},{role:'dispatcher'},{role:'yard_manager'},{role:'mbr_sales'}]) {assert.equal(canUseStockCheck(actor),false);}
});
test('exact vendor identifiers may contain spaces without accepting markup or URL control characters',()=>{
  const input={sku:'RM-PCKG 03 SPC01',name:'U-Cara package',pickupLocation:'Pickering',url:'https://ontario.order.unilock.com/products/products/u-cara-fascia?child=RM-PCKG+03+SPC01'};
  assert.equal(normalizeProduct(input).sku,'RM-PCKG 03 SPC01');
  for(const sku of ['SKU<script>','SKU/../../','SKU?token=1']) {assert.throws(()=>normalizeProduct({...input,sku}));}
});
