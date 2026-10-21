"""Verify a frozen release image in a clean, disposable environment."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release',SERVER/'tools/count-sheet-refresh-deploy.py')
release=importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
OUT=release.OUT
SOURCE=OUT/'verification-source'
ENV={**os.environ,'COUNT_REFRESH_NAME':'mbbs-count-refresh-test','COUNT_REFRESH_SOURCE':str(SOURCE)}


def setup():
    SOURCE.mkdir()
    for folder in ['test','tools','contracts']:
        shutil.copytree(SERVER/folder,SOURCE/folder)
    for file in [*SERVER.glob('*.json'),*SERVER.glob('*.js'),SERVER/'Dockerfile']:
        shutil.copy2(file,SOURCE/file.name)
    image=release.state()['imageId']
    container=release.docker('create','--network','none','--entrypoint','true',image).decode().strip()
    try:
        for folder in ['src','public','migrations']:
            release.docker('cp',container+':/app/'+folder,str(SOURCE/folder))
            subprocess.run(['sudo','-n','chmod','-R','a+rX',str(SOURCE/folder)],check=True)
    finally:
        release.docker('rm',container)
    for prior in (OUT/'live-before').rglob('*'):
        if prior.is_file():
            target=SOURCE/'test/support/count-sheet-refresh-baseline'/prior.relative_to(OUT/'live-before')
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(prior,target)
    subprocess.run(['python3',str(SOURCE/'tools/count-sheet-refresh-diff.py')],check=True)
    subprocess.run(['bash',str(SERVER/'tools/count-sheet-refresh-env.sh'),'stop'],env=ENV,check=True)
    subprocess.run(['bash',str(SERVER/'tools/count-sheet-refresh-env.sh'),'start'],env=ENV,check=True)
    with (OUT/'verification-migration.log').open('wb') as log:
        subprocess.run(['bash',str(SERVER/'tools/count-sheet-refresh-env.sh'),'exec','node','src/migrate.js'],env=ENV,stdout=log,stderr=subprocess.STDOUT,check=True)
    print(json.dumps({'ready':True,'imageId':image}))


def run():
    with (OUT/'verification.log').open('wb') as log:
        result=subprocess.run(['sudo','-n','docker','exec','-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test_file_000000000000_focus',
            '-w','/app','mbbs-count-refresh-test-runner','node','tools/count-sheet-refresh-checks.mjs'],stdout=log,stderr=subprocess.STDOUT)
    print(json.dumps({'exitCode':result.returncode,'log':str(OUT/'verification.log')}))
    return result.returncode


if __name__=='__main__':
    if sys.argv[1]=='setup':
        setup()
    else:
        sys.exit(run())
