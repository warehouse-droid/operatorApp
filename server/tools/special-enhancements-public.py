"""Read-only verification of deployed Special Request enhancement assets."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/special-request-enhancements-20260928'
manifest = json.loads((RELEASE / 'manifest.json').read_text())
headers = {'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'}
routes = {'public/scm-menu.html': '/scm', 'public/scm-stock-requests.html': '/scm/stock-requests',
          'public/sales-stock-requests.html': '/sales/stock-requests', 'public/operator.html': '/operator',
          'public/aggregate-requests.html': '/aggregate-requests', 'public/field-sales/index.html': '/field-sales/'}

def verify_asset(entry):
    file, expected = entry
    path = routes.get(file, '/' + file.removeprefix('public/'))
    request = urllib.request.Request('https://test.mbbsoperation.com' + path + '?v=20260928-enhancements-v1', headers=headers)
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
result = {'healthy':True,'verifiedPublicAssets':assets,'liveMutations':False}
(RELEASE / 'public-check.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result))
