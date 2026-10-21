"""Preserve a concurrent, independently validated production release."""
import importlib.util
import io
import json
import shutil
import tarfile
from pathlib import Path

spec=importlib.util.spec_from_file_location('performance_release',Path(__file__).with_name('release.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
r=p.r;old=r.state();live=r.metadata(r.APP)
assert live['configuration']==old['app']['configuration'],'Runtime configuration changed'
assert [r.metadata(name) for name in r.DEPENDENCIES]==old['dependencies'],'Dependencies changed'
hashes=json.loads(r.docker('exec',r.APP,'node','-e',r.HASH_SCRIPT))
changed=sorted(name for name in hashes.keys()|old['beforeTree'].keys() if hashes.get(name)!=old['beforeTree'].get(name))
assert not set(changed)&set(old['files']),'Overlapping production change requires a merge'
assert all(not name.startswith('migrations/') for name in changed),'Schema changed'
other=p.SERVER/'deployments/delivery-time-change-20261008'
other_manifest=json.loads((other/'manifest.json').read_text())
other_validation=json.loads((other/'validation-passed.json').read_text())
assert other_manifest['candidateTree']==hashes
assert other_validation['passed'] and other_validation['candidateTreeHash']==other_manifest['candidateTreeHash']
archive=p.RELEASE/'pre-rebase';archive.mkdir(exist_ok=False)
new_before=p.RELEASE/'rebase-before';new_before.mkdir(exist_ok=False)
raw=r.docker('exec',r.APP,'tar','-cf','-','-C','/app','src','public','migrations','package.json','package-lock.json')
with tarfile.open(fileobj=io.BytesIO(raw)) as stream:stream.extractall(new_before,filter='data')
assert r.files_at(new_before)==hashes and r.metadata(r.APP)==live
new_candidate=p.RELEASE/'rebase-candidate';shutil.copytree(new_before,new_candidate)
for name in old['files']:
    (new_candidate/name).parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(p.RELEASE/'candidate'/name,new_candidate/name)
for name in ['package.json','package-lock.json']:
    assert (new_candidate/name).read_bytes()==(p.RELEASE/'candidate'/name).read_bytes(),'Dependencies changed'
for name in ['before','candidate','capture.json','manifest.json','candidate.patch']:
    shutil.move(p.RELEASE/name,archive/name)
shutil.move(new_before,p.RELEASE/'before');shutil.move(new_candidate,p.RELEASE/'candidate')
capture=json.loads((archive/'capture.json').read_text())
capture.update({'app':live,'dependencies':old['dependencies'],'beforeTree':hashes,'capturedAt':r.now(),
    'rebaseFrom':old['candidateTreeHash'],'preservedConcurrentFiles':changed})
(p.RELEASE/'capture.json').write_text(json.dumps(capture,indent=2)+'\n')
for name in ['evidence.json','EVIDENCE.md','changed-line-coverage.json']:
    shutil.copy2(p.OUT/name,archive/name)
shutil.move(p.OUT/'final',p.OUT/'final-before-rebase')
shutil.move(p.OUT/'final-run.log',p.OUT/'final-before-rebase-run.log')
shutil.move(p.OUT/'live-index-equivalence-comprehensive.jsonl',p.OUT/'live-index-equivalence-before-rebase.jsonl')
p.prepare()
result={'at':r.now(),'originalCandidateTreeHash':old['candidateTreeHash'],'combinedCandidateTreeHash':r.state()['candidateTreeHash'],
    'preservedFiles':changed,'performanceFilesUnchanged':True,'priorReleaseValidation':str(other/'validation-passed.json'),
    'fullRegressionSource':str(archive/'manifest.json'),'requiredCombinedChecks':'Fresh request checks, read-only response comparison, and the affected delivery/PO suites'}
(p.OUT/'rebase.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
