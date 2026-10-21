"""Reproducible waitlist checks in dedicated, remote-disabled Docker containers."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/regular-waitlist'
NETWORK = 'mbbs-waitlist-review'
RUNNER = 'mbbs-waitlist-review-runner'
DB = 'mbbs-waitlist-review-db'
REMOTE = '/tmp/mbbs-waitlist-review-code'


def docker(*args):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], stderr=subprocess.STDOUT)


def exists(kind, name):
    return subprocess.run(['sudo', '-n', 'docker', kind, 'inspect', name], capture_output=True).returncode == 0


def setup():
    OUT.mkdir(parents=True, exist_ok=True)
    if not exists('network', NETWORK):
        docker('network', 'create', '--internal', NETWORK)
    if not exists('container', DB):
        docker('run', '-d', '--name', DB, '--network', NETWORK, '--network-alias', 'db', '-e', 'POSTGRES_PASSWORD=waitlist-test-only', '-e', 'POSTGRES_DB=mbt_test', 'postgres:18-alpine')
    aliases = json.loads(docker('inspect', DB))[0]['NetworkSettings']['Networks'][NETWORK].get('Aliases') or []
    if 'db' not in aliases:
        docker('network', 'disconnect', NETWORK, DB)
        docker('network', 'connect', '--alias', 'db', NETWORK, DB)
    docker('exec', DB, 'psql', '-U', 'postgres', '-c', "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mbt_test') THEN CREATE ROLE mbt_test LOGIN SUPERUSER PASSWORD 'waitlist-test-only'; END IF; END $$;")
    if exists('container', RUNNER):
        existing_env = json.loads(docker('inspect', RUNNER))[0]['Config']['Env']
        if not any(value.startswith('DATABASE_URL=postgresql://mbt_test:') for value in existing_env):
            docker('rm', '-f', RUNNER)
    if not exists('container', RUNNER):
        docker('run', '-d', '--name', RUNNER, '--network', NETWORK, '-e', 'DATABASE_URL=postgresql://mbt_test:waitlist-test-only@db:5432/mbt_test',
               '-e', 'MBT_TEST_ISOLATED=1', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
               '-e', 'MBBS_ENV_FILE=.env.nonexistent', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers',
               '--entrypoint', 'sleep', 'mbbs-regular-v2:e2e', 'infinity')
    print(json.dumps({'isolated': True, 'runner': RUNNER, 'database': DB}))


def sync():
    stage = OUT / 'runner-source'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    for folder in ['src', 'public', 'migrations', 'test', 'tools']:
        shutil.copytree(ROOT / folder, stage / folder, ignore=shutil.ignore_patterns('__pycache__'))
    for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
        shutil.copy2(ROOT / file, stage / file)
    if (OUT / 'before').exists():
        shutil.copytree(OUT / 'before', stage / 'test-artifacts/regular-waitlist/before')
    for name in ['baseline.json', 'baseline-full.log', 'changed-diffs.json']:
        if (OUT / name).exists():
            target = stage / 'test-artifacts/regular-waitlist' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(OUT / name, target)
    docker('exec', RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", REMOTE)
    docker('cp', str(stage) + '/.', RUNNER + ':' + REMOTE)
    docker('exec', RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", REMOTE)
    docker('exec', RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1],b=p+'-baseline';if(!fs.existsSync(b)){fs.cpSync(p,b,{recursive:true,filter:x=>!x.endsWith('/node_modules')});fs.symlinkSync('/app/node_modules',b+'/node_modules','dir')}", REMOTE)
    print(json.dumps({'synced': True}))


def capture():
    before = OUT / 'before'
    assert not before.exists(), 'Do not overwrite the baseline.'
    for file in json.loads((ROOT / 'tools/regular-waitlist-files.json').read_text()):
        source = ROOT / file
        if source.exists():
            target = before / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    (OUT / 'baseline-source.json').write_text(json.dumps({str(p.relative_to(before)): hashlib.sha256(p.read_bytes()).hexdigest() for p in before.rglob('*') if p.is_file()}, indent=2))


def run(label, command):
    info = json.loads(docker('inspect', RUNNER))[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'])
    assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    assert '@db:5432/mbt_test' in env['DATABASE_URL']
    assert NETWORK in info['NetworkSettings']['Networks']
    workspace = REMOTE+'-baseline' if label.startswith('baseline-full') else REMOTE+'-final' if label.startswith('final-full') else REMOTE
    if '--release' in command:
        command.remove('--release')
        workspace = '/tmp/mbbs-waitlist-release-candidate'
    if '--release-baseline' in command:
        command.remove('--release-baseline')
        workspace = '/tmp/mbbs-waitlist-release-before'
    options = []
    if '--verify' in command:
        command.remove('--verify')
        verification_url = urlsplit(env['DATABASE_URL'])._replace(path='/mbt_verify').geturl()
        options = ['-e', '='.join(['DATABASE_URL', verification_url])]
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(['sudo', '-n', 'docker', 'exec', *options, '-w', workspace, RUNNER, *command], stdout=log, stderr=subprocess.STDOUT)
    print(json.dumps({'label': label, 'exitCode': result.returncode, 'tail': (OUT / (label + '.log')).read_text()[-3500:]}), flush=True)
    return result.returncode


if __name__ == '__main__':
    os.umask(0o077)
    action = sys.argv[1]
    if action == 'setup': setup()
    elif action == 'capture': capture()
    elif action == 'sync': sync()
    elif action == 'freeze':
        docker('exec', RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1],b=p+'-final';fs.rmSync(b,{recursive:true,force:true});fs.cpSync(p,b,{recursive:true,filter:x=>!x.endsWith('/node_modules')});fs.symlinkSync('/app/node_modules',b+'/node_modules','dir')", REMOTE)
    elif action == 'save-baseline':
        target = OUT/'frozen-baseline'
        assert not target.exists(), 'Do not overwrite the frozen source baseline'
        target.mkdir()
        for name in ['src','public','migrations','test','package.json','package-lock.json']:
            docker('cp',RUNNER+':'+REMOTE+'-baseline/'+name,str(target/name))
        subprocess.run(['sudo','-n','chown','-R',str(os.getuid())+':'+str(os.getgid()),str(target)],check=True)
    elif action == 'collect':
        docker('cp', RUNNER + ':' + REMOTE + '/test-artifacts/regular-waitlist/.', str(OUT))
        subprocess.run(['sudo','-n','chown','-R',str(os.getuid())+':'+str(os.getgid()),str(OUT)],check=True)
    elif action == 'collect-release':
        (OUT/'release').mkdir(exist_ok=True)
        docker('cp', RUNNER + ':/tmp/mbbs-waitlist-release-candidate/test-artifacts/regular-waitlist/.', str(OUT/'release'))
        subprocess.run(['sudo','-n','chown','-R',str(os.getuid())+':'+str(os.getgid()),str(OUT/'release')],check=True)
    else: sys.exit(run(action, sys.argv[2:]))
