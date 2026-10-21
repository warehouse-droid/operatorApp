import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFileSync,mkdirSync} from 'node:fs';
import fc from 'fast-check';
import {buildSpecialQuote,createSpecialQuoteService} from '../../../src/special-stock-documents.js';
import {quotePdf} from '../../../src/field-sales/pdf.js';
import {pdfText,pdfPages} from '../../field-sales/pdf-text.js';

const profile={name:'Mr Bin Building Supply LTD',address:'3445 Kennedy Road, Toronto',phone:'416-555-0100',taxBps:1300,validityDays:30};
const packs={palletQty:2,layerQty:3.5,sectionQty:4,pieceQty:6};
const detail=()=>({requestRef:'SPREQ-PACK-SAMPLE',revision:2,customerName:'Example Landscaping',requestedByName:'Example Sales',inquiryDate:'2026-09-29',storeLocationId:1,storeName:'3445',vendorName:'Example vendor',fulfillmentMethod:'yard_pickup',
 lines:[{id:10,productName:'Natural stone coping 建筑材料',color:'Buff',size:'12 × 24 in',quantity:2,packageQuantity:2,uom:'PLT',rateUom:'PLT',rate:520,originalRate:520,discountPercent:5,requiredDate:'2099-10-01',...packs}],salesOrderLines:[]});
for(const draft of [true,false])test(`${draft?'draft':'saved'} special quote carries exact packing quantities without changing price`,async()=>{
 const input=detail();input.lines[0].scmInternalNote='PRIVATE';input.lines[0].unitPurchaseCost=987654;
 const quote=buildSpecialQuote(input,profile,{draft});
 assert.equal(quote.snapshot.showPackQuantities,true);assert.deepEqual(quote.snapshot.lines[0].packQuantities,packs);
 assert.equal(quote.snapshot.subtotalMinor,98800);assert.equal(quote.snapshot.taxMinor,12844);assert.equal(quote.snapshot.totalMinor,111644);
 const buffer=await quotePdf(quote),text=pdfText(buffer);
 for(const label of ['PLT','LYR','SEC','PCS','3.5','建筑材料','988.00','1,116.44'])assert(text.includes(label),label);
 assert.doesNotMatch(text,/PRIVATE|987654/);assert.equal(pdfPages(buffer).length,1);
 if(process.env.SPECIAL_PACK_OUTPUT){mkdirSync(process.env.SPECIAL_PACK_OUTPUT,{recursive:true});writeFileSync(`${process.env.SPECIAL_PACK_OUTPUT}/${draft?'draft':'saved'}-quote.pdf`,buffer);}
});
test('saved quotes retain ancillary packing and render missing or zero pack quantities blank',()=>{
 const input=detail();input.lines[0].palletQty=0;input.lines[0].layerQty=null;delete input.lines[0].sectionQty;
 input.salesOrderLines=[{caseLineId:10,description:'Reviewed stone'},
  {ancillary:true,description:'PALLET',quantity:2,uom:'EACH',rate:40,pieceQty:2}];
 const quote=buildSpecialQuote(input,profile);
 assert.deepEqual(quote.snapshot.lines[0].packQuantities,{palletQty:null,layerQty:null,sectionQty:null,pieceQty:6});
 assert.deepEqual(quote.snapshot.lines[1].packQuantities,{palletQty:null,layerQty:null,sectionQty:null,pieceQty:2});
 const legacy=detail();delete legacy.lines[0].originalRate;
 for(const key of Object.keys(packs))delete legacy.lines[0][key];
 legacy.salesOrderLines=[{caseLineId:10,quantity:2,uom:'PLT',rate:520,...packs}];
 assert.deepEqual(buildSpecialQuote(legacy,profile).snapshot.lines[0].packQuantities,packs);
});
test('quote preview service preserves packing through normalized draft input',async()=>{
 let snapshot;
 const service=createSpecialQuoteService({getProfile:async()=>profile,renderPdf:async quote=>{snapshot=quote.snapshot;return Buffer.from('pdf');}});
 await service.previewDraft(detail(),{operatorName:'Example Sales',authorizedStoreLocationIds:[1]});
 assert.deepEqual(snapshot.lines[0].packQuantities,packs);
});
test('property: pack counts are independent of quoted sales quantity and totals',()=>{
 const count=fc.integer({min:0,max:1000000000}).map(value=>value/1000);
 fc.assert(fc.property(fc.record({palletQty:count,layerQty:count,sectionQty:count,pieceQty:count}),fc.boolean(),(packing,draft)=>{
  const input=detail();Object.assign(input.lines[0],packing);
  const quote=buildSpecialQuote(input,profile,{draft});
  assert.deepEqual(quote.snapshot.lines[0].packQuantities,Object.fromEntries(Object.entries(packing).map(([field,value])=>[field,value===0?null:value])));assert.equal(quote.snapshot.showPackQuantities,true);
  assert.equal(quote.snapshot.lines[0].quantity,'2');assert.equal(quote.snapshot.totalMinor,111644);
 }),{seed:296744,numRuns:150});
});
test('property: rendered PDFs place PLT, SEC, LYR and PCS in the matching NetSuite columns',async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:0,max:999}),async count=>{
  const input=detail();Object.assign(input.lines[0],{palletQty:count,sectionQty:count+1,layerQty:count+0.25,pieceQty:count+2});
  const text=pdfText(await quotePdf(buildSpecialQuote(input,profile)));
  assert(text.includes('AmountPLTSECLYRPCS'));
  assert(text.includes(`1,040.00${count===0?'':count}${count+1}${count+0.25}${count+2}`));
 }),{seed:296745,numRuns:8});
});
test('multi-page special PDFs repeat packing headings and retain last item and boundary counts',async()=>{
 const input=detail();input.lines=Array.from({length:35},(_,i)=>({...input.lines[0],id:i+1,productName:`Stone-${i+1} 建筑材料`,palletQty:i===34?1000000000:i,layerQty:0.125,sectionQty:0,pieceQty:7}));
 const pdf=await quotePdf(buildSpecialQuote(input,profile)),pages=pdfPages(pdf),text=pdfText(pdf);
 assert(pages.length>1);assert(text.includes('Stone-35'));assert(text.includes('1000000000'));assert(text.includes('0.125'));
 for(const page of pages.filter(page=>page.includes('Stone-')))for(const label of ['PLT','SEC','LYR','PCS'])assert(page.includes(label),label);
 if(process.env.SPECIAL_PACK_OUTPUT)writeFileSync(`${process.env.SPECIAL_PACK_OUTPUT}/multipage-quote.pdf`,pdf);
});
