import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,writeFileSync} from 'node:fs';
import fc from 'fast-check';
import {normalizeSpecialCaseDraft} from '../../../src/special-stock-request-domain.js';
import {buildSpecialQuote,createSpecialQuoteService} from '../../../src/special-stock-documents.js';
import {copySpecialRequestDraft} from '../../../public/special-stock-request-actions.js';
import {quotePdf} from '../../../src/field-sales/pdf.js';
import {pdfText} from '../../field-sales/pdf-text.js';

const profile={name:'Mr Bin Building Supply LTD',address:'3445 Kennedy Road, Toronto',phone:'416-555-0100',taxBps:1300,validityDays:30};
const detail=()=>({requestRef:'SPREQ-QUOTE-SAMPLE',revision:1,storeLocationId:1,storeName:'3445',inquiryDate:'2099-01-01',
 customerName:'TEST Quote customer',vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',
 lines:[{id:10,productName:'Stone',quantity:2,packageQuantity:2,uom:'PCS',rateUom:'PCS',rate:100,originalRate:100,discountPercent:10,requiredDate:'2099-02-01',palletQty:8}],salesOrderLines:[]});
const normalize=input=>normalizeSpecialCaseDraft(input,{authorizedStoreLocationIds:[1],minimumRequiredDate:'2099-01-01'});
const isPallet=line=>line.description==='PALLET';
function savePdf(name,pdf){if(process.env.SPECIAL_QUOTE_PALLET_OUTPUT){mkdirSync(process.env.SPECIAL_QUOTE_PALLET_OUTPUT,{recursive:true});writeFileSync(`${process.env.SPECIAL_QUOTE_PALLET_OUTPUT}/${name}.pdf`,pdf);}}

for(const draft of [true,false])test(`${draft?'draft':'saved'} initial quote adds one undiscounted PALLET line before an SO draft exists`,async()=>{
 const input={...detail(),palletTotal:3,palletRate:40},quote=buildSpecialQuote(input,profile,{draft});
 assert.deepEqual(quote.snapshot.lines.filter(isPallet).map(line=>[line.quantity,line.unit,line.unitRate,line.amountMinor]),[['3','EACH','40',12000]]);
 assert.equal(quote.snapshot.grossSubtotalMinor,32000);assert.equal(quote.snapshot.discountMinor,2000);assert.equal(quote.snapshot.discountPercent,6.25);
 assert.equal(quote.snapshot.subtotalMinor,30000);assert.equal(quote.snapshot.taxMinor,3900);assert.equal(quote.snapshot.totalMinor,33900);
 assert.equal(input.lines[0].palletQty,8,'packing count is independent');
 const pdf=await quotePdf(quote),text=pdfText(pdf);assert.match(text,/PALLET/);assert.equal(text.split('PALLET').length,2);
 assert.match(text,/HST \(13%\)\$39\.00Total CAD\$339\.00/);savePdf(draft?'positive-draft':'positive-saved',pdf);
});
for(const draft of [true,false])test(`${draft?'draft':'saved'} zero PALLET quantity omits the line and its charge even when an old draft has PALLET`,async()=>{
 const input={...detail(),palletTotal:0,palletRate:40,salesOrderLines:[{caseLineId:10},{itemId:1784,ancillary:true,description:'PALLET',quantity:3,uom:'EACH',rate:40}]};
 const quote=buildSpecialQuote(input,profile,{draft});assert.equal(quote.snapshot.lines.length,1);assert.equal(quote.snapshot.subtotalMinor,18000);assert.equal(quote.snapshot.taxMinor,2340);assert.equal(quote.snapshot.totalMinor,20340);
 const pdf=await quotePdf(quote);assert.doesNotMatch(pdfText(pdf),/PALLET/);savePdf(draft?'zero-draft':'zero-saved',pdf);
});
test('positive PALLET quantity with an explicit zero rate remains on the quote',()=>{
 const quote=buildSpecialQuote({...detail(),palletTotal:2,palletRate:0},profile);
 assert.equal(quote.snapshot.lines.filter(isPallet).length,1);assert.equal(quote.snapshot.lines.at(-1).unitRate,'0');assert.equal(quote.snapshot.subtotalMinor,18000);
});
test('header PALLET values replace stale duplicate draft charges while unrelated ancillary charges survive',()=>{
 const input={...detail(),palletTotal:3,palletRate:40,salesOrderLines:[{caseLineId:10},
 {itemId:1784,ancillary:true,description:'PALLET',quantity:9,uom:'EACH',rate:999},
 {itemId:1784,ancillary:true,description:'PALLET',quantity:9,uom:'EACH',rate:999},
 {itemId:1987,ancillary:true,description:'Delivery',quantity:1,uom:'EACH',rate:10}]};
 const quote=buildSpecialQuote(input,profile);assert.equal(quote.snapshot.lines.filter(isPallet).length,1);
 assert.equal(quote.snapshot.lines.find(isPallet).amountMinor,12000);assert.equal(quote.snapshot.lines.find(line=>line.description==='Delivery').amountMinor,1000);
 assert.equal(quote.snapshot.subtotalMinor,31000);assert.equal(quote.snapshot.totalMinor,35030);
});
test('legacy requests retain a saved PALLET charge and packing without requiring new inputs',()=>{
 const input=detail();input.salesOrderLines=[{caseLineId:10},{itemId:1784,ancillary:true,description:'PALLET',quantity:2,uom:'EACH',rate:60,pieceQty:2}];
 const quote=buildSpecialQuote(input,profile);assert.equal(quote.snapshot.lines.find(isPallet).amountMinor,12000);assert.equal(quote.snapshot.lines.find(isPallet).packQuantities.pieceQty,2);
 const legacy=normalize(detail());assert.equal(legacy.palletTotal,0);assert.equal(legacy.palletRate,null);
});
test('quote draft normalization and copying retain PALLET quantity and reviewed sales rate',()=>{
 const normalized=normalize({...detail(),palletTotal:'3',palletRate:'40.123456'});assert.equal(normalized.palletTotal,3);assert.equal(normalized.palletRate,40.123456);
 const copied=copySpecialRequestDraft({...detail(),palletTotal:3,palletRate:40},{today:'2099-01-01',expiresOn:'2099-02-01'});
 assert.equal(Number(copied.palletTotal),3);assert.equal(Number(copied.palletRate),40);
});
test('invalid PALLET quantities, rates and overflow cannot be normalized or rendered',()=>{
 for(const value of [-1,1.5,1000000001,'',true,{},[],NaN,Infinity,'invalid'])assert.throws(()=>normalize({...detail(),palletTotal:value,palletRate:40}),{code:'SPECIAL_PALLET_INVALID'});
 for(const value of [-1,1000000001,.1234567,true,{},[],NaN,Infinity,'invalid'])assert.throws(()=>normalize({...detail(),palletTotal:1,palletRate:value}),{code:'SPECIAL_RATE_INVALID'});
 for(const value of [undefined,null,'',' '])assert.throws(()=>normalize({...detail(),palletTotal:1,palletRate:value}),{code:'SPECIAL_PALLET_RATE_REQUIRED'});
 assert.throws(()=>normalize({...detail(),palletTotal:1000000000,palletRate:1000000000}),{code:'SPECIAL_SUBTOTAL_INVALID'});
 assert.throws(()=>buildSpecialQuote({...detail(),palletTotal:1,palletRate:null},profile),{code:'SPECIAL_PALLET_RATE_REQUIRED'});
});
test('real quote preview and saved-quote services carry PALLET to their PDFs without NetSuite',async()=>{
 const input={...detail(),palletTotal:3,palletRate:40};
 const service=createSpecialQuoteService({getProfile:async()=>profile,getCase:async()=>input});
 for(const document of [await service.previewDraft(input,{authorizedStoreLocationIds:[1],minimumRequiredDate:'2099-01-01'}),await service.savedQuote(1,{authorizedStoreLocationIds:[1]})])assert.match(pdfText(document.buffer),/PALLET/);
});
test('property: initial PALLET quotes include the charge exactly once and round HST on the combined subtotal',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:1000}),fc.integer({min:0,max:100000}),fc.boolean(),(count,cents,draft)=>{
  const quote=buildSpecialQuote({...detail(),palletTotal:count,palletRate:cents/100},profile,{draft});
  const subtotal=18000n+BigInt(count)*BigInt(cents),tax=(subtotal*1300n+5000n)/10000n;
  assert.equal(quote.snapshot.lines.filter(isPallet).length,count>0?1:0);
  assert.equal(quote.snapshot.subtotalMinor,Number(subtotal));assert.equal(quote.snapshot.taxMinor,Number(tax));assert.equal(quote.snapshot.totalMinor,Number(subtotal+tax));
  assert.equal(quote.snapshot.discountMinor,2000);assert.equal(quote.snapshot.grossSubtotalMinor,Number(subtotal+2000n));
 }),{seed:2026100151,numRuns:200});
});
test('property: legal whole PALLET counts retain both bounds and copies preserve the selected count and rate',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:1000000000}),fc.integer({min:0,max:1000000}), (count,micros)=>{
  const input={...detail(),palletTotal:count,palletRate:micros/1000000},normalized=normalize(input);
  assert.equal(normalized.palletTotal,count);assert.equal(normalized.palletRate,micros/1000000);
  const copied=copySpecialRequestDraft(input,{today:'2099-01-01',expiresOn:'2099-02-01'});assert.equal(Number(copied.palletTotal),count);assert.equal(Number(copied.palletRate),micros/1000000);
 }),{seed:2026100152,numRuns:200});
});
