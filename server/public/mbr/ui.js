import {formatMoney,formatDeadline,formatRentalPeriod} from './domain.js';
export const escapeHtml=value=>String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
export function notice(message,kind='') {
  const target=document.getElementById('mbrNotice');
  target.className=message?'mbr-notice '+kind:'';target.textContent=message;
}
export function badge(status) {return `<span class="mbr-status ${escapeHtml(status)}">${escapeHtml(status)}</span>`;}
export function agreementHtml(paragraphs) {
  return `<div class="mbr-agreement">${paragraphs.map((text,index)=>index===0
    ? `<p class="agreement-title">${escapeHtml(text)}</p>`
    : /^\d+\. /u.test(text)?`<h3>${escapeHtml(text)}</h3>`:`<p>${escapeHtml(text)}</p>`).join('')}</div>`;
}
export function summaryHtml(contract) {
  const f=contract.fields;
  const rows=[['Lessee',f.lessee],['Equipment',f.equipmentModel],['Serial number',f.serialNumber],
    ['Rental period',formatRentalPeriod(f.rentalStart,f.rentalEnd)],['Pickup location',f.pickupLocation],['Return location',f.returnLocation],
    ['Daily rate',formatMoney(f.dailyRateMinor)],['Weekly rate',formatMoney(f.weeklyRateMinor)],
    ['Monthly rate',formatMoney(f.monthlyRateMinor)],['Refundable deposit',formatMoney(f.securityDepositMinor)]];
  return `<dl class="mbr-summary">${rows.map(([label,value])=>`<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}
export function signedHtml(contract) {
  const s=contract.signature;
  return `<section class="mbr-card"><h2>Agreement completed</h2><p>Signed by <strong>${escapeHtml(s.signerName)}</strong> · ${escapeHtml(formatDeadline(s.signedAt))}</p><p>Rental Protection Plan: <strong>${s.protectionPlanAccepted?'Accepted — 15% of applicable rental charges':'Declined'}</strong></p><img class="mbr-signed-image" src="${escapeHtml(s.imageDataUrl)}" alt="Signature of ${escapeHtml(s.signerName)}"><div class="mbr-actions"><button type="button" class="primary" data-action="pdf">Download signed PDF</button></div></section>`;
}
export async function downloadPdf(response) {
  if(!response.ok) {const error=await response.json().catch(()=>({}));throw new Error(error.error || 'Could not download the agreement. Please try again.');}
  const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');
  anchor.href=url;anchor.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/u)?.[1] || 'MBR-rental-agreement.pdf';
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
export function drawSignature(canvas) {
  const context=canvas.getContext('2d');
  canvas.width=Math.round(Math.min(700,canvas.getBoundingClientRect().width)*2);canvas.height=400;
  let drawing=false,ink=false;
  const clear=()=>{context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);ink=false;};
  const point=event=>{const bounds=canvas.getBoundingClientRect();return [(event.clientX-bounds.left)*canvas.width/bounds.width,(event.clientY-bounds.top)*canvas.height/bounds.height];};
  clear();context.strokeStyle='#242020';context.lineWidth=4;context.lineCap='round';context.lineJoin='round';
  canvas.addEventListener('pointerdown',event=>{drawing=true;canvas.setPointerCapture(event.pointerId);context.beginPath();context.moveTo(...point(event));event.preventDefault();});
  canvas.addEventListener('pointermove',event=>{if(!drawing){return;}context.lineTo(...point(event));context.stroke();ink=true;event.preventDefault();});
  for(const name of ['pointerup','pointercancel']) {canvas.addEventListener(name,()=>{drawing=false;});}
  return {clear,hasInk:()=>ink,dataUrl:()=>canvas.toDataURL('image/png')};
}
