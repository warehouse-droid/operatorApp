/**
 * @template T
 * @param {{read:(key:string,signal:AbortSignal)=>Promise<T>,accept:(value:T)=>void,
 * blocked:()=>boolean,loading:(value:boolean)=>void,error:(error:unknown)=>void}} options
 */
export function createSpecialQueueLoader({read,accept,blocked,loading,error}) {
  let generation=0, invalidation=0, loaded=-1, lastKey='', signature='';
  /** @type {{key:string,promise:Promise<void>,controller:AbortController}|null} */
  let flight=null;
  /** @param {string} key @param {{force?:boolean}} [options] */
  function load(key,{force=false}={}) {
    if (blocked()) return Promise.resolve();
    if (flight?.key===key) return flight.promise;
    if (!force && lastKey===key && loaded===invalidation) return Promise.resolve();
    flight?.controller.abort();
    const current=++generation, revision=invalidation, controller=new AbortController();
    loading(true);
    const promise=(async()=>{
      try {
        const value=await read(key,controller.signal);
        if (current!==generation || revision!==invalidation) return;
        if (blocked()) { loaded=-1; return; }
        const next=JSON.stringify(value);
        loading(false);
        if (next!==signature || key!==lastKey) accept(value);
        signature=next; lastKey=key; loaded=revision;
      } catch (caught) {
        if (current===generation && !controller.signal.aborted) { loaded=-1; signature=''; loading(false); error(caught); }
      } finally {
        if (current===generation) {
          flight=null; loading(false);
          if (revision!==invalidation && !blocked()) void load(key);
        }
      }
    })();
    flight={key,promise,controller};
    return promise;
  }
  return {load,invalidate(){invalidation++;},get pending(){return loaded!==invalidation;}};
}

/** @param {{type?:string,payload?:{orderId?:number|string,tranid?:string,source?:string}}} event
 * @param {Array<{salesOrderId?:number,purchaseOrderId?:number,salesOrderRef?:string,purchaseOrderRef?:string}>} requests */
export function specialQueueEventRelevant(event, requests) {
  if (event.type==='special-stock-request.updated' || event.type==='scm.schedule.updated') return true;
  if (['dispatch.plan.saved','dispatch.plan.confirmed','dispatch.plan.cleared','dispatch.plan.reopened','driver.job.completed'].includes(event.type || '')) return true;
  if (event.type!=='dispatch.orders.updated') return false;
  if (['scm-po-ref','scm-schedule'].includes(event.payload?.source || '')) return true;
  const {orderId,tranid}=event.payload || {};
  if (!orderId && !tranid) return true;
  return requests.some(row=>[row.salesOrderId,row.purchaseOrderId].some(id=>Boolean(id)&&String(id)===String(orderId))
    || [row.salesOrderRef,row.purchaseOrderRef].some(ref=>Boolean(ref)&&ref===tranid));
}

/** @param {{queue:ReturnType<typeof createSpecialQueueLoader>,key:()=>string,
 * requests:()=>Parameters<typeof specialQueueEventRelevant>[1],active:()=>boolean,audience:string}} options */
export function watchSpecialQueue({queue,key,requests,active,audience}) {
  let timer=0, opened=false;
  const refresh=()=>{if(active() && !document.hidden) void queue.load(key());};
  const source=typeof EventSource==='undefined' ? null : new EventSource(`/api/events?client=${audience}-special-requests`);
  source?.addEventListener('app-event',message=>{
    let event; try { event=JSON.parse(message.data); } catch { return; }
    if (!specialQueueEventRelevant(event,requests())) return;
    queue.invalidate(); window.clearTimeout(timer); timer=window.setTimeout(refresh,400);
  });
  source?.addEventListener('open',()=>{if(opened){queue.invalidate();refresh();}opened=true;});
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange',refresh);
  window.addEventListener('pagehide',()=>{source?.close();window.clearTimeout(timer);},{once:true});
}
