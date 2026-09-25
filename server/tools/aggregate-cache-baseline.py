"""Record a newly observed baseline cache-age failure only with replay evidence."""
from pathlib import Path
import hashlib
import json

SERVER = Path(__file__).resolve().parents[1]
ART = SERVER / 'test-artifacts/aggregate-access-flow'
FILE = 'test/mbt/integration/stock-return-draft-insert.test.js'
TEST = 'normal stock draft preserves every line field and consumes the draft only on success'
logs = {
    'flake-baseline.log': (8, 0),
    'flake-baseline-expired.log': (3, 3),
    'flake-final.log': (5, 5),
    'flake-final-fresh.log': (3, 0)
}
evidence = {}
for name, (runs, failures) in logs.items():
    content = (ART / name).read_text()
    assert f'Regression replays failed: {failures}/{runs}' in content
    if failures:
        assert TEST in content
        assert 'metadata-catalog/record/v1/creditMemo?expandSubResources=true' in content
        assert "method: 'GET'" in content
    evidence[name] = {'runs': runs, 'failedRuns': failures, 'sha256': hashlib.sha256(content.encode()).hexdigest()}
sources = {}
for name in [FILE, 'src/return-repository.js', 'src/return-netsuite.js', 'src/netsuite.js', 'src/config.js', 'src/db.js']:
    current = (SERVER / name).read_bytes()
    assert current == (ART / 'baseline' / name).read_bytes(), name
    sources[name] = hashlib.sha256(current).hexdigest()
original = json.loads((ART / 'baseline-full.json').read_text())
assert FILE not in original['failures']
result = {**original, 'failures': {**original['failures'], FILE: [TEST]},
          'countsDescribe': 'Initial full baseline run; failure-name union additionally includes the independently reproduced cache-age case below.',
          'additionalBaselineObservations': {
              'reason': 'The unchanged return-reason cache expires after ten minutes. The test treats its metadata GET as an unexpected write. Fresh-cache old/new runs pass; expired-cache old/new runs fail identically.',
              'unchangedSources': sources, 'replays': evidence,
              'reproductionTool': 'tools/aggregate-regression-replay.mjs'}}
(SERVER / 'test/aggregate-access-existing-baseline.json').write_text(json.dumps(result, indent=2) + '\n')
(ART / 'baseline-cache-evidence.json').write_text(json.dumps(result['additionalBaselineObservations'], indent=2) + '\n')
print('Preserved the initial baseline and recorded the independently reproduced cache-age failure with replay/source hashes.')
