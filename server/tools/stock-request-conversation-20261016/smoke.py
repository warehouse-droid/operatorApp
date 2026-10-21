"""Read-only post-deployment probes; does not authenticate or write live messages."""
import json
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-artifacts/stock-request-conversation-20261016'
results={}
def read(path,expected=200):
    try:
        with urlopen('http://127.0.0.1:3000'+path,timeout=15) as response:
            status,body=response.status,response.read().decode()
    except HTTPError as error:status,body=error.code,error.read().decode()
    assert status==expected,(path,status)
    results[path]=status
    return body
assert json.loads(read('/health'))['ok']
for role in ['sales','scm']:
    html=read('/'+role+'/stock-requests')
    assert '/stock-request-conversation.js?v=20261016' in html
    assert '/stock-request-conversation.css?v=20261016' in html
    read('/api/'+role+'/stock-request-conversation-alerts',401)
    read('/api/'+role+'/stock-requests/1/conversation',401)
for file in ['stock-request-conversation.js','stock-request-conversation-alert.js','stock-request-conversation.css']:
    assert read('/'+file)==(ROOT/'public'/file).read_text()
(OUT/'production-smoke.json').write_text(json.dumps({'checks':results,'liveWrites':0},indent=2)+'\n')
print(json.dumps({'readOnlyProbes':len(results),'passed':True,'liveWrites':0}))
