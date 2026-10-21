"""Apply the explicitly authorized D&H Bin 1 repair, retaining private audit snapshots."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbt-bin-corrections-20261015'
RECORDS = SERVER / 'deployments/mbt-bin-cancellation-20261015/data-repair'
APP = 'mbbs-operator-app-app-1'
LINE1 = 'e0395e35-3cfe-4a69-a864-e3442e4a10a2'
LINE2 = '2fc80caa-ec21-4256-b6be-ae840c9a6e31'
COMMAND = SERVER / 'tools/mbt-bin-cancel-undelivered.mjs'

def save(name, value):
    RECORDS.mkdir(parents=True, exist_ok=True)
    path = RECORDS / name
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)

def node(source, mode=None):
    args = ['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app']
    if mode:
        args += ['-e', 'MBT_CANCEL_DH_BIN1_MODE=' + mode]
    output = subprocess.check_output(args + [APP, 'node', '--input-type=module'], input=source)
    return json.loads(output)

def check_release():
    candidate = json.loads((OUT / 'validation.candidate.json').read_text())
    assert candidate['passed'] and candidate['fullGauntlet'] and candidate['cleanupVerified']
    assert hashlib.sha256(COMMAND.read_bytes()).hexdigest() == candidate['sourceHashes']['tools/mbt-bin-cancel-undelivered.mjs']
    prepared = json.loads((OUT / 'prepared.json').read_text())
    image = subprocess.check_output(['sudo', '-n', 'docker', 'inspect', '--format', '{{.Image}}', APP], text=True).strip()
    assert image == prepared['imageId'], 'The validated cancellation release must be live first'

def verify(before, after):
    old, new = before['snapshot'], after['snapshot']
    assert new['activeTotalMinor'] == 55000
    lines = new['mbt_contract_service_lines']
    assert next(line for line in lines if line['service_line_id'] == LINE1)['status'] == 'cancelled'
    for table, key in [('mbt_contract_service_lines', 'service_line_id'), ('mbt_service_visits', 'service_line_id')]:
        assert [row for row in new[table] if row[key] == LINE2] == [row for row in old[table] if row[key] == LINE2], 'Bin 2 changed'
    assert all(row['status'] == 'cancelled' for row in new['mbt_service_visits'] if row['service_line_id'] == LINE1)
    assert [row for row in new['mbt_frontdesk_charge_requests'] if row['status'] == 'confirmed'] == [row for row in old['mbt_frontdesk_charge_requests'] if row['status'] == 'confirmed']
    assert not any(row['status'] == 'draft' and row['service_line_id'] == LINE1 for row in new['mbt_frontdesk_charge_requests'])
    assert len(new['mbt_contract_amendments']) == len(old['mbt_contract_amendments']) + 1
    return node(b"""
import assert from 'node:assert/strict';
import { query, closeDb } from './src/db.js';
import { getMbtBinPlanning } from './src/mbt/bin-planning-service.js';
try {
  const result = await getMbtBinPlanning({planDate:'2026-10-15',search:'MBT-C-A4D22D0B57AD'},
    {capability:{environmentEnabled:true,databaseEnabled:true,pilotAuthorized:true}});
  assert.equal(result.pool.total,1);
  assert.equal(result.pool.items[0].mbt.serviceLineId,'2fc80caa-ec21-4256-b6be-ae840c9a6e31');
  assert.ok(result.trucks.some(truck=>truck.plate==='BINTEST'));
  const audit = (await query(`SELECT
    (SELECT count(*)::int FROM mbt_audit_events WHERE entity_id=$1 AND idempotency_key=$2) AS audit,
    (SELECT count(*)::int FROM mbt_command_receipts WHERE entity_id=$1 AND idempotency_key=$2) AS receipts,
    (SELECT count(*)::int FROM mbt_bin_assets) AS registered_assets`,
    ['e0395e35-3cfe-4a69-a864-e3442e4a10a2','dh-bin1-user-authorized-cancellation-20261015'])).rows[0];
  assert.equal(audit.audit,1); assert.equal(audit.receipts,1);
  console.log(JSON.stringify({pool:result.pool,trucks:result.trucks,audit}));
} finally { await closeDb(); }
""")

check_release()
mode = sys.argv[1]
if mode == 'preview':
    assert not (RECORDS / 'before.json').exists(), 'Preserve the original before snapshot'
    before = node(COMMAND.read_bytes(), 'preview')
    save('before.json', before)
    print(json.dumps({'previewSaved': True, 'activeTotalMinor': before['snapshot']['activeTotalMinor']}))
elif mode == 'apply':
    assert (RECORDS / 'before.json').exists(), 'Capture a before snapshot first'
    assert not (RECORDS / 'after.json').exists(), 'Use verify for an already applied repair'
    if (RECORDS / 'before-apply.json').exists():
        before = json.loads((RECORDS / 'before-apply.json').read_text())
    else:
        before = node(COMMAND.read_bytes(), 'preview')
        save('before-apply.json', before)
    after = node(COMMAND.read_bytes(), 'apply')
    save('after.json', after)
    verification = verify(before, after)
    save('verification.json', verification)
    print(json.dumps({'removedFromActive': 'D&H Bin 1', 'adjustmentMinor': -110000,
                      'activeTotalMinor': 55000, 'bin2Unchanged': True, 'auditVerified': True}))
elif mode == 'verify':
    before = json.loads((RECORDS / 'before-apply.json').read_text())
    after = node(COMMAND.read_bytes(), 'preview')
    save('verification.json', verify(before, after))
    print(json.dumps({'verified': True, 'activeTotalMinor': after['snapshot']['activeTotalMinor']}))
else:
    raise ValueError('Use preview, apply or verify')
