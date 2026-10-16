import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
import {agreementParagraphs} from './agreement.js';

function signatureRecord(document,snapshot,signature) {
  if(document.y>540) {document.addPage();}
  if(!snapshot.signature) {
    document.font('bold').fontSize(11).text('Unsigned agreement — pending customer signature');
    document.font('regular').fontSize(9).text('The protection plan choice and agreement consent will be recorded when the customer signs.');
    return;
  }
  document.font('bold').fontSize(11).text('Electronic signature record');
  document.font('regular').fontSize(9).text(`Signed by: ${snapshot.signature.signerName}\nSigned at: ${snapshot.signature.signedAt} (UTC)\n${snapshot.signature.protectionPlanAccepted?'Accept':'Decline'} Rental Protection Plan — 15% of applicable rental charges.\nFull rental agreement accepted, including sections 4 and 13.`);
  document.image(signature,40,document.y+6,{fit:[280,100]});
}

export function renderContractPdf({number,revision,snapshot,signature}) {
  return new Promise((resolve,reject)=>{
    const document=new PDFDocument({size:'LETTER',margins:{left:40,right:40,top:42,bottom:48},bufferPages:true,
      info:{Title:`${number} — Rental Agreement`,Author:'Mr. Bin Equipment Rental Inc.'}}),chunks=[];
    document.on('data',chunk=>chunks.push(chunk));document.on('error',reject);
    document.on('end',()=>resolve(Buffer.concat(chunks)));
    try {
      document.registerFont('regular',fileURLToPath(new URL('../field-sales/fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
      document.registerFont('bold',fileURLToPath(new URL('../field-sales/fonts/NotoSansCJKsc-Bold.otf',import.meta.url)));
      document.image(fileURLToPath(new URL('../../public/mbr/logo.png',import.meta.url)),40,20,{fit:[125,76]});
      document.font('bold').fontSize(15).text('Equipment Rental Agreement',180,32,{width:385});
      document.font('regular').fontSize(9).text(`${number} · Revision ${revision} · CAD`,180,58,{width:385});
      document.y=105;
      for(const [index,paragraph] of agreementParagraphs(snapshot).entries()) {
        if(index===0) {continue;}
        const heading=/^\d+\. /u.test(paragraph);
        document.font(heading?'bold':'regular').fontSize(heading?10:9.5);
        if(heading && document.y>690) {document.addPage();}
        document.text(paragraph,40,document.y,{width:532,lineGap:2,paragraphGap:5});
        document.moveDown(heading?0.3:0.6);
      }
      signatureRecord(document,snapshot,signature);
      const pages=document.bufferedPageRange();
      for(let index=0;index<pages.count;index+=1) {
        document.switchToPage(index);
        document.font('regular').fontSize(8).text(`${number} · Revision ${revision} · ${index+1}/${pages.count}`,40,756,{lineBreak:false});
      }
      document.end();
    } catch(error) {document.destroy();reject(error);}
  });
}
