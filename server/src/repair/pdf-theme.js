import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
const ink='#302B2C',muted='#756C6C',red='#CF1E28',pale='#F7F3F3',line='#E4DDDD';
export const dollars=value=>`${value<0?'-':''}$${(Math.abs(value)/100).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export const isoDate=value=>value?String(value instanceof Date?value.toISOString():value).slice(0,10):new Date().toISOString().slice(0,10);
export function repairDocument({title,number,date,status}){
 const doc=new PDFDocument({size:'LETTER',margins:{top:36,right:42,bottom:42,left:42},bufferPages:true,info:{Title:`${title} ${number}`,Author:'Mr. Bin Equipment Rental — Repair Centre',Subject:'Repair department document'}}),chunks=[];
 const completed=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
 let y=0,table=false;
 const text=(value,x,top,width,{size=9.5,bold=false,color=ink,align='left',...options}={})=>{doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(color).text(String(value??''),x,top,{width,align,...options});};
 function header(){
  doc.rect(0,0,612,7).fill(red);doc.save().rect(42,26,162,63).clip();doc.image(fileURLToPath(new URL('../../public/mbr/logo.png',import.meta.url)),29,-2,{width:194});doc.restore();
  text('REPAIR CENTRE',43,90,220,{size:8.5,bold:true,color:muted});text(title,275,34,295,{size:24,bold:true,align:'right'});text(number,275,65,295,{size:14,bold:true,align:'right'});text(`Issued ${isoDate(date)}  |  ${status}`,250,88,320,{size:8.5,color:muted,align:'right'});doc.moveTo(42,110).lineTo(570,110).lineWidth(.7).strokeColor(line).stroke();y=126;
 }
 function columns(){doc.roundedRect(42,y,528,27,4).fill(ink);for(const [label,x,w,align] of [['Description',54,216,'left'],['Qty',278,40,'right'],['Unit rate',322,76,'right'],['Tax',402,56,'right'],['Amount',462,96,'right']])text(label,x,y+9,w,{size:8.5,bold:true,color:'white',align});y+=27;}
 function page(){doc.addPage();header();if(table)columns();}
 function ensure(height){if(y+height>710)page();}
 function paragraph(value,{heading,width=528}={}){
  if(heading){ensure(28);text(heading,42,y,width,{bold:true,size:9,color:muted});y+=16;}
  const words=String(value||'').split(/\s+/u);let chunk='';
  for(const word of words){const next=chunk?`${chunk} ${word}`:word;doc.font('Helvetica').fontSize(9.5);const height=doc.heightOfString(next,{width,lineGap:3});if(height>Math.min(450,710-y)&&chunk){text(chunk,42,y,width,{lineGap:3});y+=doc.heightOfString(chunk,{width,lineGap:3})+12;page();chunk=word;}else chunk=next;}
  if(chunk){doc.font('Helvetica').fontSize(9.5);const height=doc.heightOfString(chunk,{width,lineGap:3});ensure(height+12);text(chunk,42,y,width,{lineGap:3});y+=height+14;}
 }
 function info(groups){
  const top=y,width=252,gap=24;let max=0;
  groups.forEach((group,index)=>{const x=42+index*(width+gap);text(group.title.toUpperCase(),x,top,width,{size:8,bold:true,color:red});let at=top+18;for(const item of group.lines.filter(Boolean)){doc.font('Helvetica').fontSize(9.5);const value=String(item),height=doc.heightOfString(value,{width,lineGap:2});text(value,x,at,width,{size:9.5,lineGap:2});at+=height+6;}max=Math.max(max,at-top);});y=top+max+14;
 }
 function fit(value,x,top,width,options={}){let size=options.size||9.2;doc.font(options.bold?'Helvetica-Bold':'Helvetica');while(size>6.5&&doc.fontSize(size).widthOfString(String(value))>width)size-=.25;text(value,x,top,width,{...options,size,align:'right'});}
 function row({description,quantity,rate,tax,amount,index=0}){
  const words=String(description).split(/\s+/u),pieces=[];let chunk='';
  for(const word of words){const next=chunk?chunk+' '+word:word;doc.font('Helvetica').fontSize(9.5);if(doc.heightOfString(next,{width:216,lineGap:2})>360&&chunk){pieces.push(chunk);chunk=word;}else chunk=next;}if(chunk)pieces.push(chunk);
  pieces.forEach((piece,fragment)=>{doc.font('Helvetica').fontSize(9.5);const height=Math.max(39,doc.heightOfString(piece,{width:216,lineGap:2})+18);ensure(height);if(index%2===0)doc.rect(42,y,528,height).fill(pale);text(piece,54,y+10,216,{size:9.5,lineGap:2});if(fragment===0){fit(quantity,278,y+10,40);fit(dollars(rate),322,y+10,76);fit(tax,402,y+10,56);fit(dollars(amount),462,y+10,96);}doc.moveTo(42,y+height).lineTo(570,y+height).lineWidth(.35).strokeColor(line).stroke();y+=height;});
 }
 function beginTable(){ensure(70);table=true;columns();}
 function summary(rows,totalLabel,total,terms){
  const height=rows.length*20+49;ensure(height+25);table=false;y+=18;const top=y;
  text('NOTES & TERMS',42,top,250,{size:8,bold:true,color:red});text(terms,42,top+17,250,{size:8.5,color:muted,lineGap:3});
  for(const [label,value] of rows){text(label,324,y,146,{size:9,color:muted});text(dollars(value),474,y,84,{size:9,align:'right'});y+=20;}
  doc.roundedRect(314,y+2,256,36,4).fill(red);text(totalLabel,326,y+14,142,{size:10,bold:true,color:'white'});fit(`CAD ${dollars(total)}`,468,y+13,90,{size:11,bold:true,color:'white'});y+=50;
 }
 function finish(){const range=doc.bufferedPageRange();for(let p=range.start;p<range.start+range.count;p++){doc.switchToPage(p);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.moveTo(42,744).lineTo(570,744).lineWidth(.5).strokeColor(line).stroke();text('MR. BIN  /  REPAIR CENTRE',42,756,310,{size:7.5,bold:true,color:muted});text(`Page ${p+1} of ${range.count}`,414,756,156,{size:8,color:muted,align:'right'});doc.page.margins.bottom=bottom;}doc.end();return completed;}
 header();return {doc,text,paragraph,info,beginTable,row,summary,finish};
}
