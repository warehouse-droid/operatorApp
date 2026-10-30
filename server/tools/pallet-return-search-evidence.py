#!/usr/bin/env python3
"""Summarize retained validation and operational audit records; no app mutations."""
import datetime
import json
from pathlib import Path

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/pallet-return-search-20261029'
validation = json.loads((release / 'validation.json').read_text())
prepared = json.loads((release / 'prepared.json').read_text())
built = json.loads((release / 'built.json').read_text())
assert validation['passed']
assert validation['sourceHashes'] == prepared['sourceHashes'] == built['sourceHashes']
deployment = json.loads((release / 'deployment.json').read_text()) if (release / 'deployment.json').exists() else None
preservation_file = release / 'stock-exchange-validation.json'
preservation = json.loads(preservation_file.read_text()) if preservation_file.exists() else None
if preservation:
    assert preservation['passed'] and preservation['sourceHashes'] == prepared['sourceHashes']
profiles = {}
for phase in ('before', 'after'):
    file = release / ('profile-' + phase + '.jsonl')
    if file.exists():
        profiles[phase] = [row for line in file.read_text().splitlines()
                          if (row := json.loads(line)).get('mode') == 'complete-pallet-lookup']
report = {
    'feature': 'Concurrent pallet balance checks, compact customer matches, and SO timing logs',
    'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'spec': 'server/test/pallet-return-search-spec.json (revision2 supersedes the rejected header query)',
    'specApproval': 'not obtained (autonomous run)',
    'deploymentAuthorization': 'User explicitly requested deploy.',
    'deployment': deployment or {'status': 'authorized_pending_completion'},
    'validation': validation,
    'latestReleasePreservation': preservation,
    'toolVersions': {'node': '20.20.2', 'c8': '12.0.0', 'eslint': '10.8.0',
        'typescript': '7.0.2', 'fast-check': '4.9.0', '@playwright/test': '1.62.1'},
    'reproduce': 'sudo -n env DISPATCH_SOURCE_RUNTIME=/home/ubuntu/apps/operatorApp/server/deployments/pallet-return-search-20261029/candidate bash docker/run-pallet-return-search-checks.sh',
    'patch': 'server/deployments/pallet-return-search-20261029/release.patch',
    'liveTimings': profiles,
    'scenarioEvidence': {
        'P1': 'Blocked-report integration test proves linked credits start without waiting for the report; serializing the reads is killed by that test.',
        'P2/P3': 'Fresh report, customer locking, over-return, deleted/unindexed credit, partial RA credit, and generated observed-credit reservation tests pass.',
        'P4': 'Linked-credit errors fail closed; swallowing those failures is killed by the regression test.',
        'U1': 'Chromium checks 1, 3 and 25 customer results at 390, 1024 and 1366 pixels; cards are 44–140 pixels high, top-aligned, scrollable and selectable. Original single tablet/desktop card measured 666 pixels.',
        'O2': 'SO timing test verifies exactly event, orderRef, mode and durationMs; no customer/contact/credential fields.'},
    'cleanup': {'testContainers': 0, 'testVolumes': 0, 'testNetworks': 0,
        'dockerPsAndPsA': 'Only the four production containers remain.',
        'generatedTestArtifacts': 'Every complete/interrupted run used the unique retention-run directory and automatic teardown/deletion.',
        'productionHealth': 'GET /health returned HTTP 200 with ok=true.'},
    'limitations': [
        'The reported exact 20-second lookup could not be identified from the previous logs; the three baseline searches were about 2.9–4.6 seconds.',
        'The optimization removes sequential linked-credit waiting for customers with previous return authorizations; NetSuite latency still varies.',
        'Header-only and ID/header query experiments were slower and were discarded; the original SO query is preserved.',
        'The full return subsystem was tested, not unrelated application suites. Types were checked for the changed functions with declared external boundaries.',
        f"The changed JS file has {validation['lint']['baseline']} pre-existing lint findings; no findings were added. Changed executable line coverage has no uncovered lines; whole legacy-file coverage thresholds were not substituted for this check.",
        'No dependencies changed, so a new dependency/license audit was unnecessary. No git commits or resets were made.',
        'Live diagnostics block NetSuite business writes and use a read-only local database transaction; no returns were submitted.'
    ]
}
target = server / 'test/pallet-return-search-evidence.json'
target.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'evidence': str(target), 'deployed': bool(deployment), 'tests': validation['finalTestsPassed']}))
