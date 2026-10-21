"""Read-only verification of deployed Special assets, alerts and quote attribution."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/special-alerts-requester-transfer-20260928'
manifest = json.loads((RELEASE / 'manifest.json').read_text())
headers = {'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'}
routes = {'public/scm-menu.html': '/scm', 'public/scm-stock-requests.html': '/scm/stock-requests',
          'public/sales-stock-requests.html': '/sales/stock-requests', 'public/operator.html': '/operator',
          'public/aggregate-requests.html': '/aggregate-requests', 'public/field-sales/index.html': '/field-sales/'}

def verify_asset(entry):
    file, expected = entry
    path = routes.get(file, '/' + file.removeprefix('public/'))
    request = urllib.request.Request('https://test.mbbsoperation.com' + path + '?v=20260928-special-alert-v1', headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200, file
        body = response.read()
    if file.endswith('.html'):
        body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b'', body)
    assert hashlib.sha256(body).hexdigest() == expected, 'Served source differs: ' + file
    return file

with ThreadPoolExecutor(max_workers=5) as pool:
    assets = list(pool.map(verify_asset, ((name, value) for name, value in manifest['files'].items() if name.startswith('public/'))))
with urllib.request.urlopen(urllib.request.Request('https://test.mbbsoperation.com/health', headers=headers), timeout=20) as response:
    assert response.status == 200 and json.loads(response.read())['ok'] is True
try:
    urllib.request.urlopen(urllib.request.Request('https://test.mbbsoperation.com/api/scm/special-stock-requests/alerts', headers=headers), timeout=20)
    raise AssertionError('Anonymous alert access must be rejected')
except urllib.error.HTTPError as error:
    assert error.code == 401

script = """import assert from 'node:assert/strict';
import { getSpecialStockAlertCounts } from './src/special-stock-alerts.js';
import { buildSpecialQuote } from './src/special-stock-documents.js';
import { normalizeSpecialSupplyResponse } from './src/special-stock-request-domain.js';
import { closeDb } from './src/db.js';
try {
  const counts = await getSpecialStockAlertCounts();
  assert.equal(counts.total, counts.newRequests + counts.confirmedOrders);
  assert.ok(Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0));
  const input = { supplyStatus: 'vendor_transfer', availabilityMode: 'no_projection', vendorId: 1, vendorName: 'Preview vendor', vendorYard: 'Preview yard' };
  assert.throws(() => normalizeSpecialSupplyResponse(input), { code: 'SPECIAL_RESPONSE_DATE_REQUIRED' });
  assert.equal(normalizeSpecialSupplyResponse({ ...input, availabilityMode: 'dated', availableDate: '2099-02-01' }).supplyStatus, 'vendor_transfer');
  const quote = buildSpecialQuote({ requestRef: 'PREVIEW-ONLY', revision: 1, inquiryDate: '2099-01-01', requestedByName: 'Original requester',
    customerName: 'Preview customer', fulfillmentMethod: 'yard_pickup', lines: [{ productName: 'Preview slab', quantity: 1, originalRate: 10, uom: 'PLT' }] },
    { name: 'MBBS', taxBps: 1300, validityDays: 30 }, { operatorName: 'Quote viewer' });
  assert.equal(quote.snapshot.salesRep, 'Original requester');
  console.log(JSON.stringify({ liveCountsRead: true, transferEtaRequired: true, savedQuoteUsesRequester: true }));
} finally { await closeDb(); }
"""
runtime = json.loads(subprocess.check_output(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1', 'node', '--input-type=module', '-'], input=script.encode()))
result = {'healthy': True, 'anonymousAlertStatus': 401, 'publicAssetsMatched': len(assets), **runtime}
(RELEASE / 'public-verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
