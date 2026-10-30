// Operational, read-only inventory of live PO/TO transit states.
import {query,closeDb} from './src/db.js';
import {listScmSchedule} from './src/dispatch-repository.js';
import {enrichScmScheduleWithReconciliation} from './src/scm-reconciliation-repository.js';
try {
  const schedule = await listScmSchedule({kind:['PO','TO'],status:'In Transit'});
  const enriched = await enrichScmScheduleWithReconciliation(schedule,{includeDetails:true});
  const stored = (await query(`SELECT * FROM scm_transport_schedule WHERE order_kind IN ('PO','TO') AND status='In Transit' ORDER BY order_ref`)).rows;
  const states = (await query(`SELECT * FROM scm_reconciliation_order_state WHERE order_kind IN ('PO','TO') AND application_status='In Transit' ORDER BY source_order_ref`)).rows;
  const dependencies = (await query(`SELECT * FROM order_dependencies WHERE status='in_transit' ORDER BY transfer_order_ref`)).rows;
  const columns = (await query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('purchase_orders','transfer_orders','dispatch_scm_po_splits','receiving_receipt_records','driver_job_records','dispatch_order_completion_events','operator_load_records') ORDER BY table_name,ordinal_position`)).rows;
  console.log(JSON.stringify({at:new Date().toISOString(),schedule,enriched,stored,states,dependencies,columns}));
} finally { await closeDb(); }
