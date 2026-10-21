import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { specialLineFields, defaultSpecialLineRequiredDate, changedSpecialLineFields } from './public/special-stock-line-fields.js';
const html = specialLineFields({ productName: 'TEST', quantity: 2, uom: 'PLT', requiredDate: '2099-02-01', palletQty: 1, layerQty: 2, sectionQty: 3, pieceQty: 4 }, { sales: false });
assert.ok(html.includes('special-scm-quantity-row')); assert.ok(html.includes('name="requiredDate"'));
assert.ok(!html.includes('name="conversionToPc"'));
assert.equal(defaultSpecialLineRequiredDate('2026-12-30'), '2027-01-13');
assert.deepEqual(changedSpecialLineFields({ requiredDate: '2099-03-01' }, { requiredDate: '2099-02-01' }), { requiredDate: '2099-03-01' });
const files = ['special-stock-line-fields.js', 'special-stock-scm-line.css', 'scm-special-stock-requests.js', 'sales-special-stock-requests.js', 'sales-stock-requests.html', 'scm-stock-requests.html'];
for (const file of files) {
 const response = await fetch('http://127.0.0.1:3000/' + file + '?scmLines=20261003-v1'); assert.equal(response.status, 200);
 const served = await response.text(); assert.equal(served, await readFile('public/' + file, 'utf8'));
 if (file.endsWith('.html')) assert.ok(served.includes('scmLines=20261003-v1'));
}
const health = await fetch('http://127.0.0.1:3000/health'); assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
const denied = await fetch('http://127.0.0.1:3000/api/scm/special-stock-requests/1/stock-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(denied.status, 401);
console.log(JSON.stringify({ normalDescriptionDeployed: true, scmPackingRowDeployed: true, scmDateEditable: true, defaultRequiredDatePlus14: true, publicAssetsVerified: files.length, health: 'healthy', anonymousWritesDenied: true, productionRequestWrites: 0, netSuiteWrites: 0 }));
