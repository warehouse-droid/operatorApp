import {pool,query,withTransaction} from './db.js';
import {regularError} from './regular-stock-domain.js';
import {submitDeliveryStockRequest,previewDeliveryStockRequest,retryDeliveryStockRequest,decideDeliveryStockRequest} from './regular-stock-delivery.js';
import {getScmStockRequest} from './stock-request-repository.js';
import {withOperatorNetSuitePriority} from './operator-netsuite-request-pool.js';
import {withDeliveryProgress} from './regular-stock-delivery-progress.js';

const active = row => ['queued','running'].includes(row.status);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function view(row) {
  return {id:row.id,action:row.action,requestId:row.result?.id || (row.request_id == null ? null : Number(row.request_id)),input:row.input,
    status:row.status,phase:row.phase,result:row.result,error:row.error,code:row.error_code,updatedAt:row.updated_at};
}

export async function getDeliveryOperation(id,context) {
  if (!uuid(id)) throw regularError('Delivery operation not found.','REGULAR_DELIVERY_OPERATION_MISSING',404);
  const row=(await query('SELECT * FROM regular_stock_delivery_operations WHERE id=$1 AND actor_id=$2 AND audience=$3',[id,context.operatorId,context.audience])).rows[0];
  if (!row) throw regularError('Delivery operation not found.','REGULAR_DELIVERY_OPERATION_MISSING',404);
  const base=row.result?.destinationLocationId || row.result?.baseLocationId;
  if(context.audience==='sales' && base && !context.authorizedDestinationLocationIds?.includes(base)) {
    throw regularError('Sales yard access changed.','REGULAR_DELIVERY_ACCESS',403);
  }
  return view(row);
}

export async function activeDeliveryOperation(context) {
  const row=(await query("SELECT id FROM regular_stock_delivery_operations WHERE actor_id=$1 AND audience=$2 AND status IN ('queued','running')",[context.operatorId,context.audience])).rows[0];
  return row ? getDeliveryOperation(row.id,context) : null;
}

export async function enqueueDeliveryOperation(command,context) {
  const {operationId,action,input={},requestId=null}=command;
  const allowed=context.audience==='sales' ? ['preview','submit','retry'] : context.audience==='scm' ? ['decision','retry'] : [];
  if (!uuid(operationId) || !allowed.includes(action) || !input || Array.isArray(input) || typeof input!=='object'
      || JSON.stringify(input).length>16384 || (['retry','decision'].includes(action) && (!Number.isSafeInteger(requestId) || requestId<=0))
      || (['preview','submit'].includes(action) && requestId!==null)) {
    throw regularError('Invalid Delivery operation.','REGULAR_DELIVERY_OPERATION_INVALID',400);
  }
  return withTransaction(async()=>{
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`regular-delivery-actor:${context.operatorId}`]);
    const existing=(await query('SELECT *,input=$2::jsonb AS same_input FROM regular_stock_delivery_operations WHERE id=$1',[operationId,JSON.stringify(input)])).rows[0];
    if(existing) {
      if(existing.actor_id!==context.operatorId || existing.audience!==context.audience || existing.action!==action
          || String(existing.request_id)!==String(requestId) || !existing.same_input) {
        throw regularError('This operation ID belongs to a different action.','REGULAR_DELIVERY_OPERATION_CONFLICT');
      }
      return getDeliveryOperation(operationId,context);
    }
    const pending=await query("SELECT id FROM regular_stock_delivery_operations WHERE actor_id=$1 AND status IN ('queued','running')",[context.operatorId]);
    if(pending.rowCount) throw regularError('A Delivery operation is already processing. Reload to check its progress.','REGULAR_DELIVERY_BUSY');
    const row=(await query(`INSERT INTO regular_stock_delivery_operations(id,actor_id,audience,action,input,request_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,[operationId,context.operatorId,context.audience,action,JSON.stringify(input),requestId])).rows[0];
    return view(row);
  });
}

async function executionContext(row) {
  const actor=(await query('SELECT active,role,roles,yard_location_ids FROM operators WHERE id=$1',[row.actor_id])).rows[0];
  const roles=new Set([actor?.role,...(actor?.roles||[])].map(value=>String(value).toLowerCase().replaceAll('-','_').replaceAll(' ','_')));
  const permitted=row.audience==='sales' ? ['admin','sales'] : ['admin','scm','scm_staff'];
  if(!actor?.active || !permitted.some(role=>roles.has(role))) throw regularError('Your access changed. Sign in with an authorized account.','REGULAR_DELIVERY_ACCESS',403);
  const yards=roles.has('admin') ? [1,28,15,26] : actor.yard_location_ids;
  if(row.audience==='scm') {
    const request=await getScmStockRequest(row.request_id);
    return {operatorId:row.actor_id,authorizedDestinationLocationIds:[request.destinationLocationId]};
  }
  return {operatorId:row.actor_id,authorizedDestinationLocationIds:yards};
}

export async function runDeliveryOperation(id,dependencies={}) {
  const client=await pool.connect(),key=`regular-delivery-operation:${id}`;
  let acquired=false,broken=false;
  const disconnected=()=>{broken=true;};client.on('error',disconnected);
  try {
    acquired=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0].acquired;
    if(!acquired)return;
    const row=(await client.query('SELECT * FROM regular_stock_delivery_operations WHERE id=$1',[id])).rows[0];
    if(!row || !active(row))return;
    try {
      // A free session lock on running work means its process exited. Never
      // automatically replay an approval or an ambiguous external write.
      if(row.status==='running') throw regularError('Processing was interrupted. Retry to check the saved request and any existing TO.','REGULAR_DELIVERY_INTERRUPTED');
      await client.query("UPDATE regular_stock_delivery_operations SET status='running',updated_at=now() WHERE id=$1",[id]);
      const context=await executionContext(row);
      const report=async phase=>{
        if(broken)throw regularError('Processing connection interrupted. Retry to check the existing TO.','REGULAR_DELIVERY_INTERRUPTED');
        await client.query('UPDATE regular_stock_delivery_operations SET phase=$2,updated_at=now() WHERE id=$1',[id,phase]);
      };
      const result=await withOperatorNetSuitePriority(()=>withDeliveryProgress(report,async()=>{
        if(row.action==='preview')return previewDeliveryStockRequest(row.input,context,dependencies);
        if(row.action==='submit')return submitDeliveryStockRequest(row.input,context,dependencies);
        if(row.action==='decision')return decideDeliveryStockRequest(row.request_id,row.input,context,dependencies);
        return retryDeliveryStockRequest(row.request_id,context,dependencies);
      }));
      await client.query(`UPDATE regular_stock_delivery_operations SET status='succeeded',phase=$2,result=$3::jsonb,
        updated_at=now() WHERE id=$1`,[id,result.regular?.handoffStatus==='attention'?'attention':'complete',JSON.stringify(result)]);
      return result;
    } catch(error) {
      await query("UPDATE regular_stock_delivery_operations SET status='failed',error=$2,error_code=$3,updated_at=now() WHERE id=$1",
        [id,String(error.message).slice(0,2000),error.code || 'REGULAR_DELIVERY_FAILED']);
    }
  } finally {
    if(acquired && !broken)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{broken=true;});
    client.removeListener('error',disconnected);client.release(broken);
  }
}

export function createDeliveryOperationRuntime({dependencies={},emit=()=>{}}={}) {
  let running=false,timer=null,lastCleanup=0;
  async function tick() {
    if(running)return;
    running=true;
    try {
      if(Date.now()-lastCleanup>3600000) {
        await query("DELETE FROM regular_stock_delivery_operations WHERE status IN ('succeeded','failed') AND updated_at<now()-interval '30 days'");
        lastCleanup=Date.now();
      }
      const pending=await query("SELECT id FROM regular_stock_delivery_operations WHERE status IN ('queued','running') ORDER BY created_at LIMIT 2");
      await Promise.all(pending.rows.map(async row=>{
        const result=await runDeliveryOperation(row.id,dependencies);
        if(result?.id)emit(result.id);
      }));
    } finally {running=false;}
  }
  const wake=()=>{if(timer)setImmediate(()=>void tick().catch(error=>console.error('Delivery processing:',error.message)));};
  return {tick,wake,start(){if(timer)return;timer=setInterval(wake,1000);timer.unref();wake();},stop(){clearInterval(timer);timer=null;}};
}
