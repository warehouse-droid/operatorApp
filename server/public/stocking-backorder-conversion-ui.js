import {canConvertStockingToBackorder} from './stocking-backorder-conversion.js';
import {fulfillmentFields} from './backorder-stock-requests.js';

/** @param {unknown} value */
const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>(/** @type {Record<string,string>} */ ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));
/** @param {{api:(path:string,init?:RequestInit)=>Promise<any>,onConverted:(request:any)=>void|Promise<void>}} options */
export function createStockingBackorderUI({api,onConverted}) {
  /** @type {HTMLDialogElement|null} */
  let active=null;
  const style=document.createElement('style');
  style.textContent='.stocking-backorder-dialog{width:min(960px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:1px solid #cbd5e1;border-radius:12px;background:white;color:#0f172a}.stocking-backorder-dialog::backdrop{background:#0f172a66}.stocking-backorder-dialog .stock-request-line-fields{align-items:end}.stocking-backorder-dialog [data-stocking-backorder-error]:empty{display:none}';
  document.head.append(style);
  /** @param {Record<string,any>|null|undefined} request */
  function button(request,busy=false) {
    return canConvertStockingToBackorder(request)?`<button type="button" data-scm-stock-action="backorder-convert" ${busy?'disabled':''}>Convert to Backorder</button>`:'';
  }
  /** @param {Record<string,any>|null|undefined} request */
  async function open(request) {
    if (!request || active || !canConvertStockingToBackorder(request)) return;
    const dialog=document.createElement('dialog');active=dialog;dialog.dataset.stockingBackorderDialog='';dialog.className='stocking-backorder-dialog';
    const previous=/** @type {HTMLElement|null} */ (document.activeElement);let submitting=false;
    dialog.innerHTML='<h2>Convert to Backorder</h2><p>Loading request materials…</p><p data-stocking-backorder-error role="alert"></p><button type="button" data-stocking-backorder-cancel>Cancel</button>';
    const close=()=>{dialog.close();dialog.remove();active=null;previous?.isConnected && previous.focus();};
    dialog.addEventListener('click',event=>{if ((/** @type {HTMLElement} */ (event.target)).closest('[data-stocking-backorder-cancel]') && !submitting) close();});
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(!submitting)close();});
    document.body.append(dialog);dialog.showModal();
    try {
      const preview=await api(`/api/scm/stock-requests/${request.id}/backorder-conversion`);
      if (!dialog.isConnected) return;
      dialog.innerHTML=`<form class="stock-request-form"><h2>Convert ${esc(preview.requestRef)} to Backorder</h2>
        <p>Convert the whole request and keep its request number. SCM will review the stock, then Sales accepts or rejects each material.</p>
        <div class="stock-request-summary"><span><small>Customer</small><strong>${esc(preview.customerName || 'Optional')}</strong></span><span><small>Request remark</small><strong>${esc(preview.remarks)}</strong></span></div>
        <div class="stock-request-line-fields backorder-fields">${fulfillmentFields(preview)}<label><span>Required date</span><input name="requiredDate" type="date" value="${esc(preview.requiredDate)}" min="${esc(preview.requiredDate)}" required /></label></div>
        <h3>Materials</h3>${preview.lines.map((/** @type {any} */ line)=>`<article class="stock-request-line"><div class="stock-request-line-fields backorder-fields">
          <div><strong>${esc(line.itemName)}</strong><p>${esc(line.description)}</p></div><div><small>Quantity</small><p>${esc(line.quantity)} ${esc(line.uom)}</p></div>
          <div><small>Receiving yard</small><p>${esc(line.destinationName)}</p></div><label><span>Vendor</span><input data-stocking-backorder-vendor="${line.stockingLineId}" value="${esc(line.vendorName)}" required maxlength="200" /></label></div></article>`).join('')}
        <p data-stocking-backorder-error role="alert"></p><div class="stock-request-actions"><button type="button" data-stocking-backorder-cancel>Cancel</button><button class="primary" type="submit" data-stocking-backorder-confirm>Convert whole request to Backorder</button></div></form>`;
      dialog.addEventListener('change',event=>{
        const target=/** @type {HTMLSelectElement} */ (event.target);
        if (target.name!=='fulfillmentMethod') return;
        const delivery=target.value==='mbt_delivery',fields=/** @type {HTMLElement} */ (dialog.querySelector('[data-backorder-delivery-fields]'));
        fields.hidden=!delivery;(/** @type {HTMLInputElement} */ (fields.querySelector('[data-backorder-address]'))).required=delivery;
      });
      dialog.addEventListener('submit',async event=>{
        event.preventDefault();if(submitting)return;submitting=true;
        const form=/** @type {HTMLFormElement} */ (event.target),error=/** @type {HTMLElement} */ (dialog.querySelector('[data-stocking-backorder-error]'));
        const values=Object.fromEntries(new FormData(form)),vendors=[...dialog.querySelectorAll(/** @type {'input'} */ ('[data-stocking-backorder-vendor]'))].map(input=>({stockingLineId:Number(input.dataset.stockingBackorderVendor),vendorName:input.value}));
        const controls=/** @type {NodeListOf<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement>} */ (form.querySelectorAll('input,select,textarea,button'));
        error.textContent='';controls.forEach(control=>control.disabled=true);
        try {
          const saved=await api(`/api/scm/stock-requests/${request.id}/backorder-conversion`,{method:'POST',body:JSON.stringify({...values,vendors,expectedRevision:preview.revision})});
          close();await onConverted(saved);
        }catch(caught){if(dialog.isConnected)error.textContent=(/** @type {Error} */ (caught)).message;}
        finally{submitting=false;controls.forEach(control=>control.disabled=false);}
      });
      (/** @type {HTMLSelectElement} */ (dialog.querySelector('[name="fulfillmentMethod"]'))).focus();
    }catch(caught){if(dialog.isConnected)(/** @type {HTMLElement} */ (dialog.querySelector('[data-stocking-backorder-error]'))).textContent=(/** @type {Error} */ (caught)).message;}
  }
  return {button,open};
}
