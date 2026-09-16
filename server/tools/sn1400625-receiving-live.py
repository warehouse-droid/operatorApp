"""Read-only candidate replay inside the deployed app; never submits a receipt."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
source = (root / "src/operator-netsuite-posting-targets.js").read_bytes()
candidate_hash = hashlib.sha256(source).hexdigest()
module = source.decode().replace('from "./', 'from "file:///app/src/')
url = "data:text/javascript;base64," + base64.b64encode(module.encode()).decode()
script = """
import assert from 'node:assert/strict';
import {pool,query,withTransaction} from '/app/src/db.js';
import {getReceivableReceivingOrder} from '/app/src/receiving-repository.js';
import {buildOperatorNetSuitePostingDraft} from '/app/src/operator-netsuite-posting-domain.js';
import {fetchOperatorNetSuiteSourceItemLinesFromNetSuite,fetchPoToLinkedTransactionsFromNetSuite,
  fetchScmReconciliationOrdersFromNetSuite} from '/app/src/netsuite.js';
const candidate=await import(CANDIDATE_URL);
pool.options.options='-c jit=off -c default_transaction_read_only=on -c statement_timeout=30000';
try {
  const fetcher=candidate.createOperatorNetSuitePostingLiveSourceFetcher({
    fetchReconciliationOrders:fetchScmReconciliationOrdersFromNetSuite,
    fetchSourceItemLines:fetchOperatorNetSuiteSourceItemLinesFromNetSuite,
    fetchLinkedTransactions:fetchPoToLinkedTransactionsFromNetSuite});
  const live=await fetcher({sourceOrderKind:'PO',sourceNetSuiteId:939701});
  const observedAt=new Date().toISOString();
  await withTransaction(async()=>{
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const order=await getReceivableReceivingOrder('-81664606940713',{includeNetSuiteClosed:true});
    assert.equal(order.tranid,'SN1400625');
    const source=candidate.createOperatorNetSuitePostingRealSourceResolver({query,fetchLiveSource:async()=>live});
    const resolve=candidate.createOperatorNetSuitePostingTargetResolver({getDeliveryOrder:async()=>null,
      getReceivableReceivingOrder:async()=>order,resolveRealSource:source});
    const resolution=await resolve({functionKey:'receiving',orderId:order.netsuite_id,
      orderType:'purchase_order',clientLocationId:1});
    const draft=buildOperatorNetSuitePostingDraft({...resolution,
      requestId:'bd8a2298-0c85-49a6-9f62-31b268140625',actorOperatorId:'read-only-replay',photoRefs:[],
      policy:{gateKey:'operator_netsuite_receiving_ir_3445',revision:1,effective:true,
        functionKey:'receiving',transactionType:'IR',locationId:1,yardCode:'3445'}});
    assert.equal(draft.steps.length,1);
    const step=draft.steps[0];
    assert.equal(step.sourceNetSuiteId,939701);
    assert.equal(step.payload.memo,'SN1400625');
    const selected=step.payload.item.items.filter(line=>line.itemReceive)
      .map(({orderLine,quantity,location})=>({orderLine,quantity,location}));
    assert.deepEqual(selected,[{orderLine:1,quantity:360,location:1},
      {orderLine:24,quantity:360,location:1},{orderLine:25,quantity:288,location:1}]);
    const inactive=(await query(`SELECT line_id,item_name,sync_exception FROM purchase_order_lines
      WHERE purchase_order_id=939701 AND netsuite_active=false ORDER BY line_id`)).rows;
    const aliases=resolution.targets[0].availableLines.flatMap(line=>[line.sourceLineKey,...line.sourceLineAliases]);
    assert.ok(inactive.every(line=>!aliases.includes(String(line.line_id))));
    console.log(JSON.stringify({mode:'read-only; candidate imported in memory; no receipt submitted',
      observedAt,candidateSha256:CANDIDATE_HASH,sourceOrderRef:step.sourceOrderRef,sourceNetSuiteId:step.sourceNetSuiteId,
      memo:step.payload.memo,liveSourceLines:live.lines.length,excludedInactive:inactive,selected,
      deselected:step.payload.item.items.filter(line=>!line.itemReceive).map(line=>line.orderLine),payload:step.payload},null,2));
  },{rollback:true});
} finally {await pool.end();}
""".replace("CANDIDATE_URL", json.dumps(url)).replace("CANDIDATE_HASH", json.dumps(candidate_hash))
result = subprocess.run(
    ["docker", "exec", "-i", "mbbs-operator-app-app-1", "node", "--input-type=module"],
    input=script, text=True, capture_output=True, timeout=300,
)
if result.returncode:
    raise SystemExit(result.stderr)
report = json.loads(result.stdout)
artifact = root / "test-artifacts/sn1400625-receiving/live-replay.json"
artifact.parent.mkdir(parents=True, exist_ok=True)
artifact.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
