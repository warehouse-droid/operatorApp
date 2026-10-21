"""Read-only production checks. Never submit stock checks, messages, or order links."""
import json
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/transfer-eta-20261016'
checks={}
def read(path,expected=200):
 try:
  with urlopen('http://127.0.0.1:3000'+path,timeout=15) as response:status,body=response.status,response.read().decode()
 except HTTPError as error:status,body=error.code,error.read().decode()
 assert status==expected,(path,status)
 checks[path]=status
 return body
assert json.loads(read('/health'))['ok']
for audience in ['sales','scm']:
 html=read('/'+audience+'/stock-requests')
 assert '/'+audience+'-stock-requests.js?transferEta=20261016' in html
 assert '/'+audience+'-special-stock-requests.js?transferEta=20261016' in html
for file in json.loads((ROOT/'tools/transfer-eta-20261016/files.json').read_text()):
 if file.startswith('public/') and file.endswith('.js'):
  assert read('/'+file.removeprefix('public/'))==(ROOT/'tools/transfer-eta-20261016/candidate-runtime'/file).read_text()
read('/api/scm/stock-requests/1',401)
read('/api/sales/special-stock-requests/1',401)
read('/api/scm/stock-request-conversation-alerts',401)
(OUT/'production-smoke.json').write_text(json.dumps({'checks':checks,'liveBusinessWrites':0},indent=2)+'\n')
print(json.dumps({'readOnlyProbes':len(checks),'passed':True,'liveBusinessWrites':0}))
