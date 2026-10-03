import {randomUUID} from 'node:crypto';
import {query} from './db.js';
import {config} from './config.js';
import {withWaitlistTransaction,getWaitlistConversion,finishWaitlistConversion,expireWaitlistAllocations} from './regular-waitlist-repository.js';
import {prepareWaitlistSalesOrder,postWaitlistSalesOrder,findWaitlistSalesOrder} from './regular-waitlist-netsuite.js';
import {WAITLIST_POLL_MS} from './regular-waitlist-domain.js';

/** @param {string} id @param {{prepare?:typeof prepareWaitlistSalesOrder,post?:typeof postWaitlistSalesOrder,find?:typeof findWaitlistSalesOrder}} [dependencies] */
export async function processWaitlistConversion(id,dependencies={}){
  const token=randomUUID();
  const claimed=await withWaitlistTransaction(async()=>{
    const result=await query(`UPDATE regular_waitlist_conversions SET lease_token=$2,lease_until=now()+interval '2 minutes',updated_at=now(),
      status=CASE WHEN status='pending' THEN 'preparing' ELSE status END
      WHERE id=$1 AND status IN ('pending','preparing','submitted','uncertain')
      AND (lease_until IS NULL OR lease_until<now()) RETURNING id`,[id,token]);
    return result.rowCount>0;
  });
  if(!claimed)return getWaitlistConversion(id);
  const prepare=dependencies.prepare||prepareWaitlistSalesOrder,post=dependencies.post||postWaitlistSalesOrder,find=dependencies.find||findWaitlistSalesOrder;
  let operation=await getWaitlistConversion(id);
  try{
    // A persisted submission boundary forbids another POST, even after a crash.
    if(operation.remoteStartedAt){
      const found=await find(id);
      if(found)return await finishWaitlistConversion(id,found);
      await retainUncertain(id,token,'NetSuite submission started; its SO marker is not visible yet.');
      return getWaitlistConversion(id);
    }
    const payload=await prepare(operation);
    const submitted=await withWaitlistTransaction(async()=>{
      // Recheck PO changes made while mappings were fetched outside the ledger lock.
      const {waitlistPoolSupply}=await import('./regular-waitlist-supply.js');
      const pools=(await query(`SELECT DISTINCT p.* FROM regular_waitlist_pools p JOIN regular_waitlist_allocations a ON a.pool_id=p.id WHERE a.conversion_id=$1`,[id])).rows;
      for(const pool of pools){const supply=await waitlistPoolSupply(pool,{lock:true});if(supply.attention)throw Object.assign(new Error(supply.attention),{code:'WAITLIST_PO_UNAVAILABLE'});}
      return (await query(`UPDATE regular_waitlist_conversions SET status='submitted',payload=$3::jsonb,remote_started_at=now(),updated_at=now()
        WHERE id=$1 AND lease_token=$2 AND remote_started_at IS NULL RETURNING id`,[id,token,JSON.stringify(payload)])).rowCount>0;
    });
    if(!submitted)return getWaitlistConversion(id);
    operation=await getWaitlistConversion(id);
    await post(payload);
    const found=await find(id);
    if(found)return await finishWaitlistConversion(id,found);
    await retainUncertain(id,token,'SO submitted. Waiting for its NetSuite marker.');
  }catch(error){
    // Only failures before POST can safely return the reservation to Sales.
    if(!operation.remoteStartedAt)await failPreparation(id,token,error);
    else await retainUncertain(id,token,String(error.message));
  }
  return getWaitlistConversion(id);
}
async function retainUncertain(id,token,message){
  await withWaitlistTransaction(()=>query(`UPDATE regular_waitlist_conversions SET status='uncertain',error=$3,lease_until=NULL,lease_token=NULL,updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND status IN ('submitted','uncertain')`,[id,token,String(message).slice(0,2000)]));
}
async function failPreparation(id,token,error){
  await withWaitlistTransaction(async()=>{
    const failed=await query(`UPDATE regular_waitlist_conversions SET status='failed',error=$3,lease_until=NULL,lease_token=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND remote_started_at IS NULL RETURNING request_id`,[id,token,String(error.message).slice(0,2000)]);
    if(!failed.rowCount)return;
    const pools=(await query("UPDATE regular_waitlist_allocations SET status='reserved',conversion_id=NULL WHERE conversion_id=$1 AND status='converting' RETURNING pool_id",[id])).rows;
    await query('UPDATE regular_waitlist_pools SET revision=revision+1,updated_at=now() WHERE id=ANY($1::bigint[])',[pools.map(row=>Number(row.pool_id))]);
    await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1',[failed.rows[0].request_id]);
  });
}
export function createWaitlistRuntime({emit=(_payload)=>{},log=console.error,remoteEnabled=config.netsuite.directAccessEnabled,processConversion=processWaitlistConversion}={}){
  let timer=null,expiryBusy=false,conversionBusy=false;
  async function expiryTick(){
    if(expiryBusy)return;expiryBusy=true;
    try{
      const released=await expireWaitlistAllocations();if(released.requestIds.length)emit({source:'waitlist-returned',...released});
    }catch(error){log('Waitlist expiry worker:',error.message);}finally{expiryBusy=false;}
  }
  async function conversionTick(){
    if(!remoteEnabled||conversionBusy)return;conversionBusy=true;
    try{
        const operations=(await query(`SELECT id,request_id FROM regular_waitlist_conversions WHERE status IN ('pending','preparing','submitted','uncertain')
          AND (lease_until IS NULL OR lease_until<now()) AND (status IN ('pending','preparing') OR updated_at<now()-interval '15 seconds')
          ORDER BY requested_at,id LIMIT 5`)).rows;
        for(const row of operations){await processConversion(row.id);emit({source:'waitlist-conversion',requestId:Number(row.request_id)});}
    }catch(error){log('Waitlist SO worker:',error.message);}finally{conversionBusy=false;}
  }
  async function tick(){await expiryTick();await conversionTick();}
  return {tick,start(){if(timer)return;void tick();timer=setInterval(()=>void tick(),WAITLIST_POLL_MS);timer.unref();},stop(){clearInterval(timer);timer=null;}};
}
