import PDFDocument from 'pdfkit';
import { companyQuotePdf } from './company-pdf.js';
import { COMPANIES, fail } from '../../public/field-sales/domain.js';

export function quotePdf(quote, company) {
  if([2,3].includes(quote.snapshot.schemaVersion)){return companyQuotePdf(quote,company);}
  if(company&&!COMPANIES.includes(company)){return Promise.reject(fail('Unknown quote company.'));}
  const s=quote.snapshot,selected=company?[company]:Object.keys(s.companies);
  if(company&&!s.companies[company]){return Promise.reject(fail('This revision has no lines for that company.',404));}
  const published=quote.posting?.length>0&&quote.posting.every(p=>p.state==='done');
  const money=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(n/100);
  const rate=value=>new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD',minimumFractionDigits:2,maximumFractionDigits:6}).format(Number(value));
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'LETTER',margin:45,bufferPages:true,info:{Title:`${quote.number} revision ${quote.selected_revision}`}}),buffers=[];
    doc.on('data',b=>buffers.push(b));doc.on('end',()=>resolve(Buffer.concat(buffers)));doc.on('error',reject);
    const room=height=>{if(doc.y+height>715){doc.addPage();}};
    doc.fillColor('#153f38').font('Helvetica-Bold').fontSize(26).text('QUOTATION');
    doc.fillColor('#222222').fontSize(12).text(`${quote.number} · Revision ${quote.selected_revision}`);
    doc.font('Helvetica').fontSize(10).text(published?'Published to NetSuite':'DRAFT · Not published to NetSuite');doc.moveDown();
    doc.font('Helvetica-Bold').text(s.customerName);doc.font('Helvetica').text(s.contact||'').text(s.email||'');
    doc.text(`Jobsite: ${s.jobsite.address}`);if(s.validUntil){doc.text(`Valid until: ${s.validUntil}`);}doc.moveDown();
    for(const c of selected) {
      const profile=s.companyProfiles?.[c]||{},totals=s.companies[c];room(100);
      doc.fillColor('#153f38').font('Helvetica-Bold').fontSize(14).text(profile.name||c);doc.fillColor('#222222').font('Helvetica').fontSize(9).text(profile.address||'');doc.moveDown(.5);
      for(const line of s.lines.filter(l=>l.company===c)) {
        const label=`${line.sku?`${line.sku} · `:''}${line.description}`;
        room(doc.heightOfString(label,{width:510})+42);
        doc.font('Helvetica-Bold').fontSize(10).text(label,{width:510});doc.font('Helvetica').fontSize(10).text(`${line.quantity} ${line.unit||'units'} × ${rate(line.unitRate)}    ${money(line.amountMinor)}`,{align:'right'});doc.moveDown(.6);
      }
      room(80);doc.text(`Subtotal ${money(totals.subtotalMinor)}`,{align:'right'}).text(`Tax (${totals.taxBps/100}%) ${money(totals.taxMinor)}`,{align:'right'});doc.font('Helvetica-Bold').text(`${c} total ${money(totals.totalMinor)}`,{align:'right'});doc.font('Helvetica').moveDown();
      if(profile.terms){room(50);doc.fontSize(9).text(profile.terms);doc.moveDown();}
    }
    room(70);doc.font('Helvetica-Bold').fontSize(16).text(`Total CAD ${money(company?s.companies[company].totalMinor:s.totalMinor)}`,{align:'right'});
    if(s.note){doc.moveDown();doc.font('Helvetica').fontSize(10).text(s.note);}
    const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.font('Helvetica').fontSize(8).fillColor('#666666').text(`${quote.number} / r${quote.selected_revision} · ${company||'Combined'} · ${i+1}/${pages.count}`,45,747,{lineBreak:false});}
    doc.end();
  });
}
