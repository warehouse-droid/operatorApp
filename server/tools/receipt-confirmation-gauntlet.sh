#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="$server_root/test-artifacts/receipt-confirmation"
cd "$server_root/.."
# The immutable pre-change capture and release manifest identify the baseline.
# Every execution creates fresh test sources and results from that capture.
python3 - "$server_root" <<'PY'
from pathlib import Path
import difflib,hashlib,json,shutil,sys
root=Path(sys.argv[1]); artifact=root/'test-artifacts/receipt-confirmation'
state=json.loads((artifact/'release/manifest.json').read_text())
before=artifact/'verification-before'; candidate=artifact/'verification-source'
for directory in [before,candidate,artifact/'v8',artifact/'browser']:
 if directory.exists(): shutil.rmtree(directory)
for name in ['static.json','focused.json','health.json','mutations.json','coverage.json','full-comparison.json','verification.json']:
 (artifact/name).unlink(missing_ok=True)
shutil.copytree(artifact/'before',before)
for folder in ['src','public','migrations']:
 shutil.rmtree(before/folder)
 shutil.copytree(artifact/'release/baseline'/folder,before/folder)
shutil.copytree(before,candidate)
for folder in ['src','public']:
 shutil.rmtree(candidate/folder)
 shutil.copytree(artifact/'release/candidate'/folder,candidate/folder)
files=['test/mbt/unit/receipt-confirmation.test.js','test/mbt/integration/receipt-confirmation.test.js',
 'test/mbt/unit/receiving-posting-status.test.js','test/mbt/unit/operator-receiving-return.test.js',
 'test/mbt/unit/operator-posting-photo-client.test.js','test/mbt/unit/operator-delivery-refresh.test.js',
 'test/mbt/unit/operator-direct-orderline-client.test.js',
 'test/support/receipt-confirmation-client.mjs']
files += [str(p.relative_to(root)) for p in (root/'tools').glob('receipt-confirmation-*') if p.is_file()]
for file in files:
 (candidate/file).parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(root/file,candidate/file)
manifest={}; patch=''
for file,expected in state['after'].items():
 new=(candidate/file).read_text(); old=(before/file).read_text() if (before/file).exists() else ''
 assert hashlib.sha256(new.encode()).hexdigest()==expected
 a,b=old.splitlines(True),new.splitlines(True)
 patch+=''.join(difflib.unified_diff(a,b,fromfile='a/'+file,tofile='b/'+file,n=3))
 lines=[line+1 for tag,i,j,k,l in difflib.SequenceMatcher(None,a,b).get_opcodes() if tag in ['insert','replace'] for line in range(k,l)]
 manifest[file]={'hash':expected,'lines':lines}
(artifact/'changes.json').write_text(json.dumps(manifest,indent=2))
(artifact/'changes.patch').write_text(patch)
PY
candidate_env() { RECEIPT_CONFIRMATION_BASELINE=2 RECEIPT_CONFIRMATION_SOURCE="$artifact/verification-source" bash server/tools/receipt-confirmation-env.sh "$@"; }
baseline_env() { RECEIPT_CONFIRMATION_BASELINE=3 RECEIPT_CONFIRMATION_SOURCE="$artifact/verification-before" bash server/tools/receipt-confirmation-env.sh "$@"; }
cleanup() { candidate_env stop; baseline_env stop; }
trap cleanup EXIT
candidate_env start
baseline_env start
candidate_env exec env RECEIPT_CONFIRMATION_BASELINE_ROOT=/app/test-artifacts/receipt-confirmation/verification-before \
  node tools/receipt-confirmation-checks.mjs static > "$artifact/static-run.log" 2>&1
candidate_env exec node tools/receipt-confirmation-checks.mjs focused > "$artifact/focused-run.log" 2>&1
candidate_env exec node tools/receipt-confirmation-checks.mjs mutations > "$artifact/mutations-run.log" 2>&1
candidate_env exec env NODE_V8_COVERAGE=/app/test-artifacts/receipt-confirmation/v8 node tools/receipt-confirmation-smoke.mjs > "$artifact/smoke.log" 2>&1
candidate_env exec env NODE_V8_COVERAGE=/app/test-artifacts/receipt-confirmation/v8 node tools/receipt-confirmation-adversarial.mjs > "$artifact/adversarial.log" 2>&1
candidate_env exec node tools/receipt-confirmation-browser.mjs > "$artifact/browser-final.log" 2>&1
candidate_env exec node tools/receipt-confirmation-checks.mjs coverage > "$artifact/coverage-run.log" 2>&1
candidate_env exec node tools/receipt-confirmation-checks.mjs health > "$artifact/health-run.log" 2>&1
(baseline_env exec npm test > "$artifact/baseline-full.log" 2>&1 || true) &
baseline_pid=$!
(candidate_env exec npm test > "$artifact/candidate-full.log" 2>&1 || true) &
candidate_pid=$!
wait "$baseline_pid"
wait "$candidate_pid"
candidate_env exec node tools/receipt-confirmation-checks.mjs full-comparison > "$artifact/full-comparison-run.log" 2>&1
python3 - "$artifact" <<'PY'
from pathlib import Path
import hashlib,json,sys
artifact=Path(sys.argv[1]); state=json.loads((artifact/'release/manifest.json').read_text())
for name in ['static','focused','mutations','coverage','health','full-comparison']:
 report=json.loads((artifact/(name+'.json')).read_text())
 assert report['sources']==state['after'],name+' source mismatch'
for file,digest in state['after'].items():
 assert hashlib.sha256((artifact/'release/candidate'/file).read_bytes()).hexdigest()==digest
result={'passed':True,'sources':state['workspace'],'candidateSources':state['after']}
(artifact/'verification.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
PY
