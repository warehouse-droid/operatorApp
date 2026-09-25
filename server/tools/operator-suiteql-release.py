"""One-file release for Operator SuiteQL queue isolation, with immutable rollback."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/operator-suiteql-20260924-v1')
core.BEFORE = SERVER / 'test-artifacts/operator-suiteql/baseline'
core.EXISTING = core.FILES = ['src/netsuite.js']
core.ADDED = []
core.IMAGE = 'mbbs-operator-app:operator-suiteql-20260924-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-operator-suiteql-20260924-v1'
ART = SERVER / 'test-artifacts/operator-suiteql'
HASH_SCRIPT = """import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const hashes={};function visit(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())visit(file);else if(entry.isFile())hashes[file.replace('/app/','')]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}
for(const folder of ['src','public','migrations'])visit('/app/'+folder);
for(const file of ['package.json','package-lock.json'])hashes[file]=crypto.createHash('sha256').update(fs.readFileSync('/app/'+file)).digest('hex');
console.log(JSON.stringify(hashes));"""


def prepare():
    core.RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    before = core.docker('exec', core.APP, 'cat', '/app/src/netsuite.js')
    assert before == (core.BEFORE / 'src/netsuite.js').read_bytes(), 'Live code differs from tested baseline'
    after = (SERVER / 'src/netsuite.js').read_bytes()
    prefix = b'export async function suiteql(q, params = [], options = {}) {\n  const run = () => runSuiteql(q, params, options);\n'
    branch = b'  if (isOperatorNetSuiteRequest()) {return run();}\n'
    assert before.count(prefix) == 1 and after == before.replace(prefix, prefix + branch)
    sources = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=HASH_SCRIPT.encode()))
    for folder, data in [('baseline', before), ('candidate', after), ('stage', after)]:
        target = core.RELEASE / folder / 'src/netsuite.js'
        target.parent.mkdir(parents=True)
        target.write_bytes(data)
        target.chmod(0o644)
    state.update({'image': core.IMAGE, 'before': {'src/netsuite.js': core.digest(before)},
                  'after': {'src/netsuite.js': core.digest(after)},
                  'workspace': {'src/netsuite.js': core.digest(after)}, 'changedFiles': core.FILES,
                  'unchangedSources': {file: sha for file, sha in sources.items() if file not in core.FILES}})
    assert core.metadata(core.APP) == state['app']
    (core.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + core.IMAGE + '\n')
    (core.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    core.save('manifest.json', state)
    print(json.dumps({'prepared': True, 'changedFiles': core.FILES, 'unchangedSources': len(state['unchangedSources'])}))


def build():
    core.build()
    state = core.manifest()
    actual = json.loads(core.docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', '-i',
                                   core.IMAGE, '--input-type=module', input=HASH_SCRIPT.encode()))
    assert actual == {**state['unchangedSources'], **state['after']}, 'Unrelated runtime sources changed'
    print(json.dumps({'allCandidateSourcesVerified': len(actual)}))


def validate():
    state = core.manifest()
    core.current(state)
    checks = json.loads((ART / 'checks.json').read_text())
    regression = json.loads((ART / 'regression.json').read_text())
    image_smoke = json.loads((ART / 'image-smoke.json').read_text())
    assert checks['passed'] and regression['passed']
    assert checks['sourceHash'] == regression['sourceHash'] == state['after']['src/netsuite.js']
    assert image_smoke['passed'] and image_smoke['baselineBlocked']
    assert image_smoke['candidateImageId'] == state['candidateImageId']
    assert image_smoke['sourceHash'] == state['after']['src/netsuite.js']
    core.save('verified.json', {'passed': True, 'imageId': state['candidateImageId'], 'checks': checks, 'regression': regression, 'imageSmoke': image_smoke})
    print('Release candidate checks verified')


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(core.APP)
    assert after['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    actual = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=HASH_SCRIPT.encode()))
    assert actual == {**state['unchangedSources'], **state['after']}
    script = """import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const results=[];for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
for(const path of ['/health','/api/auth/bootstrap-needed','/operator']){const start=Date.now();const r=await fetch(base+path,{signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);results.push({base,path,status:r.status,ms:Date.now()-start});}
const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'health-nonexistent-'+randomUUID(),password:'invalid-health-probe'}),signal:AbortSignal.timeout(5000)});assert.equal(r.status,401);results.push({base,path:'/api/auth/login',status:r.status});}
console.log(JSON.stringify(results));"""
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'image': core.IMAGE, 'imageId': after['imageId'], 'startedAt': after['startedAt'],
              'allSourcesVerified': len(actual), 'configurationPreserved': True, 'dependenciesUnchanged': True, 'probes': probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def assert_idle():
    sql = """BEGIN READ ONLY; SET LOCAL statement_timeout='3s';
SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))
     + (SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting')
     + (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state='idle in transaction'); COMMIT;"""
    lines = core.database(sql).strip().splitlines()
    assert '0' in lines and all(value in ['BEGIN', 'SET', '0', 'COMMIT'] for value in lines), 'Posting or admission is active; retry when idle'


def apply():
    state = core.manifest()
    core.current(state)
    verified = json.loads((core.RELEASE / 'verified.json').read_text())
    assert verified['passed'] and verified['imageId'] == state['candidateImageId']
    resolved = json.loads(subprocess.check_output(core.compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=core.ROOT))['services']['app']
    image = json.loads(core.docker('image', 'inspect', core.IMAGE))[0]
    runtime = json.loads(core.docker('inspect', core.APP))[0]['Config']
    assert image['Id'] == state['candidateImageId']
    expected_env = dict(entry.split('=', 1) for entry in image['Config']['Env'])
    expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in runtime['Env']), 'Environment drift'
    for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        value = resolved.get(key)
        assert (image['Config'].get(field) if value is None else value) == runtime.get(field), field
    assert_idle()
    core.current(state)
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (core.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (core.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=core.ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        core.save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': build, 'validate': validate, 'apply': apply, 'verify': verify}[sys.argv[1]]()
