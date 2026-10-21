"""Read-only preview of the candidate's window overlay for the user's two SOs."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/delivery-so-linkage-20261008'
source = (release / 'candidate/src/delivery-request-repository.js').read_text()
functions = []
for name in ['orderRefs', 'prioritizeDeliveryOrders', 'applyDeliveryOrderWindow']:
    match = re.search(r'^(?:export )?(?:async )?function ' + name + r'\(', source, re.M)
    assert match, name
    end = re.search(r'^}', source[match.start():], re.M)
    assert end, name
    functions.append(source[match.start():match.start() + end.end()].removeprefix('export '))
script = """import {query,closeDb,withTransaction} from './src/db.js';
""" + '\n'.join(functions) + """
try {
  await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const refs=['SOB122368','SOB122358'];
    const {rows}=await query('SELECT card FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1::text[])',[refs]);
    const cards=await prioritizeDeliveryOrders(rows.map(row=>row.card));
    console.log(JSON.stringify(cards.map(card=>({id:card.id,date:card.expectedDeliveryDate,start:card.windowStart,end:card.windowEnd,secured:card.deliveryApprovalPriority===true})),null,2));
  });
} finally {await closeDb();}
"""
result = subprocess.run(['docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module'],
                        input=script, text=True, capture_output=True, check=True, timeout=30)
cards = json.loads(result.stdout)
assert len(cards) == 2
assert all(card['start'] == '08:00' and card['end'] == '09:00' and card['secured'] for card in cards)
evidence = {'readOnly': True, 'candidateSourceHash': hashlib.sha256(source.encode()).hexdigest(), 'cards': cards}
(server / 'test-artifacts/delivery-so-linkage-20261008/live-readonly-candidate-preview.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps(evidence,indent=2))
