"""Check the real weight-only incident using a read-only transaction."""
import base64
import json
from pathlib import Path
import re
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
candidate = "--candidate" in sys.argv
module_names = ["src/dispatch-executed-order-review.js", "src/dispatch-executed-order-review-repository.js"]
urls = {}
for name in module_names:
    if candidate:
        source = (server / name).read_text()
        source = re.sub(r'([\"\'])\./([^\"\']+)\1', lambda match: match[1] + urls.get("src/" + match[2], "file:///app/src/" + match[2]) + match[1], source)
        urls[name] = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    else:
        urls[name] = "file:///app/" + name

script = r'''
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {listDispatchOrders} from './src/dispatch-repository.js';
import {persistedDispatchPlan} from './src/dispatch-plan-fence.js';
const {buildPlannedOrderReviews,executedOrderChanges}=await import(DOMAIN);
const {getDispatchExecutedOrderReviews}=await import(REPOSITORY);
try {await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  await query("SET LOCAL statement_timeout='20s'");
  const row=(await query(`SELECT p.id,p.plan_date,p.status,p.revision,p.note,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=340`)).rows[0];
  const plan=persistedDispatchPlan(row);
  const sources=await listDispatchOrders({exactOrderRefs:['SN1400072','SOA09413'],includeHiddenScm:true,
    includeFulfilledSalesDeliveries:true,includeInactiveSalesOrderLines:false,
    includeAllDiscoverableScmPurchaseOrders:true,unboundedPerType:true});
  const source=sources.find(order=>order.id==='SN1400072');
  const saved=plan.orders.find(order=>order.id==='SN1400072');
  assert.equal(source.items.length,2);
  assert.equal(source.weight,77531.938);
  assert.equal(saved.weight,77531.9376);
  const ledger=(await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=340 AND order_ref='SN1400072' ORDER BY token")).rows;
  assert.ok(ledger.length>0);
  const notices=await getDispatchExecutedOrderReviews(340);
  assert.equal(notices.filter(notice=>['SN1400072','SOA09413'].includes(notice.orderRef)).length,0);
  assert.deepEqual((await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=340 AND order_ref='SN1400072' ORDER BY token")).rows,ledger);
  const hypothetical=structuredClone(source);
  hypothetical.items[0].quantity=Number(hypothetical.items[0].quantity)+1;
  const changed=buildPlannedOrderReviews({previousPlan:plan,sourceOrders:[hypothetical]});
  assert.equal(changed.length,1);
  assert.equal(changed[0].replanRequested,true);
  assert.ok(changed[0].changes.every(change=>change.field!=='weight'));
  console.log(JSON.stringify({readOnly:true,planId:340,revision:plan.revision,orderRef:source.id,
    savedWeight:saved.weight,currentWeight:source.weight,underlyingChanges:executedOrderChanges(saved,source),
    visibleIncidentNotices:0,ledgerRowsRetained:ledger.length,
    quantityChangesStillRequestReplan:true,weightInNotice:false}));
},{rollback:true});} finally {await closeDb();}
'''.replace("DOMAIN", json.dumps(urls[module_names[0]])).replace("REPOSITORY", json.dumps(urls[module_names[1]]))
result = subprocess.run(["docker", "exec", "-i", "mbbs-operator-app-app-1", "node", "--input-type=module"],
                        input=script, text=True, capture_output=True)
if result.returncode:
    errors = [line for line in result.stderr.splitlines() if ("Error" in line or "read-only" in line) and len(line) < 500]
    raise RuntimeError("Read-only incident check failed: " + " ".join(errors[-3:]))
report = json.loads(result.stdout)
report["candidate"] = candidate
target = server / "test-artifacts/dispatch-weight-notices" / ("candidate-live.json" if candidate else "live.json")
target.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
