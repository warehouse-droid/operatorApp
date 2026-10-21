"""Check the public tablet assets and record front-door access restrictions."""
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.request

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'test/receiving-multi-yard-manifest.json').read_text())
report = {'origin': 'https://test.mbbsoperation.com', 'verified': [], 'blocked': None}
for url, file in [('/operator', 'public/operator.html'),
                  ('/operator.js?v=20260930-receiving-multi-yard-v1', 'public/operator.js'),
                  ('/service-worker.js', 'public/service-worker.js')]:
    try:
        request = urllib.request.Request(report['origin'] + url, headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.status == 200
            assert hashlib.sha256(response.read()).hexdigest() == manifest['after'][file], url
            report['verified'].append(url)
    except urllib.error.HTTPError as error:
        report['blocked'] = {'path': url, 'status': error.code}
        break
report['passed'] = len(report['verified']) == 3
(root / 'test-artifacts/receiving-multi-yard/public-assets.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
