"""Read-only verification of the saved requests using the deployed display module."""
from pathlib import Path
import json
import subprocess

server = Path(__file__).resolve().parents[1]
script = r"""
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from 'file:///app/src/db.js';
import {getSpecialStockCase} from 'file:///app/src/special-stock-request-repository.js';
import {buildSpecialQuote} from 'file:///app/src/special-stock-documents.js';
import {specialRequestPalletLine} from 'file:///app/public/special-stock-pallet-display.js';
globalThis.fetch=async()=>{throw new Error('This live request verification must not call an external service.');};
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const company=(await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0]?.data?.companies?.MBBS;
  const requests=[];
  for(const [id,ref,quantity] of [[85,'SPREQ-000019',1],[88,'SPREQ-000020',5]]){
   for(const audience of ['sales','scm']){
    const detail=await getSpecialStockCase(id,{audience});
    assert.equal(detail.requestRef,ref);assert.equal(detail.palletTotal,quantity);assert.equal(detail.palletRate,40);
    const html=specialRequestPalletLine(detail);
    assert.equal(html.split('data-special-pallet-line').length,2);
    assert.ok(html.includes(`${quantity} EACH`));assert.ok(html.includes(`$${quantity*40}.00`));
    assert.ok(!html.includes('data-special-decision-line')&&!html.includes('data-special-stock-line'));
    if(audience==='sales'){
     const pallets=detail.salesOrderId?null:buildSpecialQuote(detail,company).snapshot.lines.filter(line=>line.description==='PALLET');
     if(pallets){assert.equal(pallets.length,1);assert.equal(pallets[0].quantity,String(quantity));assert.equal(pallets[0].unitRate,'40');}
     requests.push({requestRef:ref,stage:detail.stage,revision:detail.revision,palletQuantity:quantity,salesRate:40,
      palletSubtotal:quantity*40,materialLines:detail.lines.length,quoteVerified:Boolean(pallets),salesAndScmDisplayVerified:true});
    }
   }
  }
  return {readOnly:true,requests};
 });
 console.log(JSON.stringify(result,null,2));
} finally {await closeDb();}
"""
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                         'node', '--input-type=module', '-'], input=script.encode(), capture_output=True)
if result.returncode:
    print(result.stderr.decode(), end='')
    raise SystemExit(result.returncode)
report = json.loads(result.stdout)
(server / 'test-artifacts/special-enquiry-pallet-20261001/live-requests.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
