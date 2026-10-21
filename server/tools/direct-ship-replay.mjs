import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "../src/db.js";
import { listOrderDependencies, completeDirectDependenciesForSalesOrderDrop } from "../src/order-dependency-repository.js";
import { projectDirectTransferResidual } from "../src/dispatch-to-route-projection.js";
import { assertDirectLinkedCargoPlanningAllowed } from "../src/dispatch-linked-cargo-repository.js";
import {refreshDirectShipCatalog} from "./direct-ship-refresh.mjs";
import {recoverDirectShipCompletions} from "./direct-ship-recover.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(new URL(process.env.DATABASE_URL).hostname, "db");
const result = { snapshot: process.env.DIRECT_SHIP_SNAPSHOT_NAME, externalWrites: 0, transfers: [], purchases: [], driverJobs: [], simulations: [], failures: [] };
const check = async (label, run) => { try { await run(); } catch(error) { result.failures.push({ label, message: error.message, code: error.code }); } };
const rows = async (sql, params=[]) => (await query(sql,params)).rows;
const count = async () => (await rows(`SELECT
  (SELECT count(*)::int FROM dispatch_order_completion_events) AS completions,
  (SELECT count(*)::int FROM order_dependency_receipts) AS receipts,
  (SELECT coalesce(sum(received_piece_qty),0)::text FROM transfer_order_lines WHERE line_stage='receiving') AS received_pieces`))[0];
const context = await beginRollbackContext();
try {
  await context.run(async () => {
    const dependencies = (await listOrderDependencies({ includeCancelled: true })).filter(row => row.mode === "direct_to_customer");
    const allocations = await rows("SELECT * FROM dispatch_so_po_allocations ORDER BY id");
    const directRefs = new Set(dependencies.flatMap(row => [row.canonicalSalesOrderRef,row.salesOrderRef]));
    allocations.forEach(row => { directRefs.add(row.sales_order_ref); directRefs.add(row.dispatch_target_ref); });
    result.inventory = { directTransferLinks: dependencies.length,
      activeTransferLinks: dependencies.filter(row => row.status!=="cancelled").length,
      cancelledTransferLinks: dependencies.filter(row => row.status==="cancelled").length,
      poAllocations: allocations.length, activePoAllocations: allocations.filter(row => row.status==="active").length,
      distinctLinkedSalesOrders: new Set([...dependencies.map(row=>row.canonicalSalesOrderRef),...allocations.map(row=>row.sales_order_ref)]).size };
    for (const dependency of dependencies) {
      const source = await rows(`SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'
        AND COALESCE(netsuite_active,true) ORDER BY id`,[dependency.transferOrderId]);
      const items = source.map(line=>({ lineRowId:String(line.id),itemId:line.item_id,sku:line.sku,
        quantity:Number(line.quantity||0),pallets:Number(line.pallet_qty||0),layers:Number(line.layer_qty||0),
        sections:Number(line.section_qty||0),pieces:Number(line.piece_qty||0),unit:line.unit }));
      const projected = projectDirectTransferResidual({id:dependency.transferOrderRef,type:"TO",items},dependency);
      const [sql] = await rows("SELECT dispatch_direct_to_has_residual($1) AS residual",[dependency.transferOrderId]);
      const entry = { ref:dependency.transferOrderRef,target:dependency.salesOrderRef,status:dependency.status,
        sourceLines:items.length, residual:sql.residual, projectedResidual:projected.toRouteProjection?.hasResidual ?? null };
      result.transfers.push(entry);
      if (dependency.status!=="cancelled" && items.length) {
        await check(`${entry.ref}: residual agreement`,()=>assert.equal(entry.projectedResidual,entry.residual));
        await check(`${entry.ref}: planning guard`,async()=> {
          if (sql.residual) await assertDirectLinkedCargoPlanningAllowed([entry.ref]);
          else await assert.rejects(assertDirectLinkedCargoPlanningAllowed([entry.ref]),{code:"DISPATCH_LINKED_CARGO_ONLY"});
        });
      }
    }
    for (const poId of [...new Set(allocations.map(row=>String(row.po_order_id)))]) {
      const [po] = await rows(`SELECT *,dispatch_po_link_fully_covers(netsuite_id) AS covered
        FROM purchase_orders WHERE netsuite_id=$1`,[poId]);
      assert.ok(po,`Linked PO ${poId} must exist`);
      const active = allocations.filter(row=>String(row.po_order_id)===poId && row.status==="active");
      const entry = { ref:po.dispatch_ref||po.tranid,originalRef:po.tranid,activeAllocations:active.length,covered:po.covered,
        salesRefs:[...new Set(active.map(row=>row.sales_order_ref))],targets:[...new Set(active.map(row=>row.dispatch_target_ref))] };
      result.purchases.push(entry);
      await check(`${entry.ref}: both PO aliases`,async()=> {
        for (const ref of [entry.ref,entry.originalRef]) {
          if (po.covered) await assert.rejects(assertDirectLinkedCargoPlanningAllowed([ref]),{code:"DISPATCH_LINKED_CARGO_ONLY"});
          else await assertDirectLinkedCargoPlanningAllowed([ref]);
        }
      });
    }
    const jobs = await rows(`SELECT * FROM driver_job_records WHERE status='complete' AND stop_type='dropoff'
      AND completed_at IS NOT NULL AND order_refs ?| $1::text[] ORDER BY completed_at,id`,[[...directRefs].filter(Boolean)]);
    result.inventory.recordedCompletedCustomerDrops=jobs.length;
    result.beforeReplay=await count();
    const [{last_event_id:lastEventId}]=await rows("SELECT coalesce(max(id),0)::text AS last_event_id FROM dispatch_order_completion_events");
    await query("SAVEPOINT actual_driver_replay");
    for (let iteration=0;iteration<2;iteration++) {
      for (const job of jobs) {
        await check(`${job.job_id}: replay ${iteration+1}`,async()=> {
          await query("UPDATE driver_job_records SET status=status WHERE id=$1",[job.id]);
          const replay = await completeDirectDependenciesForSalesOrderDrop({ salesOrderRefs:job.order_refs,driverJobId:job.job_id,
            planId:job.plan_id,planDate:job.plan_date,truckPlate:job.truck_plate,loadId:job.load_id,loadName:job.load_name });
          if (iteration===0) result.driverJobs.push({ jobId:job.job_id,orderRefs:job.order_refs,
            completedDependencies:replay.completed.length,alreadyCompletedDependencies:replay.alreadyCompleted.length });
        });
      }
      if (iteration===0) result.afterFirstReplay=await count();
      else { result.afterSecondReplay=await count(); await check("all Driver replay idempotence",()=>assert.deepEqual(result.afterSecondReplay,result.afterFirstReplay)); }
    }
    result.recoveredCompletions=await rows(`SELECT order_kind,order_ref,dispatch_completed_at,completion_evidence_id
      FROM dispatch_order_completion_events WHERE id>$1 ORDER BY order_kind,order_ref,completion_evidence_id`,[lastEventId]);
    await query("ROLLBACK TO SAVEPOINT actual_driver_replay");
    await check("completion recovery matches actual replay without touching Driver records or stock",async()=>{
      result.completionRecovery=await recoverDirectShipCompletions({apply:true});
      const expected=result.recoveredCompletions.map(row=>({kind:row.order_kind,ref:row.order_ref,time:new Date(row.dispatch_completed_at).toISOString(),job:row.completion_evidence_id}));
      const recovered=result.completionRecovery.map(row=>({kind:"PO",ref:row.order_ref,time:new Date(row.completed_at).toISOString(),job:row.job_id}));
      assert.deepEqual(recovered,expected);
      assert.deepEqual(await count(),result.afterFirstReplay);
      assert.deepEqual(await recoverDirectShipCompletions({apply:true}),[]);
    });
    const simulatedDrop = async (ref,kind,id,{planId=null,planDate="2026-09-25",loadId="replay-load",truckPlate="REPLAY"}={}) => {
      await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_plate,load_id,load_name,
        stop_id,stop_type,order_refs,status,completed_at,job_details) VALUES ($1,$2,$3::date,'isolated-replay',$4,$5,
        'Isolated replay',$1,'dropoff',$6::jsonb,'complete',now(),$7::jsonb)`,
      [id,planId,planDate,truckPlate,loadId,JSON.stringify([ref]),JSON.stringify({orderTypes:[kind],orders:[{orderRef:ref,orderType:kind}]})]);
    };
    for (const dependency of dependencies.filter(row=>!["received_local","cancelled"].includes(row.status))) {
      await query("SAVEPOINT direct_ship_simulation");
      await check(`${dependency.transferOrderRef}: simulated customer delivery`,async()=> {
        const jobId=`isolated-to-simulation-${dependency.id}`;
        const identity={planId:dependency.plannedPlanId,planDate:dependency.plannedDate||"2026-09-25",
          loadId:dependency.plannedLoadId||"replay-load",truckPlate:dependency.plannedTruckPlate||"REPLAY"};
        await simulatedDrop(dependency.canonicalSalesOrderRef,"SO",jobId,identity);
        const command={salesOrderRefs:[dependency.canonicalSalesOrderRef],driverJobId:jobId,...identity};
        const before=await rows("SELECT * FROM dispatch_order_completion_status WHERE order_kind='TO' AND order_ref=$1",[dependency.transferOrderRef]);
        const outcome=await completeDirectDependenciesForSalesOrderDrop(command);
        assert.ok([...outcome.completed,...outcome.alreadyCompleted].some(row=>String(row.dependencyId)===String(dependency.id)));
        const first=await count();
        await completeDirectDependenciesForSalesOrderDrop(command);
        assert.deepEqual(await count(),first);
        const [{residual}]=await rows("SELECT dispatch_direct_to_has_residual($1) AS residual",[dependency.transferOrderId]);
        if (residual) {
          if (!before.length) assert.equal((await rows("SELECT * FROM dispatch_order_completion_status WHERE order_kind='TO' AND order_ref=$1",[dependency.transferOrderRef])).length,0);
          await simulatedDrop(dependency.transferOrderRef,"TO",`${jobId}-remaining`,identity);
        }
        assert.ok((await rows("SELECT * FROM dispatch_order_completion_status WHERE order_kind='TO' AND order_ref=$1",[dependency.transferOrderRef])).length);
        result.simulations.push({type:"TO",ref:dependency.transferOrderRef,sourceStatus:dependency.status,residual,passed:true});
      });
      await query("ROLLBACK TO SAVEPOINT direct_ship_simulation");
    }
    for (const purchase of result.purchases.filter(row=>row.activeAllocations)) {
      await query("SAVEPOINT direct_ship_simulation");
      await check(`${purchase.ref}: simulated linked PO deliveries`,async()=> {
        for (const [index,ref] of purchase.salesRefs.entries()) {
          await simulatedDrop(ref,"SO",`isolated-po-simulation-${purchase.originalRef}-${index}`);
        }
        if (!purchase.covered) await simulatedDrop(purchase.ref,"PO",`isolated-po-remaining-${purchase.originalRef}`);
        assert.ok((await rows("SELECT * FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1",[purchase.ref])).length);
        const first=await count();
        await query("UPDATE driver_job_records SET status=status WHERE job_id LIKE $1",[`isolated-po-%${purchase.originalRef}%`]);
        assert.deepEqual(await count(),first);
        result.simulations.push({type:"PO",ref:purchase.ref,targets:purchase.salesRefs.length,residual:!purchase.covered,passed:true});
      });
      await query("ROLLBACK TO SAVEPOINT direct_ship_simulation");
    }
    result.migrationCorrections = await rows("SELECT order_ref,reason FROM dispatch_direct_ship_completion_corrections ORDER BY completion_event_id");
    await check("corrections preserve immutable evidence and exclude only the corrected event",async()=> {
      const [{originals,effective}]=await rows(`SELECT
        (SELECT count(*)::int FROM dispatch_direct_ship_completion_corrections correction
          JOIN dispatch_order_completion_events event ON event.id=correction.completion_event_id) AS originals,
        (SELECT count(*)::int FROM dispatch_direct_ship_completion_corrections correction
          JOIN dispatch_effective_order_completion_events event ON event.id=correction.completion_event_id) AS effective`);
      assert.equal(originals,result.migrationCorrections.length); assert.equal(effective,0);
    });
    await check("derived planner cards reflect corrected completion and cargo",async()=>{
      const beforeRefresh=await count();
      result.catalogRefresh=await refreshDirectShipCatalog();
      assert.deepEqual(await count(),beforeRefresh,"catalog refresh must not create receipts or delivery events");
    });
    result.passed=result.failures.length===0;
    await writeFile("test-artifacts/replay.json",JSON.stringify(result,null,2)+"\n");
    process.stdout.write(JSON.stringify({ inventory:result.inventory,simulations:result.simulations.length,passed:result.passed,failures:result.failures,
      correctedPartialTransfers:result.migrationCorrections.map(row=>row.order_ref),idempotent:JSON.stringify(result.afterFirstReplay)===JSON.stringify(result.afterSecondReplay) })+"\n");
  });
} finally { await context.rollback(); await closeDb(); }
if (!result.passed) process.exitCode=1;
