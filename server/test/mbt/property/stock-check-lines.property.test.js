import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {lineFingerprint,matchLineProducts,isUnilock} from '../../../src/stock-check/line-matching.js';
const line={vendorName:'Unilock Ltd',productName:'Endura Coping Oat Beige',color:'Oat Beige',size:'24 x 14',detailSpec:'',quantity:1,uom:'PCS'};
test('property: a unique exact SKU is independent of catalogue order and duplicate variants never auto-select',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:999999}),fc.boolean(),(value,reverse)=>{
    const product={id:1,sku:'SKU-'+value,name:'Fixture coping',colour:'',size:''},other={...product,id:2,sku:'SKU-X'+value};
    const products=reverse?[other,product]:[product,other],input={...line,productName:product.sku,color:'',size:''};
    assert.equal(matchLineProducts(input,products).product.id,1);
    assert.equal(matchLineProducts(input,[product,{...product,id:3}]).product,null);
  }),{seed:20261014,numRuns:100});
});
test('property: material changes invalidate fingerprints and manual ETA/pickup edits do not',()=>{
  fc.assert(fc.property(fc.string({minLength:1,maxLength:100}),fc.integer({min:2,max:99999}),(text,quantity)=>{
    const original=lineFingerprint(line);
    assert.equal(lineFingerprint({...line,availableDate:text,vendorYard:text,supplyStatus:'production'}),original);
    assert.notEqual(lineFingerprint({...line,productName:line.productName+text}),original);
    assert.notEqual(lineFingerprint({...line,quantity}),original);
    assert.match(original,/^[a-f0-9]{64}$/u);
  }),{seed:20261014,numRuns:100});
});
test('Unilock names are recognized explicitly and incomplete descriptions remain choices',()=>{
  for(const name of ['Unilock',' unilock LTD. ','Unilock Ontario']) {assert.equal(isUnilock(name),true);}
  for(const name of ['Not Unilock','Other Vendor','Unilock substitute',null]) {assert.equal(isUnilock(name),false);}
  const product={id:1,sku:'EXACT-1',name:line.productName,colour:line.color,size:line.size};
  assert.equal(matchLineProducts(line,[product]).product.id,1);
  assert.equal(matchLineProducts({...line,color:''},[product]).product,null);
  assert.equal(matchLineProducts({...line,size:''},[product]).product,null);
});
