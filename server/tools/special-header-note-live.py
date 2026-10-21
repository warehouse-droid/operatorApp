"""Read-only SPREQ-000022 and deployed header verification; no business writes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-header-note-20261001'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'verify'
assert MODE in ['before', 'verify']
SCRIPT = r"""
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { query,withTransaction,closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { buildSpecialQuote } from './src/special-stock-documents.js';
const mode=process.argv[2],realFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{
 assert.ok(String(url).startsWith('http://127.0.0.1:3000/'),'Live checks are local and read-only');
 return realFetch(url,options);
};
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const row=(await query("SELECT id,remarks,status,revision FROM sales_stock_requests WHERE request_ref='SPREQ-000022'")).rows[0];
  assert.ok(row);
  const detail=await getSpecialStockCase(row.id,{audience:'sales'});
  assert.equal(detail.remarks,row.remarks);
  assert.ok(detail.remarks.includes('44 Sherwood Ave, Scarborough, ON M1R 1N5'));
  assert.ok(detail.remarks.includes('全贴砖方案') && detail.remarks.includes('5,200 × 1.05 = 5,460'));
  const company=(await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0]?.data?.companies?.MBBS;
  assert.equal(buildSpecialQuote(detail,company).snapshot.note,detail.remarks);
  const header={requestRef:detail.requestRef,id:row.id,status:row.status,stage:detail.stage,revision:Number(row.revision),
    noteHash:createHash('sha256').update(row.remarks).digest('hex'),noteLength:row.remarks.length,
    chineseAndSymbolsPreserved:true,noteHasLineBreaks:row.remarks.includes('\n'),quoteNoteMatches:true};
  if(mode==='verify'){
   const {specialFulfillmentEditor,normalizeSpecialHeaderNote,canEditSpecialHeader}=await import('./public/special-stock-fulfillment.js');
   assert.equal(normalizeSpecialHeaderNote(row.remarks),row.remarks);
   assert.ok(canEditSpecialHeader(detail));
   const html=specialFulfillmentEditor(detail);
   assert.ok(html.includes('data-special-header-form') && html.includes('name="remarks"') && html.includes('Save header'));
   assert.ok(!html.includes('Edit note'));
   assert.ok(readFileSync('public/sales-stock-requests.html','utf8').includes('sales-special-stock-requests.js?v=20261001-header-note-v2'));
   assert.ok(readFileSync('public/scm-stock-requests.html','utf8').includes('scm-special-stock-requests.js?v=20261001-header-note-v1'));
   assert.ok(readFileSync('public/stock-requests.css','utf8').includes('.special-header-note-content'));
   Object.assign(header,{directHeaderNoteEditor:true,sharedSaveHeader:true,noEditNoteButton:true});
  }
  return {readOnly:true,requestWrites:0,netsuiteWrites:0,request:header};
 });
 if(mode==='verify'){
  const response=await fetch('http://127.0.0.1:3000/api/sales/special-stock-requests/91/header',
   {method:'PUT',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,401);result.requiresAuthentication=true;
 }
 console.log(JSON.stringify(result));
} finally {await closeDb();}
"""
response=subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1',
  'node','--input-type=module','-',MODE],input=SCRIPT.encode(),capture_output=True)
if response.returncode:
 print(response.stderr.decode(),end='')
 raise SystemExit(response.returncode)
report=json.loads(response.stdout)
if MODE=='verify':
 before=json.loads((OUT/'live-before.json').read_text())
 assert before['request']['noteHash']==report['request']['noteHash'],'Live request Note changed; inspect before claiming it was preserved'
 report['originalNoteUnchanged']=True
(OUT/('live-before.json' if MODE=='before' else 'live-requests.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
