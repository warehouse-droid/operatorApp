import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query, withTransaction } from "../../../src/db.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../../../src/scm-reconciliation-repository.js";

after(closeDb);
const migrationPath = new URL("../../../migrations/256_direct_linked_po_transport_lifecycle.sql", import.meta.url);
const casesPath = new URL("../fixtures/direct-linked-po-status-cases.json", import.meta.url);

async function seedCapturedCases(cases) {
  const salesOrders = new Map();
  const salesLines = new Map();
  const jobs = new Map();
  for (const entry of cases) {
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,vendor,status,status_text,
      destination_location_id,destination_location,dispatch_vendor_yard,initial_scm_status,netsuite_active)
      VALUES($1,$2,$3,'Replay Vendor','B','Pending Receipt',15,'12441','Replay Pickup','Queued',true)`,
    [entry.id,entry.tranid,entry.ref]);
    await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,status) VALUES('PO',$1,'Queued')", [entry.ref]);
    for (const line of entry.lines) {
      await query(`INSERT INTO purchase_order_lines(id,purchase_order_id,line_id,item_id,item_name,sku,
        item_description,item_type,unit,quantity,pallet_qty,layer_qty,section_qty,piece_qty,
        received_pallet_qty,received_layer_qty,received_section_qty,received_piece_qty,
        netsuite_received_qty,netsuite_received_baseline_qty,received_sales_qty,netsuite_active)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true)`,
      [line.id,entry.id,line.line_id,line.item_id,line.item_name,line.sku,line.item_description,
        line.item_type,line.unit,line.quantity,line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty,
        line.received_pallet_qty,line.received_layer_qty,line.received_section_qty,line.received_piece_qty,
        line.netsuite_received_qty,line.netsuite_received_baseline_qty,line.received_sales_qty]);
    }
    for (const allocation of entry.allocations) {
      salesOrders.set(allocation.sales_order_id, allocation.sales_order_ref);
      salesLines.set(allocation.sales_line_id, allocation);
    }
    for (const job of entry.jobs) { jobs.set(job.job_id, job); }
  }
  for (const [id, ref] of salesOrders) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,
      outbound_location_id,outbound_location,fulfillment_status,netsuite_active)
      VALUES($1,$2,'Replay Customer','B','Pending Fulfillment',15,'12441','open',true)`, [id,ref]);
  }
  for (const [id, allocation] of salesLines) {
    await query(`INSERT INTO sales_order_lines(id,sales_order_id,item_id,item_name,sku,quantity,unit,netsuite_active)
      VALUES($1,$2,$3,'Replay Product','Replay Product',$4,'SQFT',true)`,
    [id,allocation.sales_order_id,allocation.item_id,allocation.allocated_sales_qty]);
  }
  for (const entry of cases) {
    for (const allocation of entry.allocations) {
      await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
        po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,allocated_pallet_qty,
        allocated_layer_qty,allocated_section_qty,allocated_piece_qty,dispatch_target_ref,dispatch_target_line_key,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [allocation.sales_order_id,allocation.sales_order_ref,allocation.sales_line_id,entry.id,entry.ref,
        allocation.po_line_id,allocation.item_id,allocation.allocated_sales_qty,allocation.allocated_pallet_qty,
        allocation.allocated_layer_qty,allocation.allocated_section_qty,allocation.allocated_piece_qty,
        allocation.dispatch_target_ref,allocation.dispatch_target_line_key,allocation.status]);
    }
  }
  for (const job of jobs.values()) {
    await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,stop_type,order_refs,status,
      completed_at,job_details,load_id,load_name,stop_id)
      VALUES($1,$2,'replay-driver',$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10)`,
    [job.job_id,job.plan_date,job.stop_type,JSON.stringify(job.order_refs),job.status,job.completed_at,
      JSON.stringify(job.job_details),job.load_id,job.load_name,job.stop_id]);
  }
}

async function snapshot(ids) {
  return (await query(`SELECT jsonb_build_object(
    'headers',(SELECT jsonb_agg(to_jsonb(po) ORDER BY netsuite_id) FROM purchase_orders po WHERE netsuite_id=ANY($1::bigint[])),
    'lines',(SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM purchase_order_lines line WHERE purchase_order_id=ANY($1::bigint[])),
    'links',(SELECT jsonb_agg(to_jsonb(allocation) ORDER BY id) FROM dispatch_so_po_allocations allocation WHERE po_order_id=ANY($1::bigint[])),
    'driver',(SELECT jsonb_agg(to_jsonb(job) ORDER BY id) FROM driver_job_records job WHERE driver_login='replay-driver')
  ) AS data`, [ids])).rows[0].data;
}

test("the three captured orders retain exact delivery dates and pickup-only state through migration and rollback", async () => {
  await query(await readFile(new URL("../../../migrations/253_direct_ship_netsuite_posting.sql", import.meta.url), "utf8"));
  await query(await readFile(migrationPath, "utf8"));
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const cases = JSON.parse(await readFile(casesPath, "utf8"));
      const refs = cases.map(entry => entry.ref);
      const ids = cases.map(entry => entry.id);
      const oldSql = await readFile(new URL("../../../migrations/230_direct_ship_lifecycle.sql", import.meta.url), "utf8");
      await query(oldSql.slice(oldSql.indexOf("CREATE OR REPLACE FUNCTION dispatch_linked_transport_delivery_ready("),
        oldSql.indexOf("-- A remaining-cargo delivery")));
      await query(oldSql.slice(oldSql.indexOf("CREATE OR REPLACE FUNCTION dispatch_project_direct_po_link_completion("),
        oldSql.indexOf("-- Preserve the original event")));
      await seedCapturedCases(cases);
      const before = await snapshot(ids);
      const completions = () => query("SELECT * FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=ANY($1::text[])", [refs]);
      assert.equal((await completions()).rows.length, 0, "the old contract reproduces both missing completions");
      const migration = await readFile(migrationPath, "utf8");
      const verify = async () => {
        const rows = await listScmSchedule({ exactRefs: refs });
        const enriched = await enrichScmScheduleWithReconciliation(rows);
        for (const entry of cases) {
          const row = rows.find(candidate => candidate.orderRef === entry.ref);
          assert.equal(row?.calculatedStatus, entry.expectedStatus, entry.ref);
          assert.equal(row?.dispatchCompletedAt, entry.expectedCompletedAt, entry.ref);
          assert.equal(enriched.find(candidate => candidate.orderRef === entry.ref)?.calculatedStatus, entry.expectedStatus);
        }
        assert.equal((await completions()).rows.length, 2);
        assert.equal((await query("SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=ANY($1::bigint[])", [ids])).rows.length, 0);
        assert.deepEqual(await snapshot(ids), before);
      };
      await withTransaction(async () => {
        await query(migration);
        await verify();
      }, { rollback: true });
      assert.equal((await completions()).rows.length, 0, "migration rehearsal leaves no committed completions");
      await query(migration);
      await verify();
      const firstIds = (await completions()).rows.map(row => row.completion_event_id).sort();
      await query(migration);
      await verify();
      assert.deepEqual((await completions()).rows.map(row => row.completion_event_id).sort(), firstIds);
    });
  } finally {
    await context.rollback();
  }
});
