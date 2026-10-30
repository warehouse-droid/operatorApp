#!/usr/bin/env python3
"""Scoped receipt refresh release; merge only this task's workspace delta."""
import json
import runpy
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope, base = release['scope'], release['base']
scope.update(
    OUT=scope['SERVER'] / 'deployments/stock-request-followups-20261027',
    FILES=json.loads((scope['SERVER'] / 'tools/stock-request-followups-files.json').read_text()),
    IMAGE='mbbs-operator-app:stock-request-followups-20261027',
    ROLLBACK='mbbs-operator-app:stock-request-followups-rollback-20261027')

original_merge=base['merge']
def merge(live,before,after,file,label):
    # Repair is being changed independently. Apply only the timezone substitution
    # to its current live rendering, preserving the other task's code.
    if file in ['public/repair/app.js','public/repair/job.js']:
        return live.replace(b'.toLocaleString()',b".toLocaleString(undefined,{timeZone:'America/Toronto'})")
    return original_merge(live,before,after,file,label)
base['merge']=merge

def candidate():
    out=scope['OUT']
    for file in scope['FILES']:
        prior=out/'workspace-before'/file;live=out/'live-before'/file
        content=merge(live.read_bytes() if live.exists() else b'',prior.read_bytes(),(scope['SERVER']/file).read_bytes(),file,'followups') if prior.exists() else (scope['SERVER']/file).read_bytes()
        assert b'<<<<<<< ' not in content,file
        target=out/'candidate'/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)

def rebase():
    from datetime import datetime,timezone
    out=scope['OUT'];archive=out/('prior-base-'+datetime.now(timezone.utc).strftime('%H%M%S'));archive.mkdir()
    for name in ['capture.json','live-before','candidate','prepared.json']:
        path=out/name
        if path.exists():path.rename(archive/name)
    release['prepare']()

if __name__=='__main__':
    {'prepare':release['prepare'],'candidate':candidate,'rebase':rebase,**{name:base[name] for name in ['build','deploy','verify']}}[sys.argv[1]]()
