"""Observe lock dependencies during the bounded transactional deployment."""
import importlib.util,json,threading,time
from pathlib import Path

spec=importlib.util.spec_from_file_location('performance_release',Path(__file__).with_name('release.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
original=p.r.sql
def tagged(sql):
    if sql.startswith('BEGIN; SET LOCAL lock_timeout'):
        sql=sql.replace('BEGIN;','BEGIN; SET LOCAL application_name=\'mbbs_request_loading_migration\';',1)
    return original(sql)
p.r.sql=tagged
stop=threading.Event();samples=[]
def observe():
    while not stop.wait(0.25):
        sql="""BEGIN READ ONLY; SET LOCAL statement_timeout='2s';
SELECT coalesce(json_agg(x),'[]') FROM (
SELECT a.pid,a.application_name,a.wait_event_type,a.wait_event,pg_blocking_pids(a.pid) AS blockers,
coalesce((SELECT json_agg(json_build_object('relation',c.relname,'mode',l.mode,'granted',l.granted))
FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=a.pid AND c.relkind='v'),'[]') AS view_locks
FROM pg_stat_activity a WHERE a.datname=current_database() AND
(a.application_name='mbbs_request_loading_migration' OR cardinality(pg_blocking_pids(a.pid))>0)) x; COMMIT;"""
        try:
            rows=json.loads(original(sql))
            if rows:samples.append({'at':time.time(),'sessions':rows})
        except Exception as error:samples.append({'error':str(error)})
thread=threading.Thread(target=observe,daemon=True);thread.start()
try:p.apply()
finally:
    stop.set();thread.join(timeout=5)
    (p.OUT/'deployment-lock-observed.json').write_text(json.dumps(samples,indent=2)+'\n')
