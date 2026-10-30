#!/usr/bin/env python3
"""Read-only public release and host cleanup audit; never writes orders/configuration."""
import datetime,hashlib,json,runpy,subprocess
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-weight-warning-release.py')))
base=release['base'];scope=release['scope'];out=scope['OUT'];docker=base['docker']
http=[]
for path,file,status in [('/health',None,200),('/mbt/planning','public/mbt-planning.html',200),
    ('/mbt-planning.js?v=bin-weight-warning-20261024','public/mbt-planning.js',200),
    ('/dispatch.js?v=bin-weight-warning-20261024','public/dispatch.js',200),
    ('/api/mbt/planning?planDate=2026-10-21',None,401)]:
    result=subprocess.run(['curl','-sS','--max-time','30','-w','\n%{http_code}',
        'https://test.mbbsoperation.com'+path],capture_output=True,check=True)
    body,code=result.stdout.rsplit(b'\n',1);row={'path':path,'status':int(code)}
    assert int(code)==status,row
    if file:
        row['matchesCandidate']=hashlib.sha256(body).hexdigest()==base['sha'](out/'candidate'/file)
        assert row['matchesCandidate'],row
    if path=='/health':assert json.loads(body)['ok'] is True
    http.append(row)
running=docker('ps','--format','{{.Names}}').splitlines()
all_containers=docker('ps','-a','--format','{{.Names}}').splitlines()
assert set(running)==set(base['SERVICES'].values())==set(all_containers)
resources={}
for kind,flags in [('container',['-aq']),('volume',['-q']),('network',['-q'])]:
    resources[kind]=len(docker(kind,'ls',*flags,'--filter','label=com.mbbs.lifecycle=disposable-test').splitlines())
assert sum(resources.values())==0
runs=list((scope['SERVER']/'test-artifacts/.runs').iterdir())
assert not runs,[str(p) for p in runs]
configuration=json.loads(base['db']("SELECT json_build_object('truckId',t.id,'truckPlate',t.plate,'truckCapacityLbs',t.capacity_lbs,'binType',b.type_code,'binPayloadKg',b.maximum_payload_kg) FROM dispatch_trucks t CROSS JOIN mbt_bin_types b WHERE t.id=79 AND b.bin_type_id='00000000-0000-4000-8000-000000000014';"))
trip=json.loads(base['db']("SELECT json_build_object('tripId',trip_id,'status',status,'weightLbs',weight_lbs,'planId',plan_id,'loadId',load_id) FROM mbt_transport_trips WHERE trip_id='496035cd-45af-4efe-9088-8754920d5506';"))
report={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'http':http,
    'configuration':configuration,'reportedTrip':trip,'runningContainers':running,
    'allContainers':all_containers,'disposableResources':resources,'testArtifactRuns':len(runs),'passed':True}
base['save'](out/'public-cleanup-audit.json',report)
print(json.dumps(report,indent=2))
