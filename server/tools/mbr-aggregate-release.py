#!/usr/bin/env python3
"""Narrow MBT transport/availability release over the captured live application."""
import json,runpy,sys,subprocess
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope=release['scope'];base=release['base']
scope.update(OUT=scope['SERVER']/'deployments/mbr-aggregate-planning-20261023',
    FILES=json.loads((scope['SERVER']/'tools/mbr-aggregate-files.json').read_text()),
    IMAGE='mbbs-operator-app:mbr-aggregate-20261023',ROLLBACK='mbbs-operator-app:mbr-aggregate-rollback-20261023')
def apply_migration():
    name='309_bin_transport_planning.sql';db=base['db']
    if db("SELECT filename FROM schema_migrations WHERE filename='"+name+"';"):
        return {'filename':name,'alreadyApplied':True}
    path=scope['OUT']/'candidate/migrations'/name
    db("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+path.read_text()+
       "\nINSERT INTO schema_migrations(filename) VALUES ('"+name+"'); COMMIT;")
    return {'filename':name,'applied':True,'sha256':base['sha'](path),'rollback':'Retain additive tables; restore captured application image.'}
original_verify=base['verify']
def verify():
    original_verify()
    assert base['db']("SELECT to_regclass('public.mbt_transport_trips');")=='mbt_transport_trips'
    assert base['db']('SELECT count(*) FROM mbt_aggregate_routing_items;')!='0'
    checks=[]
    for path,expected in [('/bin-transport-ui.js',200),('/mbt-aggregate-routing.js',200),('/mbt/config',200),
            ('/mbt/assets',200),('/api/mbt/planning/transport?planDate=2026-10-23',401),('/api/mbt/config/aggregate-routing',401)]:
        status=subprocess.check_output(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}',
            'http://127.0.0.1:3000'+path],text=True)
        assert int(status)==expected,path+': '+status
        checks.append({'path':path,'status':int(status)})
    base['save'](scope['OUT']/'transport-live-verification.json',{'schema':True,'http':checks})
scope['apply_migration']=apply_migration;scope['verify']=verify
if __name__=='__main__':
    {'prepare':release['prepare'],'build':base['build'],'deploy':base['deploy'],'verify':verify}[sys.argv[1]]()
