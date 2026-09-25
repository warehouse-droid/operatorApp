import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { COMPANIES,fail } from '../../public/field-sales/domain.js';
import { quoteProfile } from './company-quotes.js';

// Code 128 B symbol widths, including start and stop. Quote references are ASCII.
const patterns='212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
export function barcodeSymbols(value) {
 if(!/^[\x20-\x7e]{1,60}$/.test(value)){throw fail('Invalid quote barcode reference.');}
 const codes=[104,...Array.from(value,c=>c.charCodeAt(0)-32)],check=codes.reduce((n,c,i)=>n+c*(i||1),0)%103;
 return [...codes,check,106].map(c=>patterns[c]);
}
function barcode(doc,value,x,y,width,height){
 const bars=barcodeSymbols(value),units=bars.join('').split('').reduce((n,v)=>n+Number(v),0),scale=width/(units+20);let pos=x+scale*10;
 doc.fillColor('#000');for(const symbol of bars){for(let i=0;i<symbol.length;i++){const w=Number(symbol[i])*scale;if(i%2===0){doc.rect(pos,y,w,height).fill();}pos+=w;}}
}
const money=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(n/100);
const rate=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',minimumFractionDigits:2,maximumFractionDigits:6}).format(Number(n));
export function companyQuotePdf(quote,company) {
 const s=quote.snapshot,combined=s.schemaVersion===3;
 if(company&&(!COMPANIES.includes(company)||combined&&!s.companies[company]||!combined&&company!==s.company)){return Promise.reject(fail('This revision has no document for that company.',404));}
 const selected=combined?COMPANIES.filter(c=>s.companies[c]&&(!company||c===company)):[s.company];
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({autoFirstPage:false,size:'LETTER',margins:{left:36,right:36,top:52,bottom:96},bufferPages:true,info:{Title:`${quote.number} revision ${quote.selected_revision}`}}),parts=[];
  doc.on('data',b=>parts.push(b));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);
  for(const [key,name] of [['regular','Regular'],['bold','Bold']]){doc.registerFont(key,fileURLToPath(new URL(`./fonts/NotoSansCJKsc-${name}.otf`,import.meta.url)));}
  const sections=selected.map(c=>renderCompany(doc,{...quote,parentNumber:quote.number,number:s.documents?.[c]?.number||quote.number,snapshot:{...s,company:c,validUntil:s.documents?.[c]?.validUntil||s.validUntil,lines:s.lines.filter(l=>l.company===c)}}));
  const pages=doc.bufferedPageRange();
  for(const section of sections){for(let i=section.start;i<section.end;i++){
   doc.switchToPage(i);doc.font('regular').fontSize(8).fillColor('#444');
   doc.text(`${quote.number} · Revision ${quote.selected_revision} · ${i+1}/${pages.count}`,36,775,{lineBreak:false});
   if(i===section.end-1){
    if(section.profile.visible.signature){doc.font('bold').fontSize(9).text('Print Name: ___________________',36,716,{lineBreak:false}).text('Signature: ___________________',306,716,{lineBreak:false});}
    if(section.profile.visible.barcode){barcode(doc,section.number,394,744,182,24);doc.font('regular').fontSize(7);doc.text(section.number,485-doc.widthOfString(section.number)/2,770,{lineBreak:false});}
   }
   if(combined&&i===pages.count-1){doc.font('bold').fontSize(10).fillColor('#222').text(`Quote total CAD ${money(company?s.companies[company].totalMinor:s.totalMinor)}`,36,748,{lineBreak:false});}
  }}
  doc.end();
 });
}
function renderCompany(doc,quote){
 const s=quote.snapshot,profile=quoteProfile(s.companyProfiles?.[s.company]),totals=s.companies[s.company]||{subtotalMinor:0,taxMinor:0,totalMinor:0,taxBps:profile.taxBps||0};
 const start=doc.bufferedPageRange().count;doc.addPage();
  const text=(value,x,y,width,size=9,bold=false,align='left')=>doc.fillColor('#222').font(bold?'bold':'regular').fontSize(size).text(String(value||''),x,y,{width,align,lineGap:1});
  const continuation=()=>{text(profile.name||s.company,36,22,290,10,true);text(`${quote.number} · r${quote.selected_revision}`,326,22,250,10,false,'right');doc.y=52;};
  doc.on('pageAdded',continuation);
  text(profile.name||s.company,36,29,240,12);let left=doc.y+2;
  if(profile.taxNumber){text(`HST NO: ${profile.taxNumber}`,36,left,240);left=doc.y;}
  text(profile.address,36,left,240);text(profile.phone,36,doc.y,240);
  text('Quote',280,28,125,22);text(quote.number,330,57,246,14,false,'right');text(s.quoteDate,420,82,156,9,false,'right');
  if(s.schemaVersion===3){text(`Quote ${quote.parentNumber}`,330,99,246,8,false,'right');}
  let metaY=115;
  for(const [key,label,value] of [['expires','Expires',s.validUntil],['expectedClose','Exp. Close',s.expectedClose],['salesRep','Sales Rep',s.salesRep],['shippingMethod','Shipping Method',s.shippingMethod]]){
   if(profile.visible[key]&&!(s.simpleDetails&&key==='expectedClose')){text(label,36,metaY,102,9,true);text(value,140,metaY,133);metaY=Math.max(metaY+16,doc.y+2);}
  }
  let infoBottom=metaY;
  const details=s.simpleDetails?[[286,'Customer',[s.customerName,s.contact,s.phone,s.email].filter(Boolean).join('\n')],[434,'Jobsite',s.jobsite.address]]:[[286,'Bill To',[s.customerName,s.contact,s.phone,s.email,s.billToAddress].filter(Boolean).join('\n')],[434,'Ship To',s.shipToAddress||s.jobsite.address]];
  for(const [x,label,body] of details){
   doc.rect(x,110,142,18).fill('#d4d4d4');text(label,x+5,113,132,8,true);text(body,x+5,132,132,8);infoBottom=Math.max(infoBottom,doc.y);
  }
  let y=Math.max(207,infoBottom+18);
  const tableHeader=()=>{doc.rect(36,y,540,23).fill('#e4e4e4');for(const [label,x,w,align] of [['Quantity',40,51,'right'],['UOM',98,38,'left'],['Item',142,256,'left'],['Rate',404,72,'right'],['Amount',482,89,'right']]){text(label,x,y+5,w,8,true,align);}y+=28;};
  const newPage=()=>{doc.addPage();y=58;tableHeader();};
  tableHeader();
  for(const line of s.lines){
   doc.font('regular').fontSize(9);const height=Math.max(30,doc.heightOfString(line.description,{width:254})+24);
   if(y+height>675){newPage();}
   text(line.quantity,40,y,51,9,false,'right');text(line.unit,98,y,38,8);text(line.sku,142,y,254,9,true);text(line.description,142,y+14,254,9);
   text(rate(line.unitRate),404,y,72,9,false,'right');text(money(line.amountMinor),482,y,89,9,false,'right');y+=height;
   doc.moveTo(36,y-4).lineTo(576,y-4).strokeColor('#ddd').lineWidth(.5).stroke();
  }
  if(y+80>675){doc.addPage();y=58;}y+=8;
  for(const [label,value,total] of [['Subtotal',totals.subtotalMinor,false],[`HST (${totals.taxBps/100}%)`,totals.taxMinor,false],['Total CAD',totals.totalMinor,true]]){
   if(total){doc.rect(36,y-2,540,24).fill('#e4e4e4');}
   text(label,330,y+2,143,9,true,'right');text(money(value),482,y+2,89,9,total,'right');y+=24;
  }
  doc.font('regular').fontSize(9);doc.y=y+10;
  if(s.note){doc.text(`Note: ${s.note}`,36,doc.y,{width:540});doc.moveDown();}
  if(profile.terms){doc.text(profile.terms,36,doc.y,{width:540});}
  doc.removeListener('pageAdded',continuation);
  return {start,end:doc.bufferedPageRange().count,profile,number:quote.number};
}
