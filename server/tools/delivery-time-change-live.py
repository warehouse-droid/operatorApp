"""Read-only checks against deployed code for the user's named orders and case."""
import json
import subprocess
from pathlib import Path

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/delivery-time-change-20261008'
manifest = json.loads((release / 'manifest.json').read_text())
script = """import assert from 'node:assert/strict';
import {query,closeDb,withTransaction} from './src/db.js';
import {prioritizeDeliveryOrders} from './src/delivery-request-repository.js';
import {listSpecialPoReferenceAlerts} from './src/special-po-reference-alerts.js';
try {
  await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const refs=['SOB122368','SOB122358'];
    const {rows}=await query('SELECT card FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1::text[])',[refs]);
    const cards=await prioritizeDeliveryOrders(rows.map(row=>row.card));
    assert.equal(cards.length,2);
    const windows=cards.map(card=>({id:card.id,date:card.expectedDeliveryDate,start:card.windowStart,end:card.windowEnd,secured:card.deliveryApprovalPriority===true}));
    const approvals=await query("SELECT r.id,r.status,r.updated_at,r.data->'confirmedWindow' AS approved,r.data->'pendingWindow' AS pending,l.order_ref FROM delivery_requests r JOIN delivery_request_sales_orders l ON l.request_id=r.id WHERE l.order_ref=ANY($1::text[]) ORDER BY r.updated_at DESC,r.id DESC",[refs]);
    // Business records can change while the release is staged. Compare with the current approval.
    for(const card of windows) {
      const current=approvals.rows.find(row=>row.order_ref===card.id && row.status==='confirmed');
      assert.ok(current,'Named SO must have an active approval');
      assert.deepEqual({date:card.date,start:card.start,end:card.end},
        {date:current.approved.date,start:current.approved.start,end:current.approved.end});
      assert.equal(card.secured,true);
    }
    const {rows:[request]}=await query('SELECT id,requested_by,destination_location_id FROM sales_stock_requests WHERE request_ref=$1',['SPREQ-000043']);
    assert.ok(request);
    const {alerts}=await listSpecialPoReferenceAlerts({audience:'sales',operatorId:request.requested_by,authorizedStoreLocationIds:[Number(request.destination_location_id)]});
    const notices=alerts.filter(notice=>notice.requestId===Number(request.id))
      .map(({requestRef,displayRef,audience,fulfillmentMethod})=>({requestRef,displayRef,audience,fulfillmentMethod}));
    const receipt=await query("SELECT 1 FROM special_po_reference_alert_receipts WHERE request_id=$1 AND operator_id=$2 AND audience='sales'",[request.id,request.requested_by]);
    assert.ok(notices.length===1 || receipt.rowCount===1,'Named Sales notice is neither pending nor acknowledged');
    if(notices.length) assert.equal(notices[0].displayRef,'POB03993 / LOINC-037994');
    console.log(JSON.stringify({readOnly:true,windows,currentApprovals:approvals.rows,salesNotices:notices,alreadyAcknowledged:!notices.length && receipt.rowCount===1}));
  });
} finally {await closeDb();}
"""
image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', 'mbbs-operator-app-app-1'], text=True).strip()
assert image == manifest['candidateImageId']
result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
                        input=script, text=True, capture_output=True, timeout=40)
if result.returncode:
    (release / 'live-feature-check-error.log').write_text(result.stdout + result.stderr)
    raise RuntimeError('Read-only check failed; see live-feature-check-error.log')
evidence = {**json.loads(result.stdout), 'imageId': image, 'candidateTreeHash': manifest['candidateTreeHash']}
(release / 'live-feature-checks.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps(evidence, indent=2))
