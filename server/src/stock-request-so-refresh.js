// @ts-check
import { config } from './config.js';
import { writeAudit } from './auth-repository.js';
import { fetchTransactionProgressFromNetSuite } from './netsuite.js';
import { STOCK_REQUEST_SO_REFRESH_INTERVAL_MS, stockRequestSalesOrderObservation } from './stock-request-so-refresh-domain.js';
import { withStockRequestRefreshSlot, listStockRequestSalesOrders, applyStockRequestSalesOrderObservation } from './stock-request-so-refresh-repository.js';
/** @param {unknown} error */
const errorText=error=>String(error instanceof Error?error.message:error).slice(0,1000);
/** @param {Record<string,any>} [dependencies] */
export function createStockRequestSalesOrderRefresh(dependencies={}) {
  const enabled=dependencies.enabled || (()=>config.netsuite.directAccessEnabled);
  const operationalSyncRunning=dependencies.operationalSyncRunning || (()=>false);
  const withSlot=dependencies.withSlot || withStockRequestRefreshSlot;
  const listCandidates=dependencies.listCandidates || listStockRequestSalesOrders;
  const fetchProgress=dependencies.fetchProgress || fetchTransactionProgressFromNetSuite;
  const applyObservation=dependencies.applyObservation || applyStockRequestSalesOrderObservation;
  const audit=dependencies.audit || writeAudit,emit=dependencies.emit || (()=>{});
  let running=false;
  /** @param {number|null} orderId @param {string} action @param {Record<string,any>} details */
  const record=(orderId,action,details)=>audit({actorType:'system',source:'stock-request',action:'stock_request.so_refresh.'+action,orderId,details});
  async function runOnce() {
    if (running) return {started:false,reason:'already_running'};
    running=true;
    try {
      if (!enabled()) return {started:false,reason:'disabled'};
      if (await operationalSyncRunning()) return {started:false,reason:'operational_sync_running'};
      return await withSlot(new Date(),async (/** @type {()=>Promise<void>} */ check)=>{
        const result={started:true,checked:0,updated:0,failed:0,stale:0};
        for (const candidate of await listCandidates()) {
          await check();
          if (await operationalSyncRunning()) break;
          result.checked++;
          let observation;
          try { observation=stockRequestSalesOrderObservation(candidate,await fetchProgress(candidate.id,'SalesOrd')); }
          catch(error) { result.failed++;await record(candidate.id,'failed',{ref:candidate.ref,error:errorText(error)});continue; }
          await check();
          try {
            const applied=await applyObservation(candidate,observation);
            if (applied.updated) {result.updated++;emit({orderId:candidate.id,requestIds:applied.requestIds,source:'hourly-so-refresh'});}
            else {result.stale++;await record(candidate.id,'stale',{ref:candidate.ref});}
          } catch(error) {result.failed++;await record(candidate.id,'failed',{ref:candidate.ref,error:errorText(error)});}
        }
        await record(null,'finished',result);
        return result;
      });
    } finally {running=false;}
  }
  return {runOnce};
}

/** @param {Record<string,any>} [dependencies] */
export function startStockRequestSalesOrderRefresh(dependencies={}) {
  const run=dependencies.runOnce || createStockRequestSalesOrderRefresh(dependencies).runOnce;
  const tick=()=>void run().catch((/** @type {unknown} */ error)=>(dependencies.logger || console).error('Hourly request SO refresh failed:',errorText(error)));
  const timer=(dependencies.setInterval || setInterval)(tick,STOCK_REQUEST_SO_REFRESH_INTERVAL_MS);
  timer.unref?.();tick();
  return ()=>(dependencies.clearInterval || clearInterval)(timer);
}
