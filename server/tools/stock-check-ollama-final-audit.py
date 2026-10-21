"""Verify disposable resources are gone and business data remains unchanged."""
import json
import pathlib
import subprocess

SERVER=pathlib.Path(__file__).resolve().parents[1]
OUT=SERVER/'test-artifacts/stock-check-ollama'
ALLOW={'mbbs-operator-app-app-1','mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1'}
def docker(*args,data=None):
    return subprocess.check_output(['sudo','-n','docker',*args],input=data).decode().strip()

before=json.loads((OUT/'live-data-before.json').read_text())
after=json.loads(docker('exec','-i','mbbs-operator-app-app-1','node','--input-type=module','-',data=(SERVER/'tools/stock-check-ollama-readonly-audit.mjs').read_bytes()))
(OUT/'live-data-after.json').write_text(json.dumps(after,indent=2)+'\n')
assert after['readOnly']=='on' and before['tables']==after['tables'],'Live business data changed during this task.'
running=docker('ps','--format','{{.Names}}\t{{.Status}}')
all_containers=docker('ps','-a','--format','{{.Names}}\t{{.Status}}')
for name,value in [('final-docker-ps.txt',running),('final-docker-ps-a.txt',all_containers)]:
    (OUT/name).write_text(value+'\n');assert {line.split('\t')[0] for line in value.splitlines()}==ALLOW
networks=docker('network','ls','--format','{{.Name}}').splitlines()
volumes=docker('volume','ls','--format','{{.Name}}').splitlines()
assert not any(name.startswith('mbbs-stock-check-') for name in networks+volumes)
for name in ALLOW:
    assert docker('inspect','--format','{{.State.Running}}',name)=='true'
for name in ALLOW-{'mbbs-operator-app-webhook-worker-1'}:
    assert docker('inspect','--format','{{.State.Health.Status}}',name)=='healthy'
result={'liveDataUnchanged':True,'tables':{name:row['rows'] for name,row in after['tables'].items()},'onlyProductionContainers':True,'testNetworksAndVolumesRemoved':True,'healthy':True}
(OUT/'final-resource-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
