import {isSpecialTransferEta,specialSupplyEtaLabel,SPECIAL_TRANSFER_ETA_LABEL} from './special-stock-transfer-eta.js';
import {isBackorder,canLinkBackorderOrder} from './backorder-workflow.js';
import {SPECIAL_STAGES,specialStockAvailable} from './special-stock-workflow.js';
import {specialPlanningStatus} from './special-stock-case-status.js';

/** @typedef {import('./backorder-workflow.js').BackorderRequest} BackorderRequest */
/** @param {unknown} value */
const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>(/** @type {Record<string,string>} */ ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));
/** @param {Record<string,string>} values @param {unknown} current */
const options=(values,current)=>Object.entries(values).map(([id,label])=>`<option value="${esc(id)}" ${id===current?'selected':''}>${esc(label)}</option>`).join('');
/** @type {Record<string,string>} */
const fulfillment={yard_pickup:'Pickup',mbt_delivery:'Delivery'};
/** @type {Record<string,string>} */
const supply={in_stock:'In stock',low_inventory:'Low inventory',vendor_transfer:'Wait for Transfer',production:'Production',allocation:'Allocation',no_stock:'No stock',already_ordered:'Already Ordered'};
/** @type {Record<string,string>} */
const stages={...SPECIAL_STAGES,await_customer_confirmation:'Await Sales confirmation'};
/** @param {BackorderRequest} d */
const active=d=>!['closed','completed'].includes(d.stage);
/** @param {string} name @param {string} title @param {unknown} [value] */
const label=(name,title,value='',type='text',attrs='')=>`<label><span>${title}</span><input name="${name}" type="${type}" value="${esc(value)}" ${attrs} /></label>`;
/** @param {BackorderRequest} d @param {string} action @param {string} title @param {string} fields */
function form(d,action,title,fields) {
  const review=action.endsWith('/response'),button=`<button class="primary" type="submit">${title}</button>`;
  return `<form class="stock-request-form${review?' backorder-material-review':''}" data-backorder-form data-action="${action}" data-revision="${d.revision}">${review?'':`<h4>${title}</h4>`}<div class="stock-request-line-fields backorder-fields${review?' backorder-review-grid':''}">${fields}${review?button:''}</div>${review?'':button}</form>`;
}
/** @param {Record<string,any>} line */
function materialStock(line) {
  const evidence=line.stockEvidence || {},number=(/** @type {unknown} */ value)=>value==null?'Unavailable':new Intl.NumberFormat('en-CA',{maximumFractionDigits:4}).format(Number(value));
  return `<div class="regular-stock-safety backorder-material-stock" aria-label="Inventory at destination yard ${esc(line.destinationName)}">${[['On hand',evidence.onHand],['Available',evidence.available],['On Order',evidence.onOrder]].map(([title,value])=>`<span><small>${title}</small><strong>${number(value)} ${esc(line.uom)}</strong></span>`).join('')}</div>`;
}
/** @param {Record<string,any>} d */
export function fulfillmentFields(d,{composer=false}={}) {
  const attribute=composer?'data-regular-field':'name',delivery=d.fulfillmentMethod==='mbt_delivery';
  const field=(/** @type {string} */ name,/** @type {string} */ title,type='text',attrs='')=>`<label><span>${title}</span><input ${attribute}="${name}" type="${type}" value="${esc(d[name])}" ${attrs} /></label>`;
  return `<label><span>Fulfillment</span><select ${attribute}="fulfillmentMethod">${options(fulfillment,d.fulfillmentMethod || 'yard_pickup')}</select></label>
    <div class="stock-request-line-fields backorder-fields stock-request-wide" data-backorder-delivery-fields ${delivery?'':'hidden'}>
    ${field('deliveryAddress','Delivery address','text',`data-backorder-address ${delivery?'required':''}`)}${field('deliveryContactName','Contact name')}${field('deliveryContactPhone','Contact phone')}
    ${field('deliveryDate','Delivery date','date')}${field('windowStart','Window start','time')}${field('windowEnd','Window end','time')}
    <label class="stock-request-wide"><span>Delivery instructions</span><textarea ${attribute}="deliveryInstructions" rows="3" maxlength="8000">${esc(d.deliveryInstructions)}</textarea></label></div>`;
}
/** @param {Record<string,any>} d */
function noteFields(d,{composer=false}={}) {
  return `<div class="backorder-notes stock-request-wide"><label><span>Sales internal note</span><textarea ${composer?'data-regular-field="salesInternalRemark"':'name="salesInternalRemark"'} rows="3" maxlength="8000">${esc(d.salesInternalRemark)}</textarea></label>
    <label><span>Request remark</span><textarea name="remarks" ${composer?'data-sales-stock-remarks':''} rows="3" maxlength="2000">${esc(d.remarks)}</textarea></label></div>`;
}
/** @param {Record<string,any>} d */
function composerFields(d) {
  return `<div class="stock-request-line-fields backorder-fields">${label('inquiryDate','Inquiry date',d.inquiryDate || new Date().toLocaleDateString('en-CA',{timeZone:'America/Toronto'}),'date','data-regular-field="inquiryDate"')}
    ${fulfillmentFields(d,{composer:true})}${noteFields(d,{composer:true})}</div>`;
}
/** @param {Record<string,any>} d */
function composerPayload(d) {
  return Object.fromEntries(['customerId','customerPhone','inquiryDate','fulfillmentMethod','deliveryAddress','deliveryContactName','deliveryContactPhone','deliveryDate','windowStart','windowEnd','deliveryInstructions','salesInternalRemark']
    .map(field=>[field,d[field] ?? (field==='fulfillmentMethod'?'yard_pickup':'')]));
}
/** @param {{mount:HTMLElement,audience:string,api:(path:string,init?:RequestInit)=>Promise<any>,getDetail:()=>BackorderRequest|null,setDetail:(request:BackorderRequest)=>void,render:()=>void,getYards?:()=>Array<{locationId:number,yardCode:string}>,getDefaultDestination?:()=>number|string}} options */
export function createBackorderUI({mount,audience,api,getDetail,setDetail,render,getYards=()=>[],getDefaultDestination=()=>''}) {
  let busy=false;
  const vendors=/** @type {Map<string,Array<{id:number|string,name:string}>>} */ (new Map());
  /** @param {Record<string,any>} line @param {boolean} [composer] */
  function yardField(line,composer=false) {
    const current=String(line.destinationLocationId || getDefaultDestination());
    const yards=[...getYards()];
    if (!composer && line.destinationLocationId && !yards.some(yard=>String(yard.locationId)===current)) yards.push({locationId:Number(current),yardCode:line.destinationName || current});
    return `<label><span>Destination yard</span><select ${composer?'data-sales-stock-field="destinationLocationId"':'name="destinationLocationId"'} required>${yards.map(yard=>`<option value="${yard.locationId}" ${String(yard.locationId)===current?'selected':''}>${esc(yard.yardCode)}</option>`).join('')}</select></label>`;
  }
  /** @param {Record<string,any>} line */
  function composerLine(line) {
    return `<div class="stock-request-line-fields backorder-fields stock-request-wide"><label><span>Vendor</span><input data-sales-stock-field="vendorName" value="${esc(line.vendorName ?? line.item?.vendor)}" required maxlength="200" /></label>${yardField(line,true)}
      ${label('requiredDate','Required date',line.requiredDate,'date','data-sales-stock-field="requiredDate"')}
      <label class="stock-request-wide"><span>Material note</span><input data-sales-stock-field="customerNote" value="${esc(line.customerNote)}" maxlength="4000" /></label></div>`;
  }
  /** @param {Record<string,any>} line @param {Record<string,any>} payload */
  function linePayload(line,payload) {
    return {...payload,vendorName:line.vendorName ?? line.item?.vendor,vendorId:line.vendorId,destinationLocationId:line.destinationLocationId || getDefaultDestination(),requiredDate:line.requiredDate || undefined,customerNote:line.customerNote || ''};
  }
  /** @param {BackorderRequest} d @param {Record<string,any>} line */
  async function vendorChoices(d,line) {
    const name=line.vendorName;
    if (vendors.has(name)) return;
    vendors.set(name,[]);
    try {const result=await api(`/api/${audience}/stock-requests/backorder/vendors?search=${encodeURIComponent(name)}`);vendors.set(name,result.vendors || []);if(getDetail()?.id===d.id)render();}
    catch { /* The saved vendor still remains selectable. */ }
  }
  /** @param {BackorderRequest} d @param {Record<string,any>} line */
  function vendorField(d,line) {
    const id=String(line.vendorId || ''),name=line.vendorName;
    const rows=[{id,name},...(vendors.get(name)||[])].filter((row,index,all)=>row.id && all.findIndex(other=>String(other.id)===String(row.id))===index);
    return `<label><span>Vendor</span><select name="vendorId" required><option value="">Select vendor…</option>${rows.map(row=>`<option value="${row.id}" data-vendor-name="${esc(row.name)}" ${String(row.id)===id?'selected':''}>${esc(row.name)}</option>`).join('')}</select></label>`;
  }
  /** @param {BackorderRequest} d @param {Record<string,any>} line */
  function material(d,line) {
    const ordered=line.supplyStatus==='already_ordered',terminal=!active(d) || ordered, scm=audience==='scm',inStock=!line.supplyStatus || line.supplyStatus==='in_stock',transfer=line.supplyStatus==='vendor_transfer',pendingTransfer=isSpecialTransferEta(line) && !d.salesOrderId;
    const liveSummary=scm?`<p class="stock-live-summary"><span>ETA: ${esc(specialSupplyEtaLabel(line, 'Not available'))} · Pickup: ${esc(line.vendorYard || 'Awaiting check')}</span>${window.SCMStockCheckLines?.line(d,line)||''}</p>`:'';
    const summary=`<header><strong>${esc(line.itemName)} · ${esc(line.productName)}</strong></header><p>${esc(line.quantity)} ${esc(line.uom)} · ${esc(line.detailSpec)}</p>
      <p>${esc(supply[line.supplyStatus] || 'Await SCM review')} · ${ordered?'Completed':esc(line.salesDecision)}${line.availableDate || isSpecialTransferEta(line)?` · ETA ${esc(specialSupplyEtaLabel(line))}`:''}${line.reminderDueDate?` · Review due ${esc(line.reminderDueDate)}`:''}</p>
      ${ordered?`<p>PO number: <strong>${esc(line.poNumber)}</strong>${line.poRefNumber?` · PO ref number: ${esc(line.poRefNumber)}`:''}</p><p>No further steps required for this material.</p>`:''}
      <p>Vendor: ${esc(line.vendorName)} · Destination yard: ${esc(line.destinationName)}</p>
      ${line.salesVisibleNote?`<p>${esc(line.salesVisibleNote)}</p>`:''}${line.customerNote?`<p>${esc(line.customerNote)}</p>`:''}`;
    let controls='';
    if (!terminal && scm) {
      controls+=form(d,`lines/${line.id}/response`,'Save material review',`<label><span>Supply status</span><select name="supplyStatus">${options(supply,line.supplyStatus || 'in_stock')}</select></label>
        <fieldset class="stock-request-line-fields backorder-fields stock-request-wide" data-backorder-ordered-fields hidden disabled>
        ${label('poNumber','PO number (required)','','text','required maxlength="120"')}${label('poRefNumber','PO ref number (optional)','','text','maxlength="200"')}
        <p class="stock-request-wide">Saving Already Ordered completes this material. No Sales confirmation, SO link, PO link or planning is required.</p></fieldset>
        <fieldset class="stock-request-line-fields backorder-fields stock-request-wide" data-backorder-review-fields>
        ${vendorField(d,line)}${label('vendorYard','Vendor yard',line.vendorYard)}
        <fieldset class="stock-request-line-fields backorder-fields stock-request-wide" data-backorder-projection-fields ${inStock || transfer?'hidden disabled':''}>
        <label><span>Projection</span><select name="availabilityMode">${options({no_projection:'No projection',dated:'Dated ETA'},line.availabilityMode || 'no_projection')}</select></label>
        ${label('availableDate','ETA',line.availableDate,'date')}</fieldset><p data-backorder-transfer-eta ${transfer?'':'hidden'}>ETA: ${SPECIAL_TRANSFER_ETA_LABEL}</p>
        ${label('salesVisibleNote','Note for Sales',line.salesVisibleNote)}${label('scmInternalNote','SCM private note',line.scmInternalNote)}</fieldset>`);
      if (line.salesDecision==='accepted') controls+=`<details><summary>Check readiness</summary>${form(d,`lines/${line.id}/readiness`,'Check readiness',`<label><span>Ready</span><select name="ready">${options({true:'Ready',false:'Not ready'},String(specialStockAvailable(line.supplyStatus)))}</select></label><fieldset class="stock-request-line-fields backorder-fields" data-backorder-readiness-eta data-transfer-pending="${pendingTransfer}" ${specialStockAvailable(line.supplyStatus) || pendingTransfer?'hidden disabled':''}>${label('eta','Revised ETA',line.availableDate,'date')}</fieldset><p data-backorder-readiness-transfer ${pendingTransfer?'':'hidden'}>${SPECIAL_TRANSFER_ETA_LABEL}</p>`)}</details>`;
    }
    if (!terminal && !scm) {
      if (line.supplyStatus) controls+=form(d,`lines/${line.id}/decision`,'Save Sales confirmation',`<label><span>Decision</span><select name="decision">${options({accepted:'Accept / wait for ETA',request_update:'Request update',declined:'Decline',closed:'Close material'},line.salesDecision)}</select></label>${label('reason','Reason',line.salesDecisionReason)}${label('customerNote','Confirmation note',line.salesCustomerNote)}`);
      controls+=`<details><summary>Edit request material</summary>${form(d,`lines/${line.id}/edit`,'Save material changes',`${label('quantity',`Quantity (${esc(line.uom)})`,line.quantity,'number','min="0" step="any" required')}${label('productName','Description',line.productName,'text','required maxlength="500"')}${label('vendorName','Vendor',line.vendorName,'text','required maxlength="200"')}${yardField(line)}${label('detailSpec','Specifications',line.detailSpec)}${label('customerNote','Material note',line.customerNote)}`)}</details>`;
    }
    const html = `<article class="stock-request-line backorder-material" data-backorder-line="${line.id}"><div class="backorder-material-heading"><div class="backorder-material-summary">${summary}</div>${materialStock(line)}</div>${liveSummary}${controls}</article>`;
    return scm ? window.SCMRequestLineVisibility?.wrap(d, line, html) || html : html;
  }
  /** @param {BackorderRequest} d */
  function scmLiveHeader(d) { return audience==='scm'?(window.SCMStockCheckLines?.header(d)||'<h3>Line responses</h3>'):'<h3>Materials</h3>'; }
  /** @param {BackorderRequest} d */
  function detail(d) {
    if (audience==='scm' && active(d)) d.lines.filter(line=>line.supplyStatus!=='already_ordered').forEach(line=>void vendorChoices(d,line));
    const ordered=d.lines.some(line=>line.supplyStatus==='already_ordered');
    const noFurtherOrders=ordered && d.lines.every(line=>line.supplyStatus==='already_ordered' || ['declined','closed'].includes(line.salesDecision));
    const names=[...new Set(d.lines.map(line=>line.vendorName))];
    const so=audience==='sales', links=`<div class="stock-request-summary"><span><small>Customer</small><strong>${esc(d.customerName || '—')}</strong></span><span><small>Vendor</small><strong>${esc(names.length>1?'Multiple vendors':names[0])}</strong></span><span><small>Fulfillment</small><strong>${esc(fulfillment[d.fulfillmentMethod] || 'Pickup at vendor')}</strong></span><span><small>SO</small><strong>${esc(d.salesOrderRef || (noFurtherOrders?'Not required':'Pending'))}</strong><small>${esc(d.salesOrderStatus)}</small></span><span><small>PO</small><strong>${esc(d.purchaseOrderRef || (noFurtherOrders?'Not required':'Pending'))}</strong><small>${esc(d.purchaseOrderStatus)}</small></span></div>`;
    const quotation=`<p>NetSuite quotation: <strong>${esc(d.estimateNumber || '—')}</strong></p>${so?form(d,'quotation/link','Save quotation number',label('quotationNumber','NetSuite quotation number',d.estimateNumber,'text','required maxlength="100"')):''}`;
    const unlinked=active(d) && !(so?d.salesOrderId:d.purchaseOrderId),canLink=canLinkBackorderOrder(d,so?'sales_order':'purchase_order');
    const manual=unlinked && canLink ? form(d,so?'sales-order/link':'purchase-order/link',so?'Manual SO link':'Manual PO link',label(so?'salesOrderRef':'purchaseOrderRef','Existing synced order number','','text','required maxlength="120"')) : '';
    const linkNotice=unlinked && !canLink ? `<p class="stock-request-notice">${so?'Sales can link the SO after SCM links the PO and the PO is planned.':'Sales must accept every open material after SCM reviews stock before SCM links the PO.'}</p>` : '';
    const both=Boolean(d.salesOrderId && d.purchaseOrderId);
    const pickup=so && active(d) && both && d.fulfillmentMethod==='vendor_pickup' ? form(d,'vendor-pickup/complete','Complete vendor pickup',label('pickupDate','Pickup date','','date','required')+label('pickupReference','Pickup reference','','text','required')) : '';
    const information=!window.StockRequestConversation && active(d) && d.informationRequest?.status==='pending' ? `<p class="stock-request-notice">${esc(d.informationRequest.question)}</p>${so?form(d,'information/submit','Reply to SCM',label('reply','Reply','','text','required')):''}` : '';
    const ask=!window.StockRequestConversation && !so && active(d) && !d.salesOrderId && !d.purchaseOrderId && d.informationRequest?.status!=='pending'?form(d,'information/request','Request information',label('question','Question for Sales','','text','required')):'';
    const acknowledge=!so && active(d) && d.postPoChangePending?form(d,'changes/acknowledge','Acknowledge revised ETA',label('acknowledgement','Acknowledgement','','text','required')):'';
    const delivery=d.fulfillmentMethod==='mbt_delivery'?`<div class="stock-request-line-fields backorder-fields"><span><small>Delivery address</small><strong>${esc(d.deliveryAddress)}</strong></span><span><small>Delivery date</small><strong>${esc(d.deliveryDate || '—')}</strong></span><span><small>Delivery window</small><strong>${esc(d.windowStart || '—')} – ${esc(d.windowEnd || '—')}</strong></span><span><small>Delivery contact</small><strong>${esc(d.deliveryContactName)} ${esc(d.deliveryContactPhone)}</strong></span></div>${d.deliveryInstructions?`<p>Delivery instructions: ${esc(d.deliveryInstructions)}</p>`:''}`:'';
    const header=delivery+(so && active(d)?`<details><summary>Edit request header</summary>${form(d,'header','Save request header',label('customerName','Customer (optional)',d.customerName)+label('customerPhone','Customer phone',d.customerPhone)+fulfillmentFields(d)+noteFields(d))}</details>`:'');
    const close=active(d)?`<details><summary>Close Backorder</summary>${form(d,'close','Close request',label('reason','Reason','','text','required maxlength="2000"'))}</details>`:'';
    return `<div data-backorder-detail data-backorder-id="${d.id}"><div class="stock-request-heading"><div><h2>${esc(d.requestRef)} · Backorder</h2><p>${esc(stages[d.stage] || d.stage)}</p></div>${so && d.lines.every(line=>line.originalRate!==null)?`<button type="button" data-backorder-document="quote.pdf">Preview quote</button>`:''}${d.salesOrderId?'<button type="button" data-backorder-document="sales-order/document.pdf">Preview SO</button>':''}${!so && d.purchaseOrderId?'<button type="button" data-backorder-document="purchase-order/document.pdf">Preview PO</button>':''}</div><div data-backorder-error class="stock-request-error" role="status"></div>${links}${quotation}${manual}${linkNotice}
      ${ordered?'<p>Already Ordered materials are complete. Their PO references are shown below.</p>':''}${noFurtherOrders?'':'<p>SCM review → Sales acceptance → Confirmed → PO reference + Queued → Dispatch Arrangement.</p>'}${noFurtherOrders?'':specialPlanningStatus(d,false,{audience,showOrderPreviews:false,showApprovalNotice:false})}${d.remarks?`<p>${esc(d.remarks)}</p>`:''}${information}${header}${ask}
      <section class="stock-request-section" data-scm-line-visibility="${d.id}">${scmLiveHeader(d)}${audience==='scm'?window.SCMRequestLineVisibility?.controls(d)||'':''}<div id="scm-request-lines-${d.id}">${d.lines.map(line=>material(d,line)).join('')}</div></section>${pickup}${acknowledge}${close}
      <section class="stock-request-section"><h3>History</h3>${(d.events || []).map(event=>`<p>${esc(event.actorName)} · ${esc(event.eventType.replace(/^special_/,'backorder_').replaceAll('_',' '))} · ${esc(event.createdAt)}</p>`).join('')}</section></div>`;
  }
  mount.addEventListener('change',event=>{
    const select=/** @type {HTMLSelectElement} */ (event.target);
    if (select.matches('[data-backorder-form] [name="supplyStatus"]')) {
      const form=/** @type {HTMLFormElement} */ (select.closest('form')),ordered=select.value==='already_ordered';
      for (const [selector,show] of /** @type {Array<[string,boolean]>} */ ([['[data-backorder-ordered-fields]',ordered],['[data-backorder-review-fields]',!ordered],['[data-backorder-projection-fields]',!ordered && !['in_stock','vendor_transfer'].includes(select.value)]])) {
        const fields=/** @type {HTMLFieldSetElement} */ (form.querySelector(selector));fields.hidden=!show;fields.disabled=!show;
      }
      const transferLabel=/** @type {HTMLElement} */ (form.querySelector('[data-backorder-transfer-eta]'));
      transferLabel.hidden=select.value!=='vendor_transfer';
      return;
    }
    if (select.matches('[data-backorder-form] [name="ready"]')) {
      const fields=/** @type {HTMLFieldSetElement} */ (select.closest('form')?.querySelector('[data-backorder-readiness-eta]'));
      const pending=fields.dataset.transferPending==='true';
      fields.hidden=select.value==='true' || pending;fields.disabled=fields.hidden;
      const transferLabel=/** @type {HTMLElement} */ (select.closest('form')?.querySelector('[data-backorder-readiness-transfer]'));
      transferLabel.hidden=!pending || select.value==='true';return;
    }
    if (!select.matches('[data-backorder-form] [name="fulfillmentMethod"]')) return;
    const form=/** @type {HTMLFormElement} */ (select.closest('form')),delivery=select.value==='mbt_delivery';
    const fields=/** @type {HTMLElement} */ (form.querySelector('[data-backorder-delivery-fields]'));
    fields.hidden=!delivery;
    (/** @type {HTMLInputElement} */ (fields.querySelector('[data-backorder-address]'))).required=delivery;
  });
  mount.addEventListener('submit',async event=>{
    const target=/** @type {HTMLFormElement} */ (event.target);if(!target.matches('[data-backorder-form]'))return;
    event.preventDefault();if(busy)return;busy=true;
    const fields=/** @type {Record<string,any>} */ (Object.fromEntries(new FormData(target)));fields.expectedRevision=Number(target.dataset.revision);
    if (fields.supplyStatus==='in_stock') {fields.availabilityMode='no_projection';fields.availableDate='';}
    if (fields.supplyStatus==='vendor_transfer') {fields.availabilityMode='so_placement';fields.availableDate='';}
    if (fields.ready!==undefined) fields.ready=fields.ready==='true';
    if (fields.vendorId) {fields.vendorName=(/** @type {HTMLSelectElement} */ (target.querySelector('[name=vendorId]'))).selectedOptions[0].dataset.vendorName;fields.vendorId=Number(fields.vendorId);}
    const buttons=[...mount.querySelectorAll(/** @type {'button'} */ ('[data-backorder-form] button'))];buttons.forEach(button=>button.disabled=true);
    const inputs=[.../** @type {NodeListOf<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>} */ (mount.querySelectorAll('[data-backorder-form] input,[data-backorder-form] select,[data-backorder-form] textarea'))];inputs.forEach(input=>input.disabled=true);
    const d=getDetail();
    if(!d){busy=false;return;}
    try {
      const saved=await api(`/api/${audience}/stock-requests/${d.id}/backorder/${target.dataset.action}`,{method:'POST',body:JSON.stringify(fields)});
      const current=getDetail();
      if(current?.id===d.id && current.revision<=saved.revision){setDetail(saved);render();}
    } catch(caughtError) {const error=/** @type {Error} */ (caughtError);const errorNode=mount.querySelector('[data-backorder-error]');if(errorNode && getDetail()?.id===d.id)errorNode.textContent=error.message;}
    finally{busy=false;buttons.forEach(button=>button.disabled=false);inputs.forEach(input=>input.disabled=false);}
  });
  mount.addEventListener('click',async event=>{
    const button=/** @type {HTMLButtonElement|null} */ ((/** @type {HTMLElement} */ (event.target)).closest('[data-backorder-document]'));
    if (!button) return;
    try {
      const response=await fetch(`/api/${audience}/stock-requests/${getDetail()?.id}/backorder/${button.dataset.backorderDocument}`,{headers:{Authorization:'Bearer '+localStorage.getItem('mbbs.staff.token')}});
      if (!response.ok) throw new Error('Document preview is unavailable. Check the saved prices or linked order.');
      const url=URL.createObjectURL(await response.blob());window.open(url,'_blank','noopener');window.setTimeout(()=>URL.revokeObjectURL(url),60000);
    }catch(caughtError){const errorNode=mount.querySelector('[data-backorder-error]');if(errorNode)errorNode.textContent=(/** @type {Error} */ (caughtError)).message;}
  });
  return {isBackorder,detail,composerFields,composerLine,composerPayload,linePayload,
    filter:(/** @type {string} */ type,/** @type {string} */ stage,/** @type {string} */ attribute,allStagesLabel='All active stages')=>`<label><span>Request type</span><select ${attribute}="requestTypeFilter">${options({'':'All Regular',backorder:'Backorder'},type)}</select></label>${type==='backorder'?`<label><span>Case stage</span><select ${attribute}="backorderStageFilter">${options({'':allStagesLabel,...stages},stage)}</select></label>`:''}`};
}
