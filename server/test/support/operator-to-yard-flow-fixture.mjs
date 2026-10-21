import crypto from 'node:crypto';
import { query, beginRollbackContext } from '../../src/db.js';
import { recordDeliveryLoad } from '../../src/delivery-repository.js';
import { recordReceivingReceipt } from '../../src/receiving-repository.js';
import { getOperatorNetSuitePostingPolicy } from '../../src/operator-netsuite-posting-policy-repository.js';

export const yardPhotos = ['r2://fixture/yard-a', 'r2://fixture/yard-b'];
export async function yardRollback(work) {
  const context = await beginRollbackContext();
  try { return await context.run(work); } finally { await context.rollback(); }
}
export async function seedYardTransfer(quantity = 5) {
  const key = crypto.randomUUID(), id = 8_977_000_000 + Math.floor(Math.random() * 100000);
  const f = { id, ref: `TO-YARD-${key}`, operator: `op-${key}`, plan: id + 1, load: 'yard-load', drop: `drop-${key}`, quantity };
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt) VALUES($1,$1,$1,'test','test')", [f.operator]);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,
    to_location_id,to_location,netsuite_active,outbound_operator_status,receiving_status,local_yard_order_status)
    VALUES($1,$2,'B','Pending Fulfillment',1,'3445',28,'2967',true,'packed','not_received','Open')`, [id, f.ref]);
  for (const stage of ['outbound', 'receiving']) {
    await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,item_type,
      quantity,unit,piece_qty,to_pcs,packed_piece_qty,received_piece_qty,confirmed,netsuite_active,location_id)
      VALUES($1,$2,$3,2299,$4,'InvtPart',$5,'PC',$5,1,$5,$5,true,true,$6)`,
    [id, stage, stage === 'outbound' ? 5073149 : 5073151, f.ref, quantity, stage === 'outbound' ? 1 : 28]);
  }
  for (const flag of ['operator_netsuite_delivery_prep_if_3445', 'operator_netsuite_receiving_ir_2967']) {
    await query('UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key=$1', [flag]);
  }
  return f;
}
export async function yardLoad(f) {
  await recordDeliveryLoad(f.id, f.operator, { photoDataUrls: yardPhotos, requestId: crypto.randomUUID() });
  return (await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IF' ORDER BY operator_record_id DESC", [f.id])).rows[0];
}
export async function yardReceive(f, quantity = f.quantity) {
  await query("UPDATE transfer_order_lines SET received_piece_qty=$2 WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id, quantity]);
  await recordReceivingReceipt(f.id, f.operator, { photoDataUrls: yardPhotos,
    payload: { item: { items: [{ orderLine: 5073151, itemReceive: true, quantity }] } }, response: { localOnly: true } });
  return (await query("SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR' ORDER BY operator_record_id DESC", [f.id])).rows[0];
}
export async function yardDeliver(f) {
  await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,date '2046-01-01'+($1::bigint % 100000)::int,'confirmed',1)", [f.plan]);
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,current_date,$3,'test','dropoff',$4::jsonb,'complete',now(),'{}')`, [f.drop, f.plan, f.load, JSON.stringify([f.ref])]);
}
export function yardPostingDependencies(f, type = 'IF') {
  return { getPolicy: input => getOperatorNetSuitePostingPolicy({ ...input, directAccessEnabled: true }),
    resolveSource: async () => ({ sourceOrderKind: 'TO', sourceNetSuiteId: f.id, sourceOrderRef: f.ref,
      availableLines: [{ sourceLineKey: type === 'IF' ? '5073149' : '5073151', orderLine: type === 'IF' ? 2 : 3,
        itemId: 2299, location: null, orderedQuantity: f.quantity, remainingQuantity: f.quantity, completedQuantity: 0 }] }) };
}
