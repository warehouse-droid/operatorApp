"""Verify task test-resource removal and production health without touching operational data."""
import datetime,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parents[2]
out=root/'server/test-artifacts/stock-check'
allow={'mbbs-operator-app-app-1','mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1'}
def docker(*args):return subprocess.check_output(['sudo','-n','docker',*args],text=True).strip()
for stage in ['full-repeat-baseline','full-repeat-candidate']:
    assert 'run passed: 1 file(s), 20 test(s)' in (out/(stage+'.log')).read_text(), 'Finish the isolated repeat before final cleanup.'
containers=docker('ps','-a','--format','{{.Names}}\t{{.Label "com.docker.compose.project"}}').splitlines()
projects={line.split('\t')[1] for line in containers if '\t' in line and line.split('\t')[1].startswith('mbbs-stock-check-20261014-')}
for project in projects:
    subprocess.run(['sudo','-n','docker','compose','--project-directory',str(root),'-p',project,'-f',str(root/'docker-compose.mbt-test.yml'),'-f',str(root/'docker-compose.stock-check-test.yml'),'--profile','tools','--profile','runtime','down','--volumes','--remove-orphans','--timeout','10'],check=True)
running=docker('ps','--format','{{.Names}}\t{{.Status}}');all_containers=docker('ps','-a','--format','{{.Names}}\t{{.Status}}')
(out/'final-docker-ps.txt').write_text(running+'\n');(out/'final-docker-ps-a.txt').write_text(all_containers+'\n')
running_names={line.split('\t')[0] for line in running.splitlines()}
all_names={line.split('\t')[0] for line in all_containers.splitlines()}
assert allow<=running_names and allow<=all_names
assert not any(name.startswith('mbbs-stock-check-') for name in all_names),'Task test containers remain.'
other_active_tests=[]
for name in sorted(all_names-allow):
    row=json.loads(docker('inspect',name))[0]
    labels=row['Config'].get('Labels') or {}
    project=labels.get('com.docker.compose.project','')
    assert row['State']['Running'] and labels.get('com.mbbs.lifecycle')=='disposable-test', 'An unexpected or stopped container needs its owner to clean up: '+name
    assert project.startswith('mbbs-') and not project.startswith('mbbs-stock-check-')
    other_active_tests.append({'name':name,'project':project,'running':True,'lifecycle':'disposable-test'})
networks=docker('network','ls','--format','{{.Name}}').splitlines()
volumes=docker('volume','ls','--format','{{.Name}}').splitlines()
leftover_networks=[name for name in networks if name.startswith('mbbs-stock-check-')]
leftover_volumes=[name for name in volumes if name.startswith('mbbs-stock-check-')]
assert not leftover_networks and not leftover_volumes, 'Remove remaining task test networks/volumes.'
health=json.loads(subprocess.check_output(['curl','-fsS','--max-time','10','http://127.0.0.1:3000/health'],text=True));assert health.get('ok')
states={name:docker('inspect','--format','{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}not-defined{{end}}',name) for name in sorted(allow)}
assert all(value.startswith('true') for value in states.values())
assert all(value.endswith('healthy') for name,value in states.items() if name!='mbbs-operator-app-webhook-worker-1')
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'healthy':True,'onlyProductionContainers':not other_active_tests,
        'production':states,'testContainers':[],'testNetworks':leftover_networks,'testVolumes':leftover_volumes,
        'otherActiveTestProjects':other_active_tests,
        'nodeVersion':docker('exec','mbbs-operator-app-app-1','node','--version'),'imageId':docker('inspect','--format','{{.Image}}','mbbs-operator-app-app-1')}
(out/'final-host-cleanup.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
