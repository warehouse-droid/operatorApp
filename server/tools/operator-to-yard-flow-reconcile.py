"""Apply audited per-TO maintenance; no NetSuite mutation function is imported."""
import base64
import collections
import importlib.util
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('to_yard_deploy', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
STATE, ARTIFACT = release.STATE, release.ARTIFACT


def source_module(name):
    source = (ROOT / 'server/tools' / name).read_text().replace("from '../src/", "from 'file:///app/src/")
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()


def execution_source():
    source = (ROOT / 'server/tools/operator-to-yard-flow-reconcile.mjs').read_text()
    for name in ['operator-to-yard-flow-reconciliation-plan.mjs', 'operator-to-yard-flow-reconciliation-proof.mjs']:
        source = source.replace("'./" + name + "'", json.dumps(source_module(name)))
    return source.replace("from '../src/", "from './src/")


def load_evidence():
    evidence = json.loads((STATE / 'netsuite-audit.private.json').read_text())
    for name in ['netsuite-supplement.private.json', 'netsuite-legacy-receiving.private.json']:
        evidence['records'].extend(json.loads((STATE / name).read_text())['records'])
    diagnostic = json.loads((STATE / 'netsuite-legacy-receiving.private.json').read_text())
    matches = [row for row in diagnostic['missingIdentity'] if row['type'] == 'TrnfrOrd' and row['tranid'] == 'TOB00025' and row['status'] == 'G']
    assert len(matches) == 1, 'The historical source identity must remain uniquely verified'
    header = {**matches[0], 'status_text': 'Transfer Order : Received'}
    existing_headers = [row for row in evidence['headers'] if str(row['id']) == str(header['id'])]
    if existing_headers:
        assert len(existing_headers) == 1 and existing_headers[0]['tranid'] == header['tranid'] and existing_headers[0]['status'] == 'G'
    else:
        evidence['headers'].append(header)
    evidence['historicalIdentityAliases'] = [{'localId': '777039', 'sourceId': str(header['id']), 'orderRef': 'TOB00025',
                                             'sourceRecordType': 'TrnfrOrd', 'verifiedAt': diagnostic['at']}]
    return evidence


def supplement():
    evidence = json.loads((STATE / 'netsuite-audit.private.json').read_text())
    audit = json.loads((STATE / 'audit-before.private.json').read_text())
    headers = {str(row['id']): row for row in evidence['headers']}
    loaded = {str(row['record']['order_id']) for row in audit['loads'] if row['record']['load_type'] == 'transfer_order_load'
              and headers.get(str(row['record']['order_id']), {}).get('status') not in [None, 'G', 'H']}
    candidates = {(row['transactionType'], row['transactionId']): row for row in evidence['linked']
                  if str(row['sourceOrderId']) in loaded and row['transactionType'] == 'ItemShip'
                  and not any(record['type'] == row['transactionType'] and record['id'] == row['transactionId'] for record in evidence['records'])}
    source = "import {fetchItemFulfillmentFromNetSuite} from './src/netsuite.js';import {closeDb} from './src/db.js';\n"
    source += 'const candidates=' + json.dumps(list(candidates.values())) + ';const records=[];\n'
    source += "try {for(const line of candidates){records.push({type:line.transactionType,id:line.transactionId,sourceId:line.sourceOrderId,record:await fetchItemFulfillmentFromNetSuite(line.transactionId)});}console.log(JSON.stringify(records));}finally{await closeDb();}"
    result = release.run(release.DOCKER + ['exec', '-i', '-w', '/app', release.SERVICES['webhook-worker'], 'node', '--input-type=module'], input=source)
    records = json.loads(result)
    release.save(STATE / 'netsuite-supplement.private.json', {'at': evidence['at'], 'records': records, 'netSuiteWrites': 0})
    print(json.dumps({'additionalExistingIfRecords': len(records), 'netSuiteWrites': 0}))


def reconcile(mode):
    apply = mode == 'apply'
    target = STATE / f'reconciliation-{mode}.private.json'
    assert not target.exists(), 'Preserve the existing reconciliation evidence'
    evidence = load_evidence()
    source = execution_source() + '\nimport {closeDb} from "./src/db.js";\n'
    source += 'const evidence=' + json.dumps(evidence) + ';\n'
    source += 'try {const ids=(await query("SELECT netsuite_id FROM transfer_orders ORDER BY netsuite_id")).rows;\n'
    source += 'for(const row of ids){let result;for(let attempt=0;attempt<3;attempt++){try{result=await reconcileTransferOrder(row.netsuite_id,evidence,{apply:' + str(apply).lower() + '});break;}catch(error){if(["40P01","55P03"].includes(error.code)&&attempt<2)continue;throw error;}}console.log(JSON.stringify(result));}\n'
    source += '}finally{await closeDb();}\n'
    rows = []
    process = subprocess.Popen(release.DOCKER + ['exec', '-i', '-w', '/app', release.SERVICES['app'], 'node', '--input-type=module'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    process.stdin.write(source)
    process.stdin.close()
    for line in process.stdout:
        row = json.loads(line)
        rows.append(row)
        release.save(STATE / f'reconciliation-{mode}.partial.private.json', {'orders': rows})
        if len(rows) % 100 == 0:
            print(f"{mode}: reconciled {len(rows)} TOs", flush=True)
    code = process.wait()
    assert code == 0, f'Reconciliation exited {code}; completed per-order transactions and evidence retained'
    summary = {'orders': len(rows), 'classifications': dict(collections.Counter(row['kind'] for row in rows)),
               'changedOrders': sum(row['writes'] > 0 for row in rows), 'changedHeaders': sum(row['changedHeader'] for row in rows),
               'changedLines': sum(row['changedLines'] for row in rows), 'addedReceivingLines': sum(row['addedReceivingLines'] for row in rows),
               'reactivatedLines': sum(row['reactivatedLines'] for row in rows),
               'recoveredIfJobs': sum(len(row['recoveredIfJobs']) for row in rows), 'capturedLoadJobs': sum(len(row['capturedLoadJobs']) for row in rows),
               'issues': [{'orderRef': row['orderRef'], 'issues': row['issues']} for row in rows if row['issues']], 'netSuiteWrites': 0}
    release.save(target, {'at': evidence['at'], 'summary': summary, 'orders': rows})
    release.save(ARTIFACT / f'reconciliation-{mode}-summary.json', summary)
    print(json.dumps(summary, indent=2))


def legacy_evidence():
    evidence = json.loads((STATE / 'netsuite-audit.private.json').read_text())
    evidence['records'].extend(json.loads((STATE / 'netsuite-supplement.private.json').read_text())['records'])
    candidates = {(row['transactionType'], row['transactionId']): row for row in evidence['linked']
                  if row['sourceOrderRef'] in ['TOB01134', 'TOB01200'] and row['transactionType'] == 'ItemShip'
                  and not any(record['type'] == row['transactionType'] and record['id'] == row['transactionId'] for record in evidence['records'])}
    source = "import {fetchItemFulfillmentFromNetSuite,suiteqlAll} from './src/netsuite.js';import {closeDb} from './src/db.js';\n"
    source += 'const candidates=' + json.dumps(list(candidates.values())) + ';const records=[];\n'
    source += "try {for(const line of candidates){records.push({type:line.transactionType,id:line.transactionId,sourceId:line.sourceOrderId,record:await fetchItemFulfillmentFromNetSuite(line.transactionId)});}const missingIdentity=await suiteqlAll(\"SELECT id,type,tranid,status FROM transaction WHERE id=777039 OR (type='TrnfrOrd' AND tranid='TOB00025')\");console.log(JSON.stringify({records,missingIdentity,at:new Date().toISOString(),netSuiteWrites:0}));}finally{await closeDb();}"
    result = release.run(release.DOCKER + ['exec', '-i', '-w', '/app', release.SERVICES['webhook-worker'], 'node', '--input-type=module'], input=source)
    data = json.loads(result)
    release.save(STATE / 'netsuite-legacy-receiving.private.json', data)
    print(json.dumps({'additionalExistingIfRecords': len(data['records']), 'missingIdentityMatches': len(data['missingIdentity']), 'netSuiteWrites': 0}))


def enable_legacy():
    evidence = load_evidence()
    source = execution_source() + '\nimport {closeDb} from "./src/db.js";\n'
    source += 'const evidence=' + json.dumps(evidence) + ';const result=[];\n'
    source += "try{for(const ref of ['TOB01134','TOB01200']){const order=(await query('SELECT netsuite_id FROM transfer_orders WHERE tranid=$1',[ref])).rows;if(order.length!==1)throw new Error('Legacy transfer reference is not unique.');result.push(await enableLegacyTransferReceiving(order[0].netsuite_id,evidence));}console.log(JSON.stringify(result));}finally{await closeDb();}"
    result = release.run(release.DOCKER + ['exec', '-i', '-w', '/app', release.SERVICES['app'], 'node', '--input-type=module'], input=source)
    data = json.loads(result)
    release.save(STATE / 'legacy-receiving-enabled.private.json', data)
    release.save(ARTIFACT / 'legacy-receiving-enabled.json', data)
    print(json.dumps(data, indent=2))


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'supplement': supplement()
    elif sys.argv[1] == 'legacy-evidence': legacy_evidence()
    elif sys.argv[1] == 'enable-legacy': enable_legacy()
    else:
        assert sys.argv[1] in ['plan', 'plan-final', 'plan-ready', 'apply', 'verify']
        reconcile(sys.argv[1])
