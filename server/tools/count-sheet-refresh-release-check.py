"""Freeze before/after release trees with identical tests and run broad regressions."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release',SERVER/'tools/count-sheet-refresh-deploy.py')
release=importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
OUT=release.OUT


def freeze():
    state=release.state()
    for kind,image in [('before',state['before']['imageId']),('after',state['imageId'])]:
        destination=OUT/('full-'+kind)
        destination.mkdir(exist_ok=True)
        for folder in ['test','tools','contracts']:
            shutil.copytree(SERVER/folder,destination/folder,dirs_exist_ok=True)
        for file in [*SERVER.glob('*.json'),*SERVER.glob('*.js'),SERVER/'Dockerfile']:
            shutil.copy2(file,destination/file.name)
        container=release.docker('create','--network','none','--entrypoint','true',image).decode().strip()
        try:
            for folder in ['src','public','migrations']:
                if not (destination/folder).exists():
                    release.docker('cp',container+':/app/'+folder,str(destination/folder))
                subprocess.run(['sudo','-n','chmod','-R','a+rX',str(destination/folder)],check=True)
        finally:
            release.docker('rm',container)
        env={**__import__('os').environ,'COUNT_REFRESH_NAME':'mbbs-count-refresh-live-'+kind,'COUNT_REFRESH_SOURCE':str(destination)}
        present=subprocess.run(['sudo','-n','docker','inspect','mbbs-count-refresh-live-'+kind+'-runner'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if present.returncode:
            subprocess.run(['bash',str(SERVER/'tools/count-sheet-refresh-env.sh'),'start'],env=env,check=True)
        with (OUT/('full-'+kind+'-migration.log')).open('wb') as log:
            subprocess.run(['bash',str(SERVER/'tools/count-sheet-refresh-env.sh'),'exec','node','src/migrate.js'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    print(json.dumps({'frozen':True,'sameTests':True,'images':[state['before']['imageId'],state['imageId']]}))


def run(kind):
    assert kind in ['before','after']
    runner='mbbs-count-refresh-live-'+kind+'-runner'
    release.docker('exec','-d','-w','/app',runner,'node','tools/count-sheet-refresh-watchdog.mjs')
    with (OUT/('full-'+kind+'.log')).open('wb') as log:
        result=subprocess.run(['sudo','-n','docker','exec','-w','/app',runner,'npm','test'],stdout=log,stderr=subprocess.STDOUT)
    print(json.dumps({'kind':kind,'exitCode':result.returncode,'log':str(OUT/('full-'+kind+'.log'))}))
    return result.returncode


if __name__=='__main__':
    if sys.argv[1]=='freeze':
        freeze()
    else:
        sys.exit(run(sys.argv[1]))
