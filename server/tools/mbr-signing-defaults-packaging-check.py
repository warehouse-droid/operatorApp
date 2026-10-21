#!/usr/bin/env python3
"""Verify flat-release bytes and startup with disposable bounded workloads."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/mbr-signing-defaults'
DOCKER = ['sudo', '-n', 'docker']
PROJECT = 'mbbs-mbr-signing-flat-' + str(os.getpid())
prepared = json.loads((OUT / 'prepared.json').read_text())
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
override = OUT / 'compose.packaging.json'
override.write_text(json.dumps({'services': {
    'db': {'image': 'postgres:18-alpine', 'pull_policy': 'never', 'labels': labels,
           'mem_limit': '512m', 'memswap_limit': '512m'},
    'app': {'image': prepared['imageId'], 'pull_policy': 'never', 'labels': labels,
            'cpus': '1.0', 'mem_limit': '1536m', 'memswap_limit': '1536m',
            'environment': {'MBR_CONTRACTS_ENABLED': 'true'}},
    'test': {'image': prepared['imageId'], 'pull_policy': 'never', 'labels': labels,
             'entrypoint': [], 'cpus': '1.0', 'mem_limit': '1536m', 'memswap_limit': '1536m',
             'environment': {'MBR_CONTRACTS_ENABLED': 'true'}}}}, indent=2) + '\n')
compose = DOCKER + ['compose', '--profile', 'runtime', '--profile', 'tools', '-p', PROJECT,
                    '--project-directory', str(REPO), '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]


def command(args, label, timeout=300):
    with (OUT / ('packaging-' + label + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    assert result.returncode == 0, label + ': ' + (OUT / ('packaging-' + label + '.log')).read_text()[-2000:]


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Removing disposable packaging checks')


signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
manifest = r"""
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const result={};
function walk(root) {
  for(const name of fs.readdirSync(root).sort()) {
    const file=path.join(root,name),stat=fs.lstatSync(file),relative=path.relative('/app',file);
    if(stat.isDirectory()) {walk(file);continue;}
    if(stat.isSymbolicLink()) {result[relative]={link:fs.readlinkSync(file)};continue;}
    if(stat.isFile()) {result[relative]={sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),mode:stat.mode&0o7777};}
  }
}
walk('/app');process.stdout.write(JSON.stringify(result));
"""
success = False
report = {}
try:
    config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
    for name in ('db', 'app', 'test'):
        service = config['services'][name]
        assert service['cgroup_parent'] == 'mbbs-tests.slice' and service['init']
        assert 0 < int(service['mem_limit']) <= 2 * 1024**3 and service['memswap_limit'] == service['mem_limit']
        assert 0 < service['pids_limit'] <= 512 and service['cpus']
        assert service['labels']['com.mbbs.lifecycle'] == 'disposable-test'
        assert all('size=' in entry for entry in service['tmpfs'])
    manifests = []
    for label, image in [('flat', prepared['imageId']), ('validated-browser', prepared['testImageId'])]:
        args = DOCKER + ['run', '--rm', '--name', PROJECT + '-' + label, '--init', '--network', 'none',
            '--cgroup-parent=mbbs-tests.slice', '--memory=1g', '--memory-swap=1g', '--pids-limit=256', '--cpus=1.0',
            '--read-only', '--tmpfs', '/tmp:size=64m', '--label', 'com.mbbs.lifecycle=disposable-test',
            '--label', 'com.mbbs.task=' + PROJECT, '--entrypoint', 'node', image, '-e', manifest]
        raw = subprocess.check_output(args, timeout=180)
        (OUT / ('manifest-' + label + '.json')).write_bytes(raw)
        manifests.append(json.loads(raw))
    flat, validated = manifests
    differences = [name for name, entry in flat.items() if validated.get(name) != entry]
    assert not differences, differences[:30]
    report['allRuntimeAppFilesMatchValidatedBrowserImage'] = True
    report['runtimeAppFileCount'] = len(flat)
    report['runtimeAppManifestHash'] = hashlib.sha256((OUT / 'manifest-flat.json').read_bytes()).hexdigest()
    command(compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'], 'database')
    command(compose + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate'], 'migrate')
    command(compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'app'], 'startup')
    verify = """
const assert=require('assert/strict'),fs=require('fs'),crypto=require('crypto');
(async()=>{
  const p=JSON.parse(fs.readFileSync('/app/test-artifacts/mbr-signing-defaults/prepared.json','utf8'));
  for(const [file,hash] of Object.entries(p.sourceHashes)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/app/'+file)).digest('hex'),hash,file);
  }
  for(const [path,status] of [['/health',200],['/mbr/sign',200],['/mbr/customer.js',200],['/mbr/contracts',200],['/api/mbr/contracts',401]]) {
    const r=await fetch('http://app:3000'+path);assert.equal(r.status,status,path);
    if(path==='/health')assert.equal((await r.json()).ok,true);
  }
  console.log(JSON.stringify({flatImageStartup:true,health:true,sourceHashes:true,http:true}));
})().catch(e=>{console.error(e);process.exit(1)});
"""
    command(compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '-e', verify], 'http')
    report['flatImageStartupAndHttpPassed'] = True
    success = True
finally:
    command(compose + ['down', '--volumes', '--remove-orphans'], 'teardown', 120)
    residual = subprocess.check_output(DOCKER + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.ID}}'], text=True).split()
    if residual:
        subprocess.run(DOCKER + ['rm', '-f', '-v', *residual], check=True)
        command(compose + ['down', '--volumes', '--remove-orphans'], 'teardown-final', 120)
    def output(args):
        return subprocess.check_output(DOCKER + args, text=True).strip()
    cleanup = {'dockerPs': output(['ps', '--format', '{{.Names}} {{.Status}}']),
               'dockerPsA': output(['ps', '-a', '--format', '{{.Names}} {{.Status}}']),
               'containers': output(['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']),
               'networks': output(['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']),
               'volumes': output(['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'])}
    (OUT / 'cleanup.packaging.json').write_text(json.dumps(cleanup, indent=2) + '\n')
    assert not any(cleanup[key] for key in ('containers', 'networks', 'volumes'))
    health = subprocess.check_output(['curl', '-fsS', '--max-time', '15', 'http://127.0.0.1:3000/health'], text=True)
    assert json.loads(health)['ok']
    report.update({'passed': success, 'cleanupVerified': True, 'productionHealth': True,
                   'imageId': prepared['imageId'], 'testImageId': prepared['testImageId']})
    (OUT / 'packaging-check.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)
