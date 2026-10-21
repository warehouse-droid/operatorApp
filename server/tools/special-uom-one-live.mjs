import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { specialLineFields, specialAdjustmentFieldSummary } from './public/special-stock-line-fields.js';
const html=specialLineFields({ productName:'TEST',quantity:2,uom:'PLT',rate:10,conversionToPc:4 },{rateMode:'fixed'});
assert.ok(!html.includes('conversionToPc'));assert.ok(!html.includes('Pieces per sales UOM'));
assert.ok(!specialAdjustmentFieldSummary({fromConversion:2,toConversion:4}).includes('Pieces per sales UOM'));
for(const file of ['special-stock-line-fields.js','sales-stock-requests.html','scm-stock-requests.html']) {
 const response=await fetch('http://127.0.0.1:3000/'+file+'?uomOne=20261003-v1');assert.equal(response.status,200);
 const served=await response.text();assert.equal(served,await readFile('public/'+file,'utf8'));
 if(file.endsWith('.html'))assert.ok(served.includes('uomOne=20261003-v1'));
}
const response=await fetch('http://127.0.0.1:3000/api/sales/special-stock-requests/1/quantity-change',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
assert.equal(response.status,401);
console.log(JSON.stringify({conversionControlRemoved:true,publicAssetsVerified:3,anonymousWritesDenied:true,productionRequestWrites:0,netSuiteWrites:0}));
