"""Reuse scoped image release/rollback checks for the two split-visibility SQL conditions."""
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import sys

SERVER=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release_kit',SERVER/'tools/link-to-fix-deploy.py')
kit=importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit)
core=kit.core
kit.RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/active-split-parent-20260918-v1')
kit.VERIFIED=SERVER
kit.FILES=['src/delivery-repository.js']
kit.ADDED=[]
kit.TESTS=['test/mbt/integration/operator-split-parent-visibility.test.js',
    'test/mbt/integration/operator-delivery-reference.test.js',
    'test/mbt/integration/operator-linked-quantity-repository.red.test.js',
    'test/dispatch/integration/co-source-packing-handoff.test.js',
    'test/dispatch/integration/dispatch-split-address.test.js',
    'test/mbt/integration/link-to-fix.test.js']
ARTIFACT=SERVER/'test-artifacts/active-split-parent'
FROZEN=[*kit.FILES,*kit.TESTS,'tools/active-split-parent-live.mjs','tools/active-split-parent-deploy.py']

@contextmanager
def service(worker=False):
    keys=['APP','SERVER','RELEASE','BEFORE','FILES','ADDED','EXISTING','IMAGE','ROLLBACK','DEPENDENCIES']
    previous={key:getattr(core,key) for key in keys}
    role='worker' if worker else 'app'
    core.APP=kit.WORKER if worker else kit.APP
    core.SERVER=SERVER
    core.RELEASE=kit.RELEASE/role
    core.BEFORE=ARTIFACT/'baseline'
    core.FILES=kit.FILES
    core.ADDED=[]
    core.EXISTING=kit.FILES
    core.IMAGE=f'mbbs-operator-app:active-split-parent-{role}-20260918-v1'
    core.ROLLBACK=f'mbbs-operator-app:rollback-active-split-parent-{role}-20260918-v1'
    core.DEPENDENCIES=[kit.APP if worker else kit.WORKER,kit.DB,'mbbs-operator-app-ollama-1']
    try: yield
    finally:
        for key,value in previous.items(): setattr(core,key,value)

def source_gate():
    assert '# pass 53\n# fail 0\n' in (ARTIFACT/'green.log').read_text()
    for name,digest in json.loads((ARTIFACT/'source.json').read_text()).items():
        assert core.digest((SERVER/name).read_bytes())==digest,name

def live(mode='--preflight'):
    runtime=json.loads(core.docker('inspect',kit.APP))[0]
    environment=kit.RELEASE/'live-env.private'
    environment.write_text('\n'.join(runtime['Config']['Env'])+'\n')
    environment.chmod(0o600)
    image=kit.state()['candidateImageId'] if mode=='--preflight' else runtime['Image']
    try:
        output=core.docker('run','--rm','--network',next(iter(runtime['NetworkSettings']['Networks'])),
            '--volumes-from',kit.APP+':ro','--env-file',str(environment),
            '-v',str(SERVER/'tools/active-split-parent-live.mjs')+':/app/tools/active-split-parent-live.mjs:ro',
            '--entrypoint','node',image,'/app/tools/active-split-parent-live.mjs',mode).decode()
        result=json.loads(output.strip().splitlines()[-1])
        if mode!='--baseline':
            before=json.loads((kit.RELEASE/'live-baseline.json').read_text())
            old={row['id']:row for row in before['orders']}
            current={row['id']:row for row in result['orders']}
            assert set(current)<=set(old),'Unexpected newly visible order'
            removed=set(old)-set(current)
            assert removed<=set(before['allowedRemoved']),'Unrelated active order removed'
            assert result['protectedState']==before['protectedState'],'Protected delivery history changed'
            result['removedParents']=[old[key]['ref'] for key in sorted(removed)]
        kit.save('live-'+mode.removeprefix('--')+'.json',result)
        print(json.dumps({'passed':True,'mode':mode,'activeCount':len(result['orders']),
            'removedParents':result.get('removedParents',[])}),flush=True)
        return result
    finally: environment.unlink()

def prepare():
    (ARTIFACT/'source.json').write_text(json.dumps({name:core.digest((SERVER/name).read_bytes()) for name in FROZEN},indent=2))
    source_gate()
    kit.prepare()

def preflight():
    live('--baseline')
    live('--preflight')

kit.service=service
kit.source_gate=source_gate
kit.live=live
if __name__=='__main__':
    os.umask(0o077)
    {'prepare':prepare,'build':kit.build,'check':kit.check,'preflight':preflight,
        'apply':kit.apply,'verify':kit.verify}[sys.argv[1]]()
