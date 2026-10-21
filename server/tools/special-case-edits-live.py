"""Verify the deployed editor against actual requests, using read-only transactions."""
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]
SCRIPT = r"""
import assert from 'node:assert/strict';
import { query,withTransaction,closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { buildSpecialQuote } from './src/special-stock-documents.js';
import { canEditSpecialCaseLines,specialCaseEditDraft,planSpecialCaseEdits } from './public/special-stock-case-edits.js';
import { specialRequestPalletLine } from './public/special-stock-pallet-display.js';
const actualFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{
 assert.ok(String(url).startsWith('http://127.0.0.1:3000/'),'Live validation is local and read-only');
 return actualFetch(url,options);
};
try {
 const requests=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const company=(await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0]?.data?.companies?.MBBS;
  const rows=(await query("SELECT id,request_ref FROM sales_stock_requests WHERE request_ref IN ('SPREQ-000019','SPREQ-000020') ORDER BY request_ref")).rows;
  assert.equal(rows.length,2);
  const result=[];
  for(const row of rows){
   const detail=await getSpecialStockCase(row.id,{audience:'sales'}),before=JSON.stringify(detail);
   const draft=specialCaseEditDraft(detail),material=draft.lines[0];
   assert.equal(draft.expectedRevision,detail.revision);
   assert.deepEqual(planSpecialCaseEdits(detail,draft),{lines:[],pallet:null,restart:false});
   const rename=planSpecialCaseEdits(detail,{lines:[{...material,productName:material.productName+' preview'}]});
   const quantity=planSpecialCaseEdits(detail,{lines:[{...material,quantity:Number(material.quantity)+1}]});
   const rate=planSpecialCaseEdits(detail,{lines:[{...material,rate:Number(material.rate)+1}]});
   const pallet=planSpecialCaseEdits(detail,{pallet:{quantity:Number(draft.pallet.quantity)+1,rate:draft.pallet.rate??40}});
   assert.ok(rename.restart&&quantity.restart);assert.equal(rate.restart,false);assert.equal(pallet.restart,false);
   assert.equal(JSON.stringify(detail),before);
   let quoteVerified=false;
   if(!detail.salesOrderId){
    const charge=buildSpecialQuote(detail,company).snapshot.lines.filter(line=>line.description==='PALLET');
    assert.equal(charge.length,detail.palletTotal>0?1:0);quoteVerified=true;
   }
   const html=specialRequestPalletLine(detail);
   assert.equal(html.includes('data-special-pallet-line'),detail.palletTotal>0);
   result.push({requestRef:detail.requestRef,status:detail.status,stage:detail.stage,revision:detail.revision,
    palletQuantity:detail.palletTotal,palletRate:detail.palletRate,canEditBeforeSalesOrder:canEditSpecialCaseLines(detail),
    resetAndKeepClassificationVerified:true,unchangedRequest:true,quoteVerified});
  }
  return result;
 });
 const protectedRoute=await fetch('http://127.0.0.1:3000/api/sales/special-stock-requests/85/case-lines',
  {method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(protectedRoute.status,401);
 console.log(JSON.stringify({readOnly:true,requestWrites:0,netsuiteWrites:0,editorRequiresAuthentication:true,requests},null,2));
} finally {await closeDb();}
"""

result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                         'node', '--input-type=module', '-'], input=SCRIPT.encode(), capture_output=True)
if result.returncode:
    print(result.stderr.decode(), end='')
    raise SystemExit(result.returncode)
report = json.loads(result.stdout)
(SERVER / 'test-artifacts/special-case-edits-20261001/live-requests.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
