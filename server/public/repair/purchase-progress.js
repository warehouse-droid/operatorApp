import {esc,field} from './client.js?v=20261029-quote-policy';
import {purchaseStage} from './domain.js?v=20261029-quote-policy';
export const purchaseLabels={po_placed:'PO placed',parts_received:'Parts received',invoice_updated:'Invoice updated',bill_posted:'Bill posted'};
export function purchaseProgress(purchase){
 const stage=purchase.stage||purchaseStage(purchase),steps=Object.keys(purchaseLabels),index=steps.indexOf(stage);
 const pending=purchase.billState&&purchase.billState!=='done';
 return `<ol class="purchase-progress" aria-label="Purchase progress" data-purchase-stage="${esc(stage)}">${steps.map((key,i)=>`<li data-step="${key}" data-state="${i<=index?'done':'pending'}" ${i===Math.min(index+1,3)?'aria-current="step"':''}><span class="purchase-step-number">${i<=index?'✓':i+1}</span><span>${purchaseLabels[key]}</span></li>`).join('')}</ol>${pending?`<p class="notice" data-bill-state="${esc(purchase.billState)}">${['attention','uncertain'].includes(purchase.billState)?'Bill needs review before posting.':purchase.billState==='working'?'Bill posting — awaiting NetSuite confirmation.':'Ready for manual Bill posting.'}</p>`:''}`;
}
export function incomingPartsPanel(lines,{team=false}={}){
 if(!lines?.length)return '';
 return `<section class="team-section incoming-parts"><h3>Incoming parts</h3>${lines.map(line=>`<article class="incoming-part" data-incoming-line="${line.id}"><div><strong>${esc(line.description)}</strong><p>${esc(line.poNumber)} · ${esc(line.jobNumber||'')} · ${line.quantityMilli/1000} ordered · ${line.receivedMilli/1000} received</p>${line.eta?`<p class="muted">Expected arrival: ${esc(line.eta)}</p>`:''}</div>${team&&line.receivedMilli<line.quantityMilli?`<form data-form="receive-incoming" class="row"><input name="purchaseId" type="hidden" value="${line.purchaseId}"><input name="lineId" type="hidden" value="${line.id}"><input name="expectedReceivedMilli" type="hidden" value="${line.receivedMilli}">${field('quantity','Quantity received now','number',(line.quantityMilli-line.receivedMilli)/1000,`required min="0.001" max="${(line.quantityMilli-line.receivedMilli)/1000}" step="0.001"`)}<button type="submit">Receive parts</button></form>`:line.receivedMilli>=line.quantityMilli?'<p class="muted">Received by Repair Team</p>':''}</article>`).join('')}</section>`;
}
