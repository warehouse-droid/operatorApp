import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const files=['public/backorder-workflow.js','public/backorder-stock-requests.js','public/sales-stock-requests.js','public/scm-stock-requests.js'];
const checks=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  for(const file of files) {
    const response=await fetch(base+'/'+file.slice(7)+'?v=20261008-already-ordered',{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);
    const actual=Buffer.from(await response.arrayBuffer()),expected=await readFile('/app/'+file);
    assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(expected).digest('hex'),file);
  }
  for(const role of ['sales','scm']) {
    const page=await fetch(`${base}/${role}/stock-requests?tab=regular&v=20261008-already-ordered`,{signal:AbortSignal.timeout(15000)});
    assert.equal(page.status,200);assert((await page.text()).includes('backorder=20261008-already-ordered'));
    assert.equal((await fetch(`${base}/api/${role}/stock-requests/alerts`,{signal:AbortSignal.timeout(15000)})).status,401);
  }
  checks.push({base,healthy:true,exactPublicAssets:files.length,entryPagesUpdated:2,anonymousApisDenied:2});
}
console.log(JSON.stringify({passed:true,checks}));
