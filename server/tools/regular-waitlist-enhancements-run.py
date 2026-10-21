"""Independent remote-disabled runner for the requested waitlist enhancements."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/regular-waitlist-enhancements-20261002'
REMOTE = '/tmp/mbbs-waitlist-enhancements'
FILES = json.loads((ROOT / 'tools/regular-waitlist-enhancements-files.json').read_text())
spec = importlib.util.spec_from_file_location('waitlist_enhancement_runner', ROOT / 'tools/regular-waitlist-run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.OUT, runner.REMOTE = OUT, REMOTE


def capture():
    assert not (OUT / 'before').exists(), 'Never overwrite the source baseline.'
    OUT.mkdir(parents=True, exist_ok=True)
    for file in FILES:
        source = ROOT / file
        if source.exists():
            target = OUT / 'before' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    baseline = OUT / 'frozen-baseline'
    for folder in ['src', 'public', 'migrations', 'test', 'tools']:
        shutil.copytree(ROOT / folder, baseline / folder, ignore=shutil.ignore_patterns('__pycache__'))
    for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
        shutil.copy2(ROOT / file, baseline / file)
    print(json.dumps({'captured': True, 'scope': FILES}))


def sync():
    runner.sync()
    runner.docker('cp', str(ROOT / 'tools/regular-waitlist-enhancements-files.json'), runner.RUNNER + ':' + REMOTE + '/tools/regular-waitlist-files.json')


def freeze(kind):
    target = REMOTE + '-' + kind
    runner.docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", target)
    if kind == 'baseline':
        runner.docker('cp', str(OUT / 'frozen-baseline') + '/.', runner.RUNNER + ':' + target)
        runner.docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", target)
    else:
        snapshot=OUT/'frozen-final'
        assert not snapshot.exists(), 'Never replace a full-suite snapshot while it may be running.'
        shutil.copytree(OUT/'frozen-baseline',snapshot)
        for file in FILES:
            destination=snapshot/file
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(ROOT/file,destination)
        for group in ['unit','property','integration','adversarial']:
            for source in (ROOT/'test/mbt'/group).glob('regular-waitlist*.test.js'):
                shutil.copy2(source,snapshot/'test/mbt'/group/source.name)
        shutil.copy2(ROOT/'test/support/regular-waitlist-list-harness.mjs',snapshot/'test/support/regular-waitlist-list-harness.mjs')
        shutil.copytree(ROOT/'tools',snapshot/'tools',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
        runner.docker('cp',str(snapshot)+'/.',runner.RUNNER+':'+target)
        runner.docker('exec',runner.RUNNER,'node','-e',"require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",target)
    print(json.dumps({'frozen': kind}))


def collect():
    runner.docker('cp', runner.RUNNER + ':' + REMOTE + '/test-artifacts/regular-waitlist/.', str(OUT))
    subprocess.run(['sudo', '-n', 'chown', '-R', str(os.getuid()) + ':' + str(os.getgid()), str(OUT)], check=True)


def validation_source():
    release=ROOT/'deployments/regular-waitlist-enhancements-20261002'
    for kind,suffix in [('candidate','-release'),('before','-release-before')]:
        target=release/('validation-'+kind)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(release/kind,target)
        for folder in ['test','tools']:
            shutil.copytree(ROOT/folder,target/folder,ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(ROOT/'tools/regular-waitlist-enhancements-files.json',target/'tools/regular-waitlist-files.json')
        shutil.copy2(ROOT/'netsuite-smart-scm-picking-ticket-restlet.js',target)
        shutil.copytree(OUT/'before',target/'test-artifacts/regular-waitlist/before')
        if (OUT/'changed-diffs.json').exists():
            shutil.copy2(OUT/'changed-diffs.json',target/'test-artifacts/regular-waitlist/changed-diffs.json')
        remote=REMOTE+suffix
        runner.docker('exec',runner.RUNNER,'node','-e',"const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)",remote)
        runner.docker('cp',str(target)+'/.',runner.RUNNER+':'+remote)
        runner.docker('exec',runner.RUNNER,'node','-e',"require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",remote)
    print(json.dumps({'releaseValidationSourcesReady':True}))


def run(label,command):
    for flag,suffix in [('--release','-release'),('--release-baseline','-release-before')]:
        if flag in command:
            command.remove(flag)
            runner.REMOTE=REMOTE+suffix
    return runner.run(label,command)


def collect_release():
    (OUT/'release').mkdir(exist_ok=True)
    runner.docker('cp',runner.RUNNER+':'+REMOTE+'-release/test-artifacts/regular-waitlist/.',str(OUT/'release'))
    subprocess.run(['sudo','-n','chown','-R',str(os.getuid())+':'+str(os.getgid()),str(OUT/'release')],check=True)


if __name__ == '__main__':
    os.umask(0o077)
    action = sys.argv[1]
    if action == 'capture':
        capture()
    elif action == 'setup':
        runner.setup()
    elif action == 'sync':
        sync()
    elif action in ['freeze-baseline', 'freeze-final']:
        freeze(action.removeprefix('freeze-'))
    elif action == 'collect':
        collect()
    elif action == 'validation-source':
        validation_source()
    elif action == 'collect-release':
        collect_release()
    else:
        sys.exit(run(action, sys.argv[2:]))
