import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { calculateQuote,requireFieldSales } from '../../public/field-sales/domain.js';
const policies={MBBS:{taxBps:1300},MBT:{taxBps:1300},MBR:{taxBps:1300}};
const rounded=(n,d)=>n/d+(n%d*2n>=d?1n:0n);
test('property exact independent rational oracle bounds fractional line and company tax totals',()=>{
  fc.assert(fc.property(fc.array(fc.record({company:fc.constantFrom('MBBS','MBR','MBT'),q:fc.integer({min:1,max:1000000}),rate:fc.integer({min:0,max:1000000})}),{minLength:1,maxLength:50}),rows=>{
    const lines=rows.map((r,i)=>({id:String(i),company:r.company,itemId:'1',description:'Item',quantity:(r.q/1000).toFixed(3),unitRate:(r.rate/10000).toFixed(4)}));
    const actual=calculateQuote({lines},policies),expected={};
    rows.forEach((r,i)=>{const cents=rounded(BigInt(r.q)*BigInt(r.rate),100000n);assert.equal(actual.lines[i].amountMinor,Number(cents));expected[r.company]=(expected[r.company]||0n)+cents;});
    let total=0n;for(const [company,subtotal] of Object.entries(expected)){const tax=rounded(subtotal*1300n,10000n);assert.equal(actual.companies[company].subtotalMinor,Number(subtotal));assert.equal(actual.companies[company].taxMinor,Number(tax));total+=subtotal+tax;}
    assert.equal(actual.totalMinor,Number(total));
  }),{numRuns:600,seed:20260918});
});
test('property invalid quantities always fail and zero-priced positive quantities succeed',()=>{
  fc.assert(fc.property(fc.constantFrom('0','-1','NaN','Infinity','1e3','1.0000001'),value=>assert.throws(()=>calculateQuote({lines:[{company:'MBBS',itemId:'1',description:'A',quantity:value,unitRate:'1'}]},policies))),{numRuns:100,seed:44});
  fc.assert(fc.property(fc.integer({min:1,max:10000}),q=>assert.equal(calculateQuote({lines:[{company:'MBBS',itemId:'1',description:'A',quantity:String(q),unitRate:'0'}]},policies).totalMinor,0)),{numRuns:100,seed:45});
});
test('property staff roles and public sessions never confer unintended Field Sales access',()=>{
  fc.assert(fc.property(fc.constantFrom('operator','dispatcher','sales','field_sales','admin','mbt_frontdesk'),fc.boolean(),(role,publicSales)=>{
    const actor={id:'rep',role,publicSales},allowed=!publicSales&&['field_sales','admin'].includes(role);
    if(allowed){assert.equal(requireFieldSales(actor),actor);}else {assert.throws(()=>requireFieldSales(actor));}
  }),{numRuns:100,seed:46});
});
