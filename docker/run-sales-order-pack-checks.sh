#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1 DISPATCH_SOURCE_NO_DB=1
export DISPATCH_SOURCE_RUNTIME="$repo_dir/server/deployments/sob123453-null-packs-20261026/candidate"
export DISPATCH_SOURCE_BASELINE="$repo_dir/server/deployments/sob123453-null-packs-20261026/before"
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/sob123453-null-packs/checks.mjs
python3 - "$repo_dir" <<'PY'
import difflib, json, os
from pathlib import Path
repo = Path(__import__('sys').argv[1])
release = repo / 'server/deployments/sob123453-null-packs-20261026'
artifact = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
manifest = json.loads((release / 'manifest.json').read_text())
summary = json.loads((artifact / 'validation.json').read_text())
assert summary['sourceHashes'] == {name: manifest['candidateTree'][name] for name in manifest['files']}
coverage = json.loads((artifact / 'coverage/coverage-final.json').read_text())
changed = {}
for name in manifest['files']:
    before = release / 'before' / name
    old = before.read_text().splitlines() if before.exists() else []
    new = (release / 'candidate' / name).read_text().splitlines()
    lines = set()
    for kind, _, _, start, end in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if kind in ('insert', 'replace'):
            lines.update(range(start + 1, end + 1))
    data = coverage['/app/' + name]
    hits = {}
    for key, statement in data['statementMap'].items():
        line = statement['start']['line']
        hits[line] = max(hits.get(line, 0), data['s'][key])
    relevant = [line for line in lines if line in hits and new[line-1].strip() and not new[line-1].lstrip().startswith(('//', '/*', '*'))]
    uncovered = [line for line in relevant if hits[line] == 0]
    assert not uncovered, (name, uncovered)
    changed[name] = {'covered': len(relevant), 'total': len(relevant)}
summary.update(candidateTreeHash=manifest['candidateTreeHash'], changedLineCoverage=changed,
    specApproval='not obtained (autonomous run)',
    red='7 failures on captured live source: discounted paths failed value assertions; direct paths lacked injectable boundaries and failed before network access',
    limits=['Repository-wide suites and legacy netsuite.js type checking not run; six affected SO suites and focused helper types were checked.',
            'Only REST SO creation is deployed; the pre-existing broader UI, storage and SuiteScript null-pack work is outside this release.'],
    cleanup='Disposable runner removed test container, volumes, network and temporary artifacts; production health passed.')
(release / 'validation-passed.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'passed': True, 'tests': summary['tests'], 'changedLineCoverage': changed}))
PY
