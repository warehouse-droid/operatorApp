"""Capture scoped, read-only evidence for the requested TOB01208 repair."""
import datetime
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/to01208-delivery-prep')
DOCKER = ['sudo', '-n', 'docker']

SOURCE = r"""
import {closeDb} from './src/db.js';
import {fetchPoToReconciliationOrdersFromNetSuite,fetchPoToLinkedTransactionsFromNetSuite,
  fetchItemFulfillmentFromNetSuite,fetchItemReceiptFromNetSuite,suiteqlAll} from './src/netsuite.js';
import {operatorNetSuiteRequestPool} from './src/operator-netsuite-request-pool.js';
const read=work=>operatorNetSuiteRequestPool.run(work);
try {
  const sources=await read(()=>fetchPoToReconciliationOrdersFromNetSuite({orderIds:[1045195],kind:'TO',targetOnly:true,includeOpen:false}));
  const linked=await read(()=>fetchPoToLinkedTransactionsFromNetSuite([1045195]));
  const headers=await read(()=>suiteqlAll("SELECT id,tranid,type,status,BUILTIN.DF(status) AS status_text FROM transaction WHERE id IN (1045195,1045082)"));
  const transactions=new Map(linked.map(line=>[line.transactionType+':'+line.transactionId,line]));
  const records=[];
  for(const line of transactions.values()) {
    const record=await read(()=>line.transactionType==='ItemShip'
      ? fetchItemFulfillmentFromNetSuite(line.transactionId):fetchItemReceiptFromNetSuite(line.transactionId));
    records.push({type:line.transactionType,id:line.transactionId,sourceId:line.sourceOrderId,record});
  }
  console.log(JSON.stringify({at:new Date().toISOString(),headers,sources,linked,records,netSuiteWrites:0}));
} finally {await closeDb();}
"""


if __name__ == '__main__':
    os.umask(0o077)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    path = STATE / f'netsuite-{stamp}.private.json'
    data = json.loads(subprocess.check_output(DOCKER + ['exec', '-i', '-w', '/app',
        'mbbs-operator-app-webhook-worker-1', 'node', '--input-type=module'], input=SOURCE, text=True, cwd=ROOT))
    path.write_text(json.dumps(data, indent=2) + '\n')
    path.chmod(0o600)
    print(json.dumps({'at': data['at'], 'headers': data['headers'],
        'transactions': [{'type': entry['type'], 'id': entry['id'], 'ref': entry['record'].get('tranId')}
                         for entry in data['records']],
        'sourceLines': [{key: line.get(key) for key in ['stage', 'sourceLineKey', 'netsuite_order_line',
                                                     'itemId', 'quantity', 'unit', 'identityStatus']}
                        for source in data['sources'] for line in source['lines']],
        'linkedLines': [{key: line.get(key) for key in ['transactionType', 'transactionId', 'transactionRef',
                                                      'itemId', 'quantity', 'unit', 'status', 'sourceOrderLine']}
                        for line in data['linked']], 'evidence': str(path), 'netSuiteWrites': 0}, indent=2))
