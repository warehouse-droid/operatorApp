"""Apply or roll back the tested view-only migration with record-preservation checks."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/backorder-review-flow-20261007'
FILENAME='270_backorder_order_completion.sql'
APP='mbbs-operator-app-app-1'

def execute(script):
    return json.loads(subprocess.check_output(['docker','exec','-i','-w','/app',APP,'node','--input-type=module'],input=script.encode()))

mode=sys.argv[1]
assert mode in ['apply','rollback']
sql=(ROOT/'migrations'/FILENAME).read_text() if mode=='apply' else (OUT/'production-before-view.sql').read_text()
if mode=='apply':
    summary=json.loads((OUT/'summary.json').read_text())
    assert summary['manifest']['migrations/'+FILENAME]==hashlib.sha256(sql.encode()).hexdigest()
    assert not summary['newFailures'] and not summary['focused']['fail']
    assert (OUT/'migration-check.log').exists()
script="""import assert from 'node:assert/strict';import crypto from 'node:crypto';import {query,closeDb,withTransaction} from './src/db.js';
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const definition=async()=>(await query("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass,true) AS definition")).rows[0].definition;
const snapshot=async()=>{const result={};for(const table of ['sales_stock_requests','sales_special_stock_cases','sales_special_stock_lines']){const rows=(await query(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY ${table==='sales_special_stock_cases'?'request_id':'id'}`)).rows;result[table]={rows:rows.length,sha256:sha(rows)};}return result;};
try{const result=await withTransaction(async()=>{await query("SET LOCAL lock_timeout='5s'");await query('LOCK TABLE sales_stock_requests,sales_special_stock_cases,sales_special_stock_lines IN SHARE MODE');
const before=await snapshot();const oldView=await definition();const special=await query("SELECT stage.request_id,stage.stage FROM special_stock_workflow_stages stage JOIN sales_special_stock_cases special ON special.request_id=stage.request_id WHERE special.workflow_kind='special' ORDER BY stage.request_id");
"""
script+=f"const filename={json.dumps(FILENAME)},mode={json.dumps(mode)};\n"
if mode=='apply':
    script+="assert.equal((await query('SELECT count(*)::int AS n FROM schema_migrations WHERE filename=$1',[filename])).rows[0].n,0);\n"
else:
    record=json.loads((OUT/'live-migration.json').read_text())
    script+=f"assert.equal(sha(oldView),{json.dumps(record['afterViewHash'])});\n"
script+=f"await query({json.dumps(sql)});\n"
script+="await query(mode==='apply'?'INSERT INTO schema_migrations(filename) VALUES($1)':'DELETE FROM schema_migrations WHERE filename=$1',[filename]);const after=await snapshot();assert.deepEqual(after,before);const afterSpecial=await query(\"SELECT stage.request_id,stage.stage FROM special_stock_workflow_stages stage JOIN sales_special_stock_cases special ON special.request_id=stage.request_id WHERE special.workflow_kind='special' ORDER BY stage.request_id\");assert.deepEqual(afterSpecial.rows,special.rows);return {mode,dataPreserved:true,SpecialStagesPreserved:true,before,after,oldView,afterViewHash:sha(await definition())};});console.log(JSON.stringify(result));}finally{await closeDb();}"
result=execute(script)
if mode=='apply':
    (OUT/'production-before-view.sql').write_text('CREATE OR REPLACE VIEW special_stock_workflow_stages AS\n'+result.pop('oldView')+';\n')
else:
    result.pop('oldView')
(OUT/('live-migration.json' if mode=='apply' else 'live-migration-rollback.json')).write_text(json.dumps(result,indent=2))
print(json.dumps(result),flush=True)
