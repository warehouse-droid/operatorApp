"""Scoped Admin IR/IF gate release; preserve live source and configuration."""
import importlib.util
import json
import difflib
import io
import os
import shutil
import tarfile
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gate_release_base', SERVER / 'tools/ifir-integration-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = SERVER / 'deployments/ifir-admin-gate-20261021'
r.OPERATIONAL = SERVER / 'artifacts/ifir-admin-gate-20261021'
r.EVIDENCE = SERVER / 'test-artifacts/ifir-admin-gate-20261021'
r.IMAGE = 'mbbs-operator-app:ifir-admin-gate-20261021'
r.ROLLBACK = r.IMAGE + '-rollback'
r.CHECK = 'mbbs-ifir-admin-gate-image-check'
r.FLAGS = {}
r.core.RELEASE = r.RELEASE
FILES = ['src/netsuite.js', 'src/netsuite-ifir-posting-client.js', 'src/netsuite-ifir-posting-policy.js',
         'src/mbt/feature-gate-catalog.js', 'src/mbt/router.js', 'migrations/300_ifir_posting_admin_gate.sql']


def evidence():
    if sys.argv[1] == 'capture':
        return {name: r.core.sha((SERVER / name).read_bytes()) for name in FILES}
    report = json.loads((r.EVIDENCE / 'final/report.json').read_text())
    assert report['newFailures'] == []
    assert not report['types']['newIssues'] and not report['lint']['newIssues']
    assert len(report['mutation']) == 4 and all(row['killed'] for row in report['mutation'])
    assert sorted(report['source']) == sorted(FILES)
    assert all(row['covered'] == row['total'] for row in report['changedLineCoverage'].values())
    candidate = r.RELEASE / 'candidate'
    assert report['source'] == {name:r.core.sha((candidate / name).read_bytes()) for name in FILES}
    return report['source']


def capture():
    hashes=evidence()
    os.umask(0o077)
    # A failed source-scope assertion may leave only an unbuilt capture.
    if r.RELEASE.exists():
        assert not (r.RELEASE/'manifest.json').exists()
        shutil.rmtree(r.RELEASE)
    r.RELEASE.mkdir()
    before=r.core.metadata(r.core.APP)
    dependencies=[r.core.metadata(name) for name in r.core.DEPENDENCIES]
    roots=json.loads(r.core.docker('exec',r.core.APP,'node','-e',
      "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive=r.core.docker('exec',r.core.APP,'tar','-cf','-','-C','/app',*roots)
    baseline=r.RELEASE/'before';baseline.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:stream.extractall(baseline,filter='data')
    candidate=r.RELEASE/'candidate';shutil.copytree(baseline,candidate)
    patch=''
    for name in FILES:
        original=r.OPERATIONAL/'before'/name
        if original.exists():
            patch+=''.join(difflib.unified_diff(original.read_text().splitlines(True),
                (SERVER/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name,n=1))
        else:
            assert not (candidate/name).exists()
            shutil.copy2(SERVER/name,candidate/name)
    r.core.apply_patch(candidate,patch,'ifir-admin-gate')
    before_tree,after_tree=r.tree(baseline),r.tree(candidate)
    changed=sorted(n for n in before_tree.keys()|after_tree.keys() if before_tree.get(n)!=after_tree.get(n))
    assert changed==sorted(FILES)
    data={'capturedAt':r.core.now(),'authorization':'User requested visible Admin feature gate for the enabled IR/IF flow',
      'app':before,'dependencies':dependencies,'files':changed,'sourceHashes':hashes,
      'candidateSourceHashes':{n:after_tree[n] for n in changed},'beforeTree':before_tree,'candidateTree':after_tree,
      'candidateTreeHash':r.core.sha(json.dumps(after_tree,sort_keys=True).encode()),
      'expectedConfiguration':r.expected_configuration(),'featureGate':{}}
    r.save('manifest.json',data);r.current(data)
    print(json.dumps({'captured':True,'files':changed,'runtimeFiles':len(after_tree)}),flush=True)


def verify():
    data = r.core.state()
    r.core.ready(data['candidateImageId'])
    actual = r.core.metadata(r.core.APP)
    assert actual['configuration'] == data['expectedConfiguration']
    assert [r.core.metadata(name) for name in r.core.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.core.docker('exec',r.core.APP,'node','-e',r.core.HASH_SCRIPT)) == data['candidateTree']
    # Verification never changes the user's current on/off choice.
    code = (SERVER / 'tools/ifir-admin-gate-read.mjs').read_bytes()
    result = json.loads(r.core.docker('exec','-i','-w','/app',r.core.APP,'node','--input-type=module',input=code))
    assert result['effective'] == result['gate']['configured'] and not result['gate']['locked']
    r.save('admin-gate-after.json',result)
    r.health('health-after.json')
    r.cleanup()
    r.save('deployment-result.json',{'deployed':True,'at':r.core.now(),'imageId':actual['imageId'],
      'files':data['files'],'runtimeFilesVerified':len(data['candidateTree']),'gate':result,
      'configurationPreserved':True,'dependenciesUnchanged':True,'rollbackImage':r.ROLLBACK})
    print(json.dumps({'deployed':True,'gate':result['gate']['label'],'effective':result['effective']}),flush=True)


def apply():
    data=r.core.state();r.current(data)
    validation=json.loads((r.RELEASE/'validation-passed.json').read_text())
    assert validation['passed'] and validation['candidateTreeHash']==data['candidateTreeHash']
    migration='300_ifir_posting_admin_gate.sql'
    before=r.core.sql("SELECT row_to_json(f) FROM mbt_feature_flags f WHERE flag_key='netsuite_ifir_posting_restlet';")
    r.save('gate-before.json',json.loads(before) if before else None)
    statement=(r.RELEASE/'candidate/migrations'/migration).read_text()
    r.core.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s';\n"+statement+
      "\nINSERT INTO schema_migrations(filename) VALUES('"+migration+"') ON CONFLICT DO NOTHING; COMMIT;")
    r.apply()


r.evidence=evidence
r.verify=verify
if __name__=='__main__':
    action=sys.argv[1]
    if action=='capture':capture()
    else:{'build':r.build,'validate':r.validate,'apply':apply,'verify':verify,'refresh':r.refresh}[action]()
