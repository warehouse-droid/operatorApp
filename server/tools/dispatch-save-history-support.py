#!/usr/bin/env python3
"""Read-only supporting records for the private retained-history replay."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1] / 'test-artifacts/dispatch-save-reliability/private-history/support'
root.mkdir(parents=True, mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
program = r'''
import { pool } from './src/db.js';
import { once } from 'node:events';
const tables = ['sales_orders','sales_order_lines','purchase_orders','purchase_order_lines',
  'transfer_orders','transfer_order_lines','local_co_orders','local_co_order_lines',
  'scm_reconciliation_order_state','scm_reconciliation_line_state','dispatch_so_po_allocations',
  'dispatch_so_to_allocations','operator_reload_cycles','dispatch_drivers','dispatch_trucks'];
const emit = async data => { if (!process.stdout.write(JSON.stringify(data)+'\n')) await once(process.stdout,'drain'); };
const client=await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const meta=(await client.query("SELECT current_setting('transaction_read_only') AS read_only,txid_current_snapshot()::text AS snapshot,now() AS captured_at")).rows[0];
  if(meta.read_only!=='on') throw new Error('Read-only transaction required');
  await emit({metadata:meta});
  for (const table of tables) {
    if(!(await client.query('SELECT to_regclass($1) AS present',[table])).rows[0].present) {await emit({missing:table});continue;}
    await emit({start:table});
    await client.query(`DECLARE support_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS record FROM ${table} t`);
    for(;;) {
      const rows=(await client.query('FETCH 32 FROM support_rows')).rows;
      if(!rows.length)break;
      for(const row of rows)await emit({table,raw:row.record});
    }
    await client.query('CLOSE support_rows');
  }
  await client.query('COMMIT');
} catch(error) {await client.query('ROLLBACK');throw error;}
finally{client.release();await pool.end();}
'''
manifest = {'version': 1, 'readOnly': True, 'tables': {}, 'missing': [],
            'limit': 'Supporting state is current at this later capture; historical source versions remain unavailable.'}
files, hashes = {}, {}
process = subprocess.Popen(['docker', 'exec', '-i', '--workdir', '/app', 'mbbs-operator-app-app-1',
                            'node', '--input-type=module'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
process.stdin.write(program)
process.stdin.close()
try:
    for line in process.stdout:
        event = json.loads(line)
        if 'metadata' in event:
            manifest['database'] = event['metadata']
        elif 'missing' in event:
            manifest['missing'].append(event['missing'])
        elif 'start' in event:
            table = event['start']
            path = root / f'{table}.jsonl.gz'
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            files[table] = gzip.GzipFile(fileobj=os.fdopen(fd, 'wb'), mode='wb')
            hashes[table] = hashlib.sha256()
            manifest['tables'][table] = {'rows': 0}
        else:
            table, raw = event['table'], (event['raw'] + '\n').encode()
            hashes[table].update(raw)
            files[table].write(raw)
            manifest['tables'][table]['rows'] += 1
    if process.wait() != 0:
        raise RuntimeError('Supporting capture failed; no completed manifest was written')
    for table, digest in hashes.items():
        manifest['tables'][table]['uncompressedSha256'] = digest.hexdigest()
    fd = os.open(root / 'manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(manifest, output, indent=2)
    print(json.dumps({'tables': {k: v['rows'] for k, v in manifest['tables'].items()}, 'missing': manifest['missing']}))
finally:
    for output in files.values():
        output.close()
