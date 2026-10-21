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
RELEASE = SERVER / 'deployments/special-po-line-20260928'
manifest = json.loads((RELEASE / 'manifest.json').read_text())
headers = {'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'}
routes = {'public/scm-menu.html': '/scm', 'public/scm-stock-requests.html': '/scm/stock-requests',
          'public/sales-stock-requests.html': '/sales/stock-requests', 'public/operator.html': '/operator',
          'public/aggregate-requests.html': '/aggregate-requests', 'public/field-sales/index.html': '/field-sales/'}

def verify_asset(entry):
    file, expected = entry
    path = routes.get(file, '/' + file.removeprefix('public/'))
    request = urllib.request.Request('https://test.mbbsoperation.com' + path + '?v=20260928-po-line-v1', headers=headers)
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

script = (SERVER / 'tools/special-batch-commercial-live.mjs').read_text()
runtime = json.loads(subprocess.check_output(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1', 'node', '--input-type=module', '-'], input=script.encode()))
before = json.loads((SERVER / 'test-artifacts/special-workflow-review/batch-discount-20260928/live-before.json').read_text())
assert runtime['soFinancialHash'] == before['soFinancialHash'], 'SO changed during release; inspect before making any claim'
result = {'healthy': True, 'anonymousSalesRepsStatus': 401, 'publicAssetsMatched': len(assets), 'SOM06738Unchanged': True, **runtime}
(RELEASE / 'public-verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
