"""Explain live driver activity between the baseline read and deployment."""
import datetime
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/registered-split-planning-20261007'
before_file = ARTIFACT / 'live-before.json'
before = json.loads(before_file.read_text())
cutoff = datetime.datetime.fromtimestamp(before_file.stat().st_mtime, datetime.timezone.utc).isoformat()
script = '''import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {query,withTransaction,closeDb} from './src/db.js';
const cutoff=CUTOFF;
try {const result=await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY');
 await query("SET LOCAL statement_timeout='10s'");
 const existing=(await query("SELECT row_to_json(j) AS value FROM driver_job_records j WHERE plan_id IN (343,349) AND created_at<=$1::timestamptz ORDER BY id",[cutoff])).rows;
 const added=(await query("SELECT id::text,plan_id::text,status,stop_type,created_at,started_at,completed_at FROM driver_job_records WHERE plan_id IN (343,349) AND created_at>$1::timestamptz ORDER BY id",[cutoff])).rows;
 const recentCompletions=(await query("SELECT id::text,plan_id::text,status,stop_type,created_at,started_at,completed_at FROM driver_job_records WHERE plan_id IN (343,349) AND created_at<=$1::timestamptz AND completed_at>$1::timestamptz ORDER BY id",[cutoff])).rows;
 const existingHash=createHash('sha256').update(JSON.stringify(existing)).digest('hex');
 return {readOnly:true,baselineAt:cutoff,existingCount:existing.length,existingHash,addedDriverActivity:added,recentExistingCompletions:recentCompletions};
});console.log(JSON.stringify(result));} finally {await closeDb();}
'''.replace('CUTOFF', json.dumps(cutoff))
proof = json.loads(subprocess.check_output(['sudo', '-n', 'docker', 'exec', '-i',
    'mbbs-operator-app-app-1', 'node', '--input-type=module'], input=script.encode(), timeout=30))
proof['baselineCount'] = before['operationalHashes']['jobs']['count']
proof['baselineHash'] = before['operationalHashes']['jobs']['hash']
proof['baselineRowCountRetained'] = proof['existingCount'] == proof['baselineCount']
proof['baselineRowsUnchanged'] = proof['existingHash'] == proof['baselineHash']
assert proof['baselineRowCountRetained']
(ARTIFACT / 'driver-progress-during-validation.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof))
