"""Refresh a prepared release only when both verified runtime files are unchanged."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil

TASK = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('sor_release', TASK / 'deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.evidence()
data = release.state()
actual = release.metadata(release.APP)
dependencies = [release.metadata(name) for name in release.DEPENDENCIES]
assert actual != data['app'], 'The prepared base is already current'
for file in release.FILES:
    before = release.docker('exec', release.APP, 'cat', '/app/' + file)
    assert release.digest(before) == data['before'][file], 'Live runtime changed; merge and reverify: ' + file
    assert before == (TASK / 'baseline' / file).read_bytes(), 'Live file differs from tested baseline: ' + file
    assert release.digest((release.RELEASE / 'candidate' / file).read_bytes()) == data['after'][file]
assert release.metadata(release.APP) == actual, 'App changed during recapture'
assert [release.metadata(name) for name in release.DEPENDENCIES] == dependencies
os.umask(0o077)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
archive = release.RELEASE / ('prepared-before-rebase-' + stamp)
archive.mkdir()
for name in ['manifest.json', 'prepared.json', 'build-single-copy.log', 'compose.rollback.yml']:
    source = release.RELEASE / name
    if source.exists():
        shutil.copy2(source, archive / name)
old_app = data['app']
data.update({'app': actual, 'dependencies': dependencies,
    'baseImageTag': 'mbbs-operator-app:sor-return-base-' + actual['imageId'].split(':')[-1][:12],
    'rebasedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
data.pop('candidateImageId', None)
release.docker('tag', actual['imageId'], data['baseImageTag'])
(release.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + actual['imageId'] + '\n')
release.save('manifest.json', data)
release.current(data)
(release.EVIDENCE / 'live-base-image.txt').write_text(actual['imageId'] + '\n')
record = {'at': data['rebasedAt'], 'previousBase': old_app['imageId'],
    'currentBase': actual['imageId'], 'currentBaseTag': actual['image'],
    'runtimeBaselineUnchanged': True, 'runtimeFiles': release.FILES,
    'previousPreparation': str(archive), 'userApproval': 'deploy'}
release.save('rebase-result.json', record)
(release.EVIDENCE / 'release-rebase.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record), flush=True)
