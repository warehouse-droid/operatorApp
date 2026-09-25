import assert from "node:assert/strict";
import { query } from "../../src/db.js";

export const parent = 945685, child = -260063887792827;
export const incident = [
  [4759369,"OAK-PAV-AL-2424",152,152], [4759371,"OAK-RKT-HL-1248",72,72],
  [4759373,"OAK-RKT-SB-1472",126,126], [4759374,"OAK-RKT-SG-1272",108,0],
  [4759375,"OAK-RKT-SG-1448",84,84], [4878976,"OAK-RKT-AL-1472",126,126],
  [4878977,"OAK-PAV-AB-2424",304,0], [4878978,"OAK-RKT-AB-1248",72,72],
  [4878979,"OAK-PAV-BLK-1224",228,228], [4878980,"OAK-STEP-BLK-1672",48,48],
  [4878981,"OAK-PAV-HL-1224",456,228], [4878982,"OAK-RKT-HL-1272",108,108],
  [4878983,"OAK-RKT-HL-1472",126,126], [4878984,"OAK-PAV-HB-2424",456,456],
  [4890946,"OAK-PAV-AB-2424",248,248], [4890947,"OAK-RKT-HB-1672",288,288]
];
export async function fixture(rows = incident) {
  assert.equal(process.env.MBT_TEST_ISOLATED,"1");
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,netsuite_active)
    VALUES($1,'POB03684','B','Pending Receipt',1,true),($2,'#11619-1','B','Pending Receipt',1,true)`,[parent,child]);
  const split=(await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
    VALUES($1,'POB03684',$2,'#11619-1') RETURNING id`,[parent,child])).rows[0].id;
  const sources=[];
  for(const [key,sku,total,assigned] of rows){
    const conversion=key===4878981 ? 228 : total;
    const line=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
      quantity,unit,location_id,pallet_qty,to_plt,netsuite_received_qty,netsuite_received_baseline_qty,netsuite_active)
      VALUES($1,$2,$2,$3,$3,'InvtPart',$4,'SQFT',1,$5,$6,0,0,true) RETURNING *`,
      [parent,key,sku,total,total/conversion,conversion])).rows[0];
    sources.push(line);
    if(!assigned) continue;
    const row=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
      quantity,unit,location_id,pallet_qty,to_plt,netsuite_received_qty,netsuite_received_baseline_qty,netsuite_active)
      VALUES($1,$2,$2,$3,$3,'InvtPart',$4,'SQFT',1,$5,$6,0,0,true) RETURNING id`,
      [child,key,sku,assigned,assigned/conversion,conversion])).rows[0];
    await query(`INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,sales_qty,pallet_qty)
      VALUES($1,$2,$3,$4,$5)`,[split,line.id,row.id,assigned,assigned/conversion]);
  }
  return {split,sources};
}
