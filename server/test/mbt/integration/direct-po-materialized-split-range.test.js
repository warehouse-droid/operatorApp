import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { listScmSchedule } from '../../../src/dispatch-repository.js';

after(closeDb);

for (let suffix = 1; suffix <= 20; suffix += 1) {
  test(`split S${suffix} advances its linked PO through Direct ship, In Transit and Completed`, async () => {
    assert.equal(process.env.MBT_TEST_ISOLATED, '1');
    const transaction = await beginRollbackContext();
    try {
      await transaction.run(async () => {
        const poId = -997152000 - suffix;
        const soId = poId - 100;
        const poRef = `SN-SPLIT-RANGE-${suffix}`;
        const soRef = `SO-SPLIT-RANGE-S${suffix}`;
        const groupRef = `GO-SPLIT-RANGE-${suffix}`;
        await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active)
          VALUES($1,$2,'B','Pending Receipt',true)`, [poId, poRef]);
        await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active)
          VALUES($1,$2,'B','Pending Fulfillment',true)`, [soId, soRef]);
        await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,status) VALUES('PO',$1,'Queued')", [poRef]);
        const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2026-10-13','confirmed') RETURNING id")).rows[0];
        const sales = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_type,
          item_name,sku,item_description,quantity,unit,netsuite_active)
          VALUES($1,4997388,2055,'NonInvtPart','MBBS-Special Order','MBBS-Special Order','Umbriano 24x24',1984,'SQFT',true)
          RETURNING id`, [soId])).rows[0];
        const purchase = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_type,
          item_name,sku,item_description,quantity,unit,netsuite_active)
          VALUES($1,5023808,2055,'NonInvtPart','MBBS-Special Order','MBBS-Special Order','Umbriano 24x24',1984,'SQFT',true)
          RETURNING id`, [poId])).rows[0];
        const allocation = (await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
          po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
          VALUES($1,$2,$3,$4,$5,$6,2055,1984,$7,'group',$8) RETURNING id`,
        [soId, soRef, sales.id, poId, poRef, purchase.id, groupRef, `${groupRef}::${soRef}::${sales.id}`])).rows[0];
        const group = {
          id: groupRef, type: 'SO', childOrders: [soRef],
          childOrderDetails: [{ id: soRef, type: 'SO', items: [
            { lineRowId: 470031, lineId: 4997388, itemId: 2055, quantity: 1984, splitQty: 1984, unit: 'SQFT' }
          ] }]
        };
        await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
          VALUES($1,'SO',$2,'2026-10-13',$3::jsonb,$3::jsonb)`, [groupRef, plan.id, JSON.stringify(group)]);
        assert.deepEqual((await query('SELECT dispatch_po_allocation_delivery_refs($1) AS refs', [allocation.id])).rows[0].refs, [soRef]);
        const status = async () => (await listScmSchedule({ exactRefs: [poRef] }))[0].calculatedStatus;
        assert.equal(await status(), 'Direct ship');
        for (const [stop, expected] of [['pickup', 'In Transit'], ['dropoff', 'Completed']]) {
          await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,load_id,stop_id,
            stop_type,order_refs,status,completed_at,job_details)
            VALUES($1,$2,'2026-10-13','range-test-driver','range-test-load',$1,$3,$4::jsonb,'complete',
              '2026-10-13T15:39:49.216Z',$5::jsonb)`,
          [`range-${suffix}-${stop}`, plan.id, stop, JSON.stringify([soRef]),
            JSON.stringify({ orderTypes: ['SO'], orders: [{ orderRef: soRef, orderType: 'SO' }] })]);
          assert.equal(await status(), expected);
        }
      });
    } finally {
      await transaction.rollback();
    }
  });
}
