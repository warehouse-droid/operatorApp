import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {quotePdf,purchaseOrderPdf} from '../../src/repair/pdf.js';
const directory='/app/test-artifacts/repair-pdf-layout';
after(async()=>{if(process.env.REPAIR_FLOW_PREVIEW==='pdf'){console.log('PDF_LAYOUT_PREVIEW_READY');await new Promise(resolve=>setTimeout(resolve,45000));}});
const line=index=>({id:'line-'+index,kind:'part',description:`ITEM-${String(index).padStart(3,'0')} Hydraulic hose assembly, inspection and fitting for the selected equipment`,quantityMilli:2000,unitMinor:2500,amountMinor:5000,taxBps:1300,taxMinor:650,decision:'pending'});
const job={id:'job',number:'REP-0000123',requestNumber:'REP-0000123',jobNumber:'REP-0000123-J01',company:'MBBS',createdAt:'2026-10-29T12:00:00Z',inspectionFeeMinor:15000,inspectionTaxBps:1300,data:{defect:'Hydraulic leak requires replacement and pressure testing.',vehicle:{alias:'Forklift 12',plate:'YARD-12',serial:'SN-1200'}}};
async function inspect(bytes,name){await fs.mkdir(directory,{recursive:true});const path=`${directory}/${name}.pdf`;await fs.writeFile(path,bytes);const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'}),info=execFileSync('pdfinfo',[path],{encoding:'utf8'}),pages=Number(info.match(/Pages:\s+(\d+)/u)[1]);return {path,text,pages};}
test('designed quote and PO have branded hierarchy, aligned columns and original order amounts',async()=>{
 const quote=await inspect(await quotePdf({job,quote:{id:'quote',scopeNumber:1,scopeRevision:2,version:2,status:'pending',lines:[line(1),line(2)]}}),'quote');assert.match(quote.text,/QUOTATION/u);for(const title of ['Description','Qty','Unit rate','Tax','Amount','Subtotal','Inspection credit'])assert.ok(quote.text.includes(title),title);assert.match(quote.text,/Forklift 12/u);assert.match(quote.text,/REP-0000123/u);assert.equal(quote.pages,1);
 const po=await inspect(await purchaseOrderPdf({id:'po',number:'PUR-1',purchaseDate:'2026-10-29',stage:'po_placed',vendorId:'12821',data:{poNumber:'PO-0000123',vendorName:'Industrial supplier',requestNumber:'REP-0000123',jobNumber:'REP-0000123-J01',equipment:'Forklift 12',eta:'2026-11-02'},lines:[{...line(1),orderedUnitMinor:2500,unitMinor:2900,orderedTaxBps:1300}]}),'purchase-order');assert.match(po.text,/PURCHASE ORDER/u);for(const title of ['Description','Qty','Unit rate','Tax','Amount','Subtotal','Expected arrival'])assert.ok(po.text.includes(title),title);assert.match(po.text,/Industrial supplier/u);assert.match(po.text,/56\.50/u);assert.doesNotMatch(po.text,/58\.00/u);assert.equal(po.pages,1);
 for(const document of [quote,po])execFileSync('pdftoppm',['-f','1','-singlefile','-png','-r','100',document.path,document.path.slice(0,-4)]);
});
test('long multi-page PDFs repeat headers and page numbers without losing line items or clipping text',async()=>{
 const lines=Array.from({length:70},(_,i)=>line(i+1));lines[10].description+=' '+('A long technical description with installation and safety checks. '.repeat(25));
 for(const [name,bytes,heading] of [['quote-long',await quotePdf({job,quote:{id:'quote',scopeNumber:1,scopeRevision:1,status:'pending',lines}}),'QUOTATION'],['po-long',await purchaseOrderPdf({id:'po',purchaseDate:'2026-10-29',vendorId:'12821',data:{poNumber:'PO-0000123',vendorName:'Industrial supplier',equipment:'Forklift 12',jobNumber:'REP-0000123-J01',eta:'2026-11-02'},lines}),'PURCHASE ORDER']]){
  const doc=await inspect(bytes,name);assert.ok(doc.pages>=3);assert.equal(doc.text.split(heading).length-1,doc.pages);assert.equal((doc.text.match(/Description\s+Qty/gu)||[]).length,doc.pages);for(let i=1;i<=70;i++)assert.ok(doc.text.includes(`ITEM-${String(i).padStart(3,'0')}`),name+' missing row '+i);for(let i=1;i<=doc.pages;i++)assert.ok(doc.text.includes(`Page ${i} of ${doc.pages}`));
  const bbox=execFileSync('pdftotext',['-bbox',doc.path,'-'],{encoding:'utf8'});for(const word of bbox.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/gu)){assert.ok(Number(word[1])>=35&&Number(word[3])<=577,'text outside horizontal margins');assert.ok(Number(word[2])>=20&&Number(word[4])<=780,'text outside page');}
 }
});
test('large valid totals fit on one line inside the designed total box',async()=>{
 const huge={...line(1),quantityMilli:1000,unitMinor:600000000000,amountMinor:600000000000,taxMinor:78000000000};
 for(const [name,bytes] of [['quote-large',await quotePdf({job,quote:{id:'quote',scopeNumber:1,scopeRevision:1,status:'pending',lines:[huge]}})],['po-large',await purchaseOrderPdf({id:'po',purchaseDate:'2026-10-29',vendorId:'12821',data:{poNumber:'PO-0000123',vendorName:'Supplier',equipment:'Forklift 12',eta:'2026-11-02'},lines:[huge]})]]){
  const doc=await inspect(bytes,name),bbox=execFileSync('pdftotext',['-bbox',doc.path,'-'],{encoding:'utf8'}),words=[...bbox.matchAll(/<word[^>]*yMin="([\d.]+)"[^>]*>([^<]+)<\/word>/gu)];const currency=words.find(w=>w[2]==='CAD'),total=words.find(w=>w[2]==='$6,780,000,000.00');assert.ok(currency&&total,'complete total remains readable');assert.equal(currency[1],total[1],'currency and amount stay on the same line');
 }
});
