"""Read only the affected case's workflow evidence; do not modify business records."""
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
phase = sys.argv[1]
assert phase in ('before', 'after')
script = """
import {getBackorderRequest} from './src/backorder-request-service.js';
import {canLinkBackorderOrder} from './public/backorder-workflow.js';
import {closeDb} from './src/db.js';
try {
  const d=await getBackorderRequest(224,{audience:'scm'});
  console.log(JSON.stringify({id:d.id,requestRef:d.requestRef,revision:d.revision,stage:d.stage,
    salesOrderRef:d.salesOrderRef,purchaseOrderRef:d.purchaseOrderRef,
    scmPoLinkEligible:canLinkBackorderOrder(d,'purchase_order'),
    scmPoLinkVisible:!['closed','completed'].includes(d.stage)&&!d.purchaseOrderId&&canLinkBackorderOrder(d,'purchase_order'),
    lines:d.lines.map(line=>({id:line.id,supplyStatus:line.supplyStatus,salesDecision:line.salesDecision,stockCheckedAt:line.stockCheckedAt}))}));
} finally {await closeDb();}
"""
result = json.loads(subprocess.check_output(
    ['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
    input=script.encode(), timeout=30))
assert result['requestRef'] == 'STREQ-000133'
target = SERVER / 'deployments/backorder-po-recheck-20261019' / ('case-' + phase + '.json')
target.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
