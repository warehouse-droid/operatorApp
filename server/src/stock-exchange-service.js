import { pool, query, withIndependentTransaction } from './db.js';
import { inventoryError } from './inventory-workflow-domain.js';
import { exchangeDestination } from './stock-exchange-domain.js';
import { exchangeProof, verifyExchangeTransfer, confirmedExchangeLines } from './stock-exchange-proof.js';
import { stockExchangeNetSuite } from './stock-exchange-netsuite.js';
import { withNetSuiteOperationalWork } from './netsuite-operational-work.js';
import { getOperatorNetSuitePostingPolicy } from './operator-netsuite-posting-policy-repository.js';

export async function admitStockExchange(recordId, intent) {
  const month = await query(`INSERT INTO return_exchange_months(location_id,month,external_id) VALUES($1,$2,$3)
    ON CONFLICT(location_id,month) DO UPDATE SET month=EXCLUDED.month RETURNING id`,
  [intent.locationId, intent.month, intent.externalId]);
  await query('INSERT INTO return_exchange_postings(record_id,month_id,intent) VALUES($1,$2,$3::jsonb)',
    [recordId, month.rows[0].id, JSON.stringify(intent)]);
}

export async function assertExchangeCanVoid(recordId) {
  const row = (await query('SELECT attempted_at,safe_to_retry FROM return_exchange_postings WHERE record_id=$1', [recordId])).rows[0];
  if (row?.attempted_at && !row.safe_to_retry) {throw inventoryError('Recover the unconfirmed Inventory Transfer before voiding this exchange.', 409);}
}

async function exchangeRow(db, id) {
  return (await db(`SELECT p.*,m.location_id,m.month,m.external_id,m.transfer_id,r.status,r.netsuite_sync_status,
    r.netsuite_posting_policy FROM return_exchange_postings p JOIN return_exchange_months m ON m.id=p.month_id
    JOIN return_records r ON r.id=p.record_id WHERE p.record_id=$1`, [id])).rows[0];
}
async function event(db, id, status, details, actorOperatorId) {
  await db(`INSERT INTO return_sync_events(return_record_id,event_type,status,response_snapshot,actor_operator_id)
    VALUES($1,'inventory_transfer_exchange',$2,$3::jsonb,$4)`, [id,status,JSON.stringify(details),actorOperatorId]);
}
async function confirm(row, record, lines, actorOperatorId) {
  await withIndependentTransaction(async db => {
    await db('UPDATE return_exchange_months SET transfer_id=$2,transfer_ref=$3 WHERE id=$1', [row.month_id,record.id,record.tranId]);
    await db(`UPDATE return_exchange_postings SET confirmed_lines=$2::jsonb,safe_to_retry=false,updated_at=now() WHERE record_id=$1`,
      [row.record_id,JSON.stringify(lines)]);
    await db(`UPDATE return_records SET netsuite_stage='inventory_transfer',netsuite_transaction_id=$2,
      netsuite_transaction_ref=$3,netsuite_transaction_status='Posted',netsuite_sync_status='succeeded',
      netsuite_sync_error=NULL,netsuite_snapshot=$4::jsonb,netsuite_last_synced_at=now(),updated_at=now() WHERE id=$1`,
    [row.record_id,record.id,record.tranId,JSON.stringify({inventoryTransfer:{id:record.id,tranId:record.tranId,memo:record.memo},lines})]);
    await event(db,row.record_id,'succeeded',{transferId:record.id,transferRef:record.tranId,lines},actorOperatorId);
  });
}
async function resolveTransfer(row, remote) {
  if (row.transfer_id || row.proof?.transferId) {return remote.get(row.transfer_id || row.proof.transferId);}
  const identified = await remote.findExternal(row.external_id);
  if (identified) {return identified;}
  const matches = await remote.findMonthly({locationId:Number(row.location_id),month:row.month});
  if (matches.length > 1) {throw inventoryError('Multiple monthly Exchange transfers found. Reconciliation is required.',409);}
  return matches[0] || null;
}
async function recordPostingFailure(row,error,{uncertain,wrote,acknowledged,actorOperatorId}) {
  const definitive=!acknowledged && !error.exchangeWriteAcknowledged && error.netsuiteResponseReceived===true
    && error.status>=400 && error.status<500 && ![408,409,429].includes(error.status);
  const safe=!uncertain && (!wrote || definitive);
  await withIndependentTransaction(async tx => {
    await tx('UPDATE return_exchange_postings SET safe_to_retry=$2,updated_at=now() WHERE record_id=$1',[row.record_id,safe]);
    await tx(`UPDATE return_records SET netsuite_sync_status='failed',netsuite_sync_error=$2,updated_at=now() WHERE id=$1`,[row.record_id,String(error.message).slice(0,2000)]);
    await event(tx,row.record_id,'failed',{error:error.message,safeToRetry:safe},actorOperatorId);
  });
}
async function postingAttempt(db,row,remote,actorOperatorId) {
  let wrote=false, acknowledged=false;
  const uncertain=Boolean(row.attempted_at && !row.safe_to_retry);
  try {
    const destination=exchangeDestination(await remote.directory(),row.location_id);
    let record=await resolveTransfer(row,remote);
    if(record) {
      verifyExchangeTransfer(record,row.intent,destination);
      if(uncertain) {
        const recovered=confirmedExchangeLines(record,row.intent,row.proof);
        if(recovered) {return confirm(row,record,recovered,actorOperatorId);}
      }
    }
    if(uncertain) {throw inventoryError('The previous Inventory Transfer outcome is unknown. Reconcile it before posting again.',409);}
    const blocked=await db(`SELECT p.record_id FROM return_exchange_postings p JOIN return_records r ON r.id=p.record_id
      WHERE p.month_id=$1 AND p.record_id<>$2 AND p.attempted_at IS NOT NULL AND p.safe_to_retry=false
      AND r.netsuite_sync_status<>'succeeded' LIMIT 1`,[row.month_id,row.record_id]);
    if(blocked.rowCount) {throw inventoryError('Another exchange in this month has an unconfirmed transfer. Reconciliation is required.',409);}
    const live=await getOperatorNetSuitePostingPolicy({functionKey:'stock_exchange',locationId:row.location_id});
    if(!live.effective) {throw inventoryError('Stock exchange Inventory Transfer posting is disabled for this yard.',409);}
    const proof=exchangeProof(record);
    await withIndependentTransaction(async tx => {
      await tx(`UPDATE return_exchange_postings SET proof=$2::jsonb,attempted_at=now(),safe_to_retry=false,updated_at=now() WHERE record_id=$1`,[row.record_id,JSON.stringify(proof)]);
      await tx(`UPDATE return_records SET netsuite_sync_attempts=netsuite_sync_attempts+1,updated_at=now() WHERE id=$1`,[row.record_id]);
      await event(tx,row.record_id,'posting',proof,actorOperatorId);
    });
    wrote=true;
    if(record) {
      await remote.append(record.id,row.intent.lines);acknowledged=true;record=await remote.get(record.id);
    } else {
      record=await remote.create({externalId:row.external_id,customForm:{id:'164'},custbody2:{id:'8721'},custbody3:{id:'1'},
        subsidiary:{id:String(destination.subsidiaryId)},location:{id:String(destination.sourceId)},
        transferLocation:{id:String(destination.destinationId)},memo:row.intent.memo,tranDate:row.intent.date,
        inventory:{items:row.intent.lines}});
      acknowledged=true;
    }
    verifyExchangeTransfer(record,row.intent,destination);
    const confirmed=confirmedExchangeLines(record,row.intent,proof);
    if(!confirmed) {throw inventoryError('NetSuite has not confirmed the exchange lines. Reconciliation is required.',409);}
    await confirm(row,record,confirmed,actorOperatorId);
  } catch(error) {
    await recordPostingFailure(row,error,{uncertain,wrote,acknowledged,actorOperatorId});
    throw error;
  }
}

async function lockedExchangeAttempt(recordId,remote,actorOperatorId) {
  const client=await pool.connect(),keys=[];
  const db=(sql,params=[])=>client.query(sql,params);
  const lock=async key=>{
    const acquired=(await db('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[key])).rows[0].locked;
    if(acquired) {keys.push(key);}
    return acquired;
  };
  try {
    if(!await lock(`return-sync:${recordId}`)) {return false;}
    let row=await exchangeRow(db,recordId);
    if(!row) {throw inventoryError('Stock exchange was not found.',404);}
    if(!await lock(`stock-exchange-month:${row.month_id}`)) {return false;}
    row=await exchangeRow(db,recordId);
    if(['voided','rejected'].includes(row.status)) {throw inventoryError('This exchange is voided or rejected.',409);}
    if(row.netsuite_sync_status==='succeeded') {return true;}
    if(!row.netsuite_posting_policy?.effective) {throw inventoryError('This exchange was admitted locally with NetSuite posting disabled.',409);}
    await withNetSuiteOperationalWork('returns.exchange',()=>postingAttempt(db,row,remote,actorOperatorId));
    return true;
  } finally {
    let destroy=false;
    for(const key of keys.reverse()) {await db('SELECT pg_advisory_unlock(hashtext($1))',[key]).catch(()=>{destroy=true;});}
    client.release(destroy);
  }
}

export async function synchronizeStockExchange(recordId,{remote=stockExchangeNetSuite,actorOperatorId=null}={}) {
  const deadline=Date.now()+120000;
  for(let wait=25;;wait=Math.min(wait*2,500)) {
    if(await lockedExchangeAttempt(recordId,remote,actorOperatorId)) {return;}
    if(Date.now()>=deadline) {throw inventoryError('Another exchange is still posting. Retry this exchange shortly.',409);}
    // Release the connection while waiting so the active writer can persist its
    // checkpoint and the NetSuite authentication adapter can read its settings.
    await new Promise(resolve=>setTimeout(resolve,wait));
  }
}
