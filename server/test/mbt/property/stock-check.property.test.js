import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {validateQuantity,stockVerdict,normalizeProduct,publicAccount,PICKUP_LOCATIONS,normalizeSearch,parseAvailability} from '../../../src/stock-check/domain.js';
import {sealCredentials,openCredentials} from '../../../src/stock-check/vault.js';
const settings={seed:288,numRuns:150};
test('pallet quantity validation accepts exactly the allowed positive whole-number domain',()=>{
  fc.assert(fc.property(fc.integer({min:-100000,max:200000}),value=>{
    if(value>=1&&value<=99999) {assert.equal(validateQuantity(value),value);}else {assert.throws(()=>validateQuantity(value));}
  }),settings);assert.throws(()=>validateQuantity(0));
});
test('stock confirmation requires the exact requested cart increment across arbitrary existing quantities',()=>{
  fc.assert(fc.property(fc.nat(100),fc.integer({min:1,max:1000}),fc.integer({min:-10,max:10}),(baseline,requested,offset)=>{
    const verdict=stockVerdict({expectedSku:'EXACT-SKU',requestedQuantity:requested,baselineQuantity:baseline,actionAccepted:true,
      pickupMatches:true,dateMatches:true,cartRows:[{sku:'EXACT-SKU',quantity:baseline+requested+offset,uom:'BNDL',availabilityText:'Available'}]});
    assert.equal(verdict.status,offset===0?'stock_confirmed':'scrape_failure');
    if(offset===0) {assert.equal(verdict.verifiedQuantity,requested);}
  }),settings);
});
test('all displayed Ontario plants map to their own code and normalization remains stable',()=>{
  fc.assert(fc.property(fc.constantFrom(...PICKUP_LOCATIONS),location=>{
    const row=normalizeProduct({sku:'EXACT-SKU',name:'Fixture Paver',pickupLocation:location.name,url:'https://ontario.order.unilock.com/products/products/brussels-block'});
    assert.equal(row.pickupCode,location.code);assert.deepEqual(normalizeProduct(row),row);
  }),settings);
});
test('public account serialization never includes credential payloads or passwords',()=>{
  fc.assert(fc.property(fc.string({minLength:20,maxLength:100}),secret=>{
    const row=publicAccount({id:1,vendor_id:2,label:'Main',username:'fixture-user',encrypted_secret:{data:secret},password:secret});
    assert.equal(JSON.stringify(row).includes(secret),false);assert.equal(Object.hasOwn(row,'encrypted_secret'),false);assert.equal(row.configured,true);
  }),settings);
});
test('encrypted credentials round-trip arbitrary passwords only in their bound vendor and account context',()=>{
  fc.assert(fc.property(fc.string({minLength:1,maxLength:300}),fc.integer({min:1,max:9999}),fc.integer({min:1,max:9999}),(password,vendor,account)=>{
    const key=Buffer.alloc(32,19),secret={username:'fixture-user',password},sealed=sealCredentials(key,secret,vendor,account);
    assert.deepEqual(openCredentials(key,sealed,vendor,account),secret);
    assert.throws(()=>openCredentials(key,sealed,vendor+1,account));assert.throws(()=>openCredentials(key,sealed,vendor,account+1));
  }),settings);
});
test('product-search normalization is idempotent across punctuation and Unicode input',()=>{
  fc.assert(fc.property(fc.string({maxLength:300}),text=>assert.equal(normalizeSearch(normalizeSearch(text)),normalizeSearch(text))),settings);
});
test('accepted quantities confirm immediate stock only for an explicit positive row availability',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000}),fc.constantFrom('Available','In Stock','Production Scheduled for - 2026-10-20','Not available','','Unfamiliar status'),(quantity,text)=>{
    const verdict=stockVerdict({expectedSku:'EXACT-SKU',requestedQuantity:quantity,baselineQuantity:0,actionAccepted:true,pickupMatches:true,dateMatches:true,
      cartRows:[{sku:'EXACT-SKU',quantity,uom:'BNDL',availabilityText:text}]});
    const expected=['Available','In Stock'].includes(text)?'stock_confirmed':text.startsWith('Production')?'in_production':text==='Not available'?'insufficient_stock':'scrape_failure';
    assert.equal(verdict.status,expected);assert.equal(verdict.verifiedQuantity===quantity,expected==='stock_confirmed');
  }),settings);
});
test('production dates remain the vendor-provided ETA and cannot become in-stock evidence',()=>{
  fc.assert(fc.property(fc.integer({min:2026,max:2040}),fc.integer({min:1,max:12}),fc.integer({min:1,max:28}),(year,month,day)=>{
    const eta=year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    const parsed=parseAvailability('Production Scheduled for - '+eta);assert.equal(parsed.status,'in_production');assert.equal(parsed.eta,eta);
  }),settings);
});
