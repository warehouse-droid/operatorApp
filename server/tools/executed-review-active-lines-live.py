"""Replay SOA09413 against the live mirror using a read-only transaction."""
import hashlib
import json
from pathlib import Path
import subprocess

server = Path(__file__).resolve().parent.parent
artifact = server / "test-artifacts/executed-review-active-lines"
container = "mbbs-operator-app-app-1"
files = ["src/dispatch-repository.js", "src/dispatch-executed-order-review.js"]
sources = {}
for file in files:
    live = subprocess.check_output(["docker", "exec", container, "cat", "/app/" + file])
    baseline = (artifact / "baseline" / Path(file).name).read_bytes()
    assert live == baseline, "Live source changed since baseline capture: " + file
    sources[file] = (server / file).read_text()

script = r'''
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {persistedDispatchPlan} from './src/dispatch-plan-fence.js';
const candidate = CANDIDATE;
const load = async name => import('data:text/javascript;base64,' + Buffer.from(candidate[name].replace(
  /(["'])\.\/([^"']+)\1/gu, (_match, quote, relative) => quote + 'file:///app/src/' + relative + quote
)).toString('base64'));
try {
  const {listDispatchOrders} = await load('src/dispatch-repository.js');
  const {buildPlannedOrderReviews} = await load('src/dispatch-executed-order-review.js');
  await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='20s'");
    const row = (await query(`SELECT p.id,p.plan_date,p.status,p.revision,p.note,s.orders,s.trucks,s.summary,s.saved_at
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=340`)).rows[0];
    const previousPlan = persistedDispatchPlan(row);
    const activity = (await query(`SELECT * FROM driver_job_records WHERE plan_id=340 AND status IN ('in_progress','complete')`)).rows;
    const common = {exactOrderRefs:['SOA09413'],includeHiddenScm:true,includeFulfilledSalesDeliveries:true,
      includeAllDiscoverableScmPurchaseOrders:true,unboundedPerType:true};
    const [historical] = await listDispatchOrders(common);
    const sourceOrders = await listDispatchOrders({...common,includeInactiveSalesOrderLines:false});
    const current = sourceOrders.find(order => order.id === 'SOA09413');
    assert.equal(historical.items.length,8);
    assert.equal(current.items.length,3);
    assert.equal(current.salesQty,1426.64);
    assert.equal(current.weight,50321.73);
    const falseReviews = buildPlannedOrderReviews({previousPlan,activity,sourceOrders:[historical]});
    const reviews = buildPlannedOrderReviews({previousPlan,activity,sourceOrders});
    assert.equal(falseReviews.length,1);
    assert.equal(falseReviews[0].changes.filter(change => change.field === 'item_added').length,5);
    assert.deepEqual(reviews,[]);
    const latest = (await query(`SELECT source_modified_at,received_at,completed_at FROM netsuite_order_webhook_inbox
      WHERE netsuite_order_id='1020598' ORDER BY received_at DESC LIMIT 1`)).rows[0];
    const ledger = (await query(`SELECT observed_at,acknowledged_at FROM dispatch_executed_order_reviews
      WHERE plan_id=340 AND order_ref='SOA09413' ORDER BY observed_at`)).rows;
    console.log(JSON.stringify({readOnly:true,planId:340,revision:previousPlan.revision,orderRef:'SOA09413',latest,
      historical:{items:historical.items.length,salesQty:historical.salesQty,weight:historical.weight},
      current:{items:current.items.length,salesQty:current.salesQty,weight:current.weight},falseAdditions:5,correctedReviews:reviews.length,ledger},null,2));
  },{rollback:true});
} finally { await closeDb(); }
'''.replace("CANDIDATE", json.dumps(sources))
result = subprocess.run(["docker", "exec", "-i", container, "node", "--input-type=module"],
                        input=script, text=True, capture_output=True)
if result.returncode:
    # Data-URL module stack frames contain source code; retain only the error line.
    lines = [line for line in result.stderr.splitlines() if "Error" in line and len(line) < 500]
    raise RuntimeError("Read-only replay failed: " + " ".join(lines[-3:]))
report = json.loads(result.stdout)
report["sources"] = {file: hashlib.sha256(sources[file].encode()).hexdigest() for file in files}
(artifact / "live-replay.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
