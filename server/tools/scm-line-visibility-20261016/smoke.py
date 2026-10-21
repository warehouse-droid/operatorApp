"""Read-only production probes; do not change any live request or line."""
import json
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/scm-line-visibility-20261016'
checks={}
def read(path,expected=200):
 try:
  with urlopen('http://127.0.0.1:3000'+path,timeout=15) as response:status,body=response.status,response.read().decode()
 except HTTPError as error:status,body=error.code,error.read().decode()
 assert status==expected,(path,status)
 checks[path]=status
 return body
assert json.loads(read('/health'))['ok']
html=read('/scm/stock-requests')
assert '/scm-request-line-visibility.js?v=20261016' in html
assert '/scm-stock-requests.js?lineVisibility=20261016' in html
assert '/scm-special-stock-requests.js?lineVisibility=20261016' in html
for file in json.loads((ROOT/'tools/scm-line-visibility-20261016/files.json').read_text()):
 if file.endswith('.js'):assert read('/'+file.removeprefix('public/'))==(ROOT/'tools/scm-line-visibility-20261016/candidate-runtime'/file).read_text()
read('/api/scm/stock-requests/1',401)
read('/api/scm/special-stock-requests/1',401)
read('/api/scm/stock-request-conversation-alerts',401)
(OUT/'production-smoke.json').write_text(json.dumps({'checks':checks,'liveWrites':0},indent=2)+'\n')
print(json.dumps({'readOnlyProbes':len(checks),'passed':True,'liveWrites':0}))
