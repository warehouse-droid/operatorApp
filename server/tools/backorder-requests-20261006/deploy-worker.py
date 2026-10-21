"""Publish only the tested Backorder webhook exclusion to the existing worker."""
import json
from pathlib import Path
import deploy as release

release.APP='mbbs-operator-app-webhook-worker-1'
release.SERVICE='webhook-worker'
release.DEPENDENCIES=['mbbs-operator-app-app-1','mbbs-operator-app-db-1','mbbs-operator-app-ollama-1']
release.RELEASE=release.RELEASE.parent/'release-worker'
release.OUT=release.OUT/'worker'
release.OUT.mkdir(parents=True,exist_ok=True)
release.BASE='mbbs-operator-app:backorder-worker-base-20261007'
release.IMAGE='mbbs-operator-app:backorder-worker-20261007'
release.FILES=['src/special-stock-request-repository.js']

# Worker source deliberately differs from the app. Check the actual worker snapshot
# and its tested one-line candidate, then use the same packaging/publication machinery.
original_prepare=release.prepare
original_root=release.ROOT

def prepare():
    evidence=json.loads(release.EVIDENCE_FILE.read_text())
    file=release.FILES[0]
    expected=evidence['workerManifest'][file]
    candidate=original_root/'tools/backorder-requests-20261006/worker-candidate'/file
    baseline=original_root/'tools/backorder-requests-20261006/baseline-worker'/file
    assert release.sha(candidate.read_bytes())==expected
    assert release.sha(release.docker('exec',release.APP,'cat','/app/'+file))==release.sha(baseline.read_bytes()),'Worker changed since validation'
    release.ROOT=original_root/'tools/backorder-requests-20261006/worker-candidate'
    target=release.ROOT/'tools/backorder-requests-20261006/baseline'/file
    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(baseline.read_bytes())
    local=json.loads(release.EVIDENCE_FILE.read_text());local['manifest']={file:expected}
    local_evidence=release.OUT/'worker-summary.json';local_evidence.write_text(json.dumps(local,indent=2))
    old_evidence=release.EVIDENCE_FILE;release.EVIDENCE_FILE=local_evidence
    try:original_prepare()
    finally:release.ROOT=original_root;release.EVIDENCE_FILE=old_evidence

def verify():
    state=json.loads((release.RELEASE/'state.json').read_text());manifest=json.loads((release.RELEASE/'manifest.json').read_text())
    current=release.metadata(release.APP)
    assert current['image']==manifest['candidateImage'] and current['configHash']==state['configHash']
    assert all(release.sha(release.docker('exec',release.APP,'cat','/app/'+file))==expected for file,expected in manifest['files'].items())
    assert release.docker('inspect','--format','{{.State.Running}}',release.APP).decode().strip()=='true'
    result={'deployed':True,'service':'webhook-worker','image':current['image'],'configurationPreserved':True,'files':manifest['files']}
    (release.OUT/'deployed.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)

release.verify=verify
if __name__=='__main__':
    import sys
    {'prepare':prepare,'apply':release.apply,'verify':verify}[sys.argv[1]]()
