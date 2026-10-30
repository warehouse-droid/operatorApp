import {specialPoRoutingHtml,specialPoRoutingPatch} from './special-stock-po-routing.js';
import {isBackorder} from './backorder-workflow.js';

/** @typedef {Record<string,any>} Detail */
/** @param {Detail} d */
const key=d=>`${d.id}:${d.revision}:${d.purchaseOrderRef}:${d.purchaseOrderSplitId || ''}`;
/** @param {Detail|null} d */
const editable=d=>!!d && isBackorder(d) && !!d.purchaseOrderId && !!d.purchaseOrderRef
  && !['closed','completed'].includes(d.stage) && d.closeStatus!=='closure_pending' && !d.quantityReviewPending;
/** @param {{mount:HTMLElement,api:(path:string,init?:RequestInit)=>Promise<any>,getDetail:()=>Detail|null,setDetail:(d:any)=>void,render:()=>void,isBusy:()=>boolean,setBusy:(busy:boolean)=>void}} options */
export function createBackorderPoRouting({mount,api,getDetail,setDetail,render,isBusy,setBusy}) {
  /** @type {{key:string,ref:string,detail:Detail,order:any,error:string,splits:any[]}|null} */
  let entry=null;
  /** @param {Detail} d */
  const path=d=>`/api/scm/stock-requests/${d.id}/backorder/purchase-order/`;
  /** @param {Detail} d */
  const html=d=>specialPoRoutingHtml(d,entry?.key===key(d)?entry:null,{backorder:true});
  /** @param {Detail} d @param {boolean} [force] */
  async function load(d,force=false) {
    if(!editable(d) || !force && entry?.key===key(d) && entry.detail===d)return;
    const pending={key:key(d),ref:d.purchaseOrderRef,detail:d,order:null,error:'',splits:[]};entry=pending;
    try {
      const choices=await api(path(d)+'splits');pending.splits=choices.splits || [];
      const child=Boolean(d.purchaseOrderSplitId),ref=child?d.purchaseOrderTargetRef:d.purchaseOrderReference || d.purchaseOrderRef;
      const payload=await api(`/api/dispatch/scm/v2/purchase-orders/${encodeURIComponent(ref)}`);
      if(!payload.order || (child
        ? Number(payload.order.scmSplitId)!==d.purchaseOrderSplitId || payload.order.sourcePoRef!==d.purchaseOrderRef
        : payload.order.isScmSplit || String(payload.order.originalPoRef || payload.order.id)!==d.purchaseOrderRef)) {
        throw new Error('The PO routing record does not match this request.');
      }
      const {note}=child?{note:payload.order.scm?.notes || ''}:await api(path(d)+'note');
      if(typeof note!=='string')throw new Error('The NetSuite PO Note could not be loaded.');
      pending.order={...payload.order,netSuiteNote:note};
    } catch(error) {pending.error=error instanceof Error?error.message:String(error);}
    const current=getDetail();
    if(entry===pending && current && key(current)===pending.key) {
      const panel=mount.querySelector('[data-backorder-po-panel]');
      if(panel)panel.innerHTML=html(current)+'<p data-backorder-po-error class="stock-request-error" role="status"></p>';
    }
  }
  mount.addEventListener('click',event=>{
    if(!(event.target instanceof Element) || !event.target.closest('[data-backorder-po-reload]') || isBusy())return;
    const d=getDetail();if(d)void load(d,true);
  });
  mount.addEventListener('submit',async event=>{
    const form=event.target;
    if(!(form instanceof HTMLFormElement) || !form.matches('[data-backorder-po-split-form],[data-backorder-po-routing-form]'))return;
    event.preventDefault();if(isBusy())return;
    const d=getDetail(),loaded=entry;if(!d || !editable(d))return;
    const split=form.matches('[data-backorder-po-split-form]');
    const controls=[...mount.querySelectorAll('input,select,textarea,button')].filter(
      /** @returns {element is HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement} */
      element=>element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement);
    const previous=controls.map(control=>control.disabled);
    setBusy(true);
    try {
      if(!loaded || loaded.key!==key(d))throw new Error('Reload this PO routing before saving.');
      const body=split?{expectedRevision:d.revision,purchaseOrderSplitId:new FormData(form).get('purchaseOrderSplitId') || null}
        :{...specialPoRoutingPatch(form,loaded.order),expectedRevision:d.revision,expectedNote:loaded.order.netSuiteNote};
      controls.forEach(control=>control.disabled=true);
      const result=await api(path(d)+(split?'link':'routing'),{method:split?'POST':'PUT',body:JSON.stringify(body)});
      const saved=split?result:await api(`/api/scm/stock-requests/${d.id}`);
      const current=getDetail();
      if(current && current.id===d.id && current.revision<=saved.revision) {entry=null;setDetail(saved);render();}
    } catch(error) {
      const node=mount.querySelector('[data-backorder-po-error]');
      if(node && getDetail()?.id===d.id)node.textContent=error instanceof Error?error.message:String(error);
    } finally {setBusy(false);controls.forEach((control,index)=>control.disabled=previous[index]);}
  });
  return {
    /** @param {Detail} d */
    detail(d) {
      if(!editable(d)){entry=null;return '';}
      void load(d);
      return `<div data-backorder-po-panel>${html(d)}<p data-backorder-po-error class="stock-request-error" role="status"></p></div>`;
    }
  };
}
