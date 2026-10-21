"""Apply only the verified additive migration; retain operational rollback evidence."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/backorder-requests-20261006'
AUDIT=Path('/home/ubuntu/operatorapp-investigations/backorder-requests-20261006/migration')
APP='mbbs-operator-app-app-1'
FILE='268_regular_backorder.sql'

def main():
    summary=json.loads((OUT/'summary.json').read_text())
    source=(ROOT/'migrations'/FILE).read_bytes()
    assert hashlib.sha256(source).hexdigest()==summary['manifest']['migrations/'+FILE]
    assert not summary['newFailures'] and summary['focused']['fail']==0
    assert summary['types']==summary['lint']=='pass'
    AUDIT.mkdir(parents=True,exist_ok=True,mode=0o700)
    expected=json.loads((OUT/'production-migrations.json').read_text())
    script="""import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {query,withTransaction,closeDb} from './src/db.js';
const filename=FILENAME,expected=EXPECTED,sql=MIGRATION;
const hashes=async()=>{const result={};for(const [table,omit] of [['sales_stock_requests',[]],['sales_special_stock_cases',['workflow_kind']],['sales_special_stock_lines',['regular_item_id','regular_item_code']]]){
 const rows=(await query(`SELECT to_jsonb(row)-$1::text[] AS value FROM ${table} row ORDER BY ${table==='sales_special_stock_cases'?'request_id':'id'}`,[omit])).rows;
 result[table]={rows:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}return result;};
try{const result=await withTransaction(async()=>{
 await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='60s'");
 await query('LOCK TABLE sales_stock_requests,sales_special_stock_cases,sales_special_stock_lines IN ACCESS EXCLUSIVE MODE');
 const applied=(await query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map(r=>r.filename);
 if(applied.includes(filename))return {alreadyApplied:true,legacy:await hashes()};
 assert.deepEqual(applied,expected,'Production migration history changed since preparation');
 const active=(await query("SELECT count(*)::int AS n FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating' OR quantity_review->>'status'='applying'")).rows[0].n;
 assert.equal(active,0,'Wait for existing Special operations to finish');
 const before=await hashes();
 const oldView=(await query("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass,true) AS definition")).rows[0].definition;
 const oldPrices=(await query("SELECT pg_get_functiondef('preserve_special_original_price'::regproc) AS definition")).rows[0].definition;
 await query(sql);await query('INSERT INTO schema_migrations(filename) VALUES($1)',[filename]);
 const after=await hashes();assert.deepEqual(after,before,'An existing request changed during migration');
 return {applied:filename,legacyDataPreserved:true,legacy:after,oldView,oldPrices};
});console.log(JSON.stringify(result));}finally{await closeDb();}
"""
    script=script.replace('FILENAME',json.dumps(FILE)).replace('EXPECTED',json.dumps(expected)).replace('MIGRATION',json.dumps(source.decode()))
    result=subprocess.run(['docker','exec','-i','-w','/app',APP,'node','--input-type=module'],input=script,text=True,capture_output=True,timeout=75)
    (AUDIT/'apply.log').write_text(result.stderr)
    assert result.returncode==0,'Migration failed; see the operational migration log'
    evidence=json.loads(result.stdout)
    (AUDIT/'result.json').write_text(json.dumps(evidence,indent=2))
    public={key:value for key,value in evidence.items() if key not in ['oldView','oldPrices']}
    (OUT/'migration-live.json').write_text(json.dumps(public,indent=2))
    print(json.dumps(public),flush=True)

if __name__=='__main__':main()
