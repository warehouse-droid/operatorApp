import { expireSpecialStockCases } from './special-stock-request-repository.js';
/** @param {{expire?:()=>Promise<number[]>,emit?:(ids:number[])=>void,logger?:{error:(...args:unknown[])=>void},intervalMs?:number}} [options] */
export function createSpecialExpiryRuntime({expire=expireSpecialStockCases,emit=()=>{},logger=console,intervalMs=300000} = {}) {
  let running=false;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer=null;
  async function tick() {
    if(running)return;
    running=true;
    try { const ids=await expire(); if(ids.length)emit(ids); }
    catch(error) { logger.error('Special request expiry failed:',error.message); }
    finally { running=false; }
  }
  return {tick,start(){if(timer)return;timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();void tick();},stop(){if(timer)clearInterval(timer);timer=null;}};
}
