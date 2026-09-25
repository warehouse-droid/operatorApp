import crypto from "node:crypto";
import { query } from "../../src/db.js";
import { getReceivableReceivingOrder } from "../../src/receiving-repository.js";
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from "../../src/operator-netsuite-posting-targets.js";
import { buildOperatorNetSuitePostingDraft } from "../../src/operator-netsuite-posting-domain.js";
import { createOrReplayOperatorNetSuitePostingCommand } from "../../src/operator-netsuite-posting-repository.js";

export const parentId = 939701;
export const orderId = -81664606940713;
export const actor = "receiving-followup-test";
export const photos = ["data:image/png;base64,dGVzdDE=", "data:image/png;base64,dGVzdDI="];
export const incident = [[4737066, 1, 4863, 360, 1728, 792], [4851526, 24, 1229, 360, 1584, 576],
  [4851527, 25, 5022, 288, 792, 504], [4851536, 34, 1784, 28, 341, 159]];

export async function fixture() {
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,'Receiving test','test','test','operator',ARRAY['operator'],true)", [actor]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,netsuite_active)
    VALUES($1,'POB03669','E','Pending Billing/Partially Received',1,true),($2,'SN1400625','E','Pending Billing/Partially Received',1,true)`, [parentId, orderId]);
  const split = (await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref,status)
    VALUES($1,'POB03669',$2,'SN1400625','active') RETURNING id`, [parentId, orderId])).rows[0].id;
  const children = [];
  for (const [key, rest, item, quantity, total, completed] of incident) {
    const source = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_type,
      quantity,unit,location_id,netsuite_active,netsuite_received_qty,netsuite_received_baseline_qty)
      VALUES($1,$2,$3,$4,'InvtPart',$5,'PC',1,true,$6,0) RETURNING id`, [parentId, key, rest, item, total, completed])).rows[0];
    const child = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,
      quantity,unit,location_id,netsuite_active,pallet_qty,to_plt,received_pallet_qty,confirmed_at)
      VALUES($1,$2,$3,$4,$5,$5,'InvtPart',$6,'PC',1,true,$7,$8,$7,now()-interval '2 hours') RETURNING *`,
    [orderId, key, rest, item, item === 1784 ? "PALLET" : `PRODUCT-${item}`, quantity, item === 1784 ? 0 : quantity / 36, item === 1784 ? 0 : 36])).rows[0];
    children.push(child);
    await query(`INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,item_id,sales_qty)
      VALUES($1,$2,$3,$4,$5)`, [split, source.id, child.id, item, quantity]);
  }
  return { children, pallet: children[3], split };
}

export async function draft() {
  const source = createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true,
    fetchLiveSource: async () => { throw new Error("Unexpected live source fetch"); } });
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => null,
    getReceivableReceivingOrder, resolveRealSource: source });
  const resolution = await resolve({ functionKey: "receiving", orderId, orderType: "purchase_order", clientLocationId: 1 });
  return buildOperatorNetSuitePostingDraft({ ...resolution, requestId: crypto.randomUUID(), actorOperatorId: actor, photoRefs: photos,
    policy: { gateKey: "operator_netsuite_receiving_ir_3445", revision: 1, effective: true,
      functionKey: "receiving", transactionType: "IR", locationId: 1, yardCode: "3445" } });
}

export async function posted(command, id = 994070, ref = "IR14645") {
  await createOrReplayOperatorNetSuitePostingCommand(command);
  await query(`UPDATE operator_netsuite_posting_steps SET status='posted',netsuite_transaction_id=$2,netsuite_transaction_ref=$3,
    posted_at=now()-interval '1 hour' WHERE command_id=$1`, [command.requestId, id, ref]);
  await query("UPDATE operator_netsuite_posting_commands SET status='completed',completed_at=now() WHERE id=$1", [command.requestId]);
  await query("DELETE FROM operator_netsuite_posting_order_claims WHERE command_id=$1", [command.requestId]);
}

export async function legacyReceipt(command, { id = 994070, status = "partial_received", order = orderId } = {}) {
  return (await query(`INSERT INTO receiving_receipt_records(order_id,item_receipt_id,item_receipt_tranid,receipt_status,payload,response,created_at)
    VALUES($1,$2,'IR14645',$3,$4,$5,now()-interval '1 hour') RETURNING *`, [order, id, status,
    JSON.stringify(command.inputSnapshot.localPayload), JSON.stringify({ operatorNetSuitePosting: { commandId: command.requestId } })])).rows[0];
}
