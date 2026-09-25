import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { quotePdf } from '../../src/field-sales/pdf.js';
import { calculateQuote } from '../../public/field-sales/domain.js';
import { pdfText } from './pdf-text.js';
function sample(n=2){
 const lines=Array.from({length:n},(_,i)=>({id:String(i),company:'MBBS',itemId:'1',sku:`ROOFING-${i}`,description:'Oakridge Brownwood 建筑材料',unit:'BDL',quantity:i?'10':'120',unitRate:i?'38.99':'36.99'}));
 return {number:'FS-MBBS-000123',company:'MBBS',selected_revision:1,posting:[],snapshot:{...calculateQuote({lines},{MBBS:{taxBps:1300}}),schemaVersion:2,company:'MBBS',customerName:'Example Builder',phone:'416-555-0100',jobsite:{address:'90 Belfield Road'},billToAddress:'3445 Kennedy Road\nToronto ON',shipToAddress:'90 Belfield Road',quoteDate:'2026-09-21',validUntil:'2026-10-21',expectedClose:'2026-10-01',salesRep:'George',shippingMethod:'Delivery',note:'看见红单才上货',companyProfiles:{MBBS:{name:'Mr Bin Building Supply LTD',taxNumber:'719366486',address:'3445 Kennedy Road\nToronto ON M1V 4Y3',phone:'416-912-9555',terms:'Quoted prices in CAD.'}}}};
}
test('Sample-style company PDF emits correct amounts, Chinese text, billing and signature fields',async()=>{
 const pdf=await quotePdf(sample()),text=pdfText(pdf);
 for(const value of ['Mr Bin Building Supply LTD','Bill To','Ship To','4,828.70','627.73','5,456.43','看见红单才上货','Print Name','Signature','George']){assert.ok(text.includes(value),`PDF contains ${value}`);}
 assert.ok(!text.includes('PLT'));assert.ok(!text.includes('Not published to NetSuite'));
 assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,1,'Sample has no extra footer page');
 const dir=process.env.FIELD_SALES_ARTIFACT_DIR;if(dir){await mkdir(dir,{recursive:true});await writeFile(dir+'/company-quote.pdf',pdf);}
});
test('Long company PDF repeats table headings, includes the final item and respects template visibility',async()=>{
 const q=sample(55);q.snapshot.companyProfiles.MBBS.visible={signature:false};
 const pdf=await quotePdf(q),text=pdfText(pdf);
 assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>1);
 assert.ok(text.includes('ROOFING-54'));assert.ok(text.split('Quantity').length>2);assert.ok(!text.includes('Signature'));
 await assert.rejects(quotePdf(q,'MBT'),/company|revision/i);
});
