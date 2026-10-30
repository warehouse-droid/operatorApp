"""Map recorded executions to the tester pack without treating gaps as passes."""
import csv
import json
import sys
from collections import Counter
from pathlib import Path

server = Path(__file__).resolve().parents[1]
paths = [Path(value).resolve() for value in sys.argv[1:]]
if not paths:
    raise SystemExit('Pass the verification audit JSON files for this run.')
audits = sorted([(path, json.loads(path.read_text())) for path in paths], key=lambda row: row[1]['startedAt'])
latest = {}
for path, audit in audits:
    for entry in audit['files']:
        latest[entry['file']] = {**entry, 'audit': str(path.relative_to(server))}

with (server / 'test/mbt-uat-case-map.tsv').open() as source:
    cases = list(csv.DictReader(source, delimiter='\t'))
assert len(cases) == len({row['Case ID'] for row in cases}) == 152
rows = []
for case in cases:
    names = case['Evidence test basenames'].split(';')
    evidence = [entry for file, entry in latest.items() if Path(file).name in [name + '.test.js' for name in names]]
    missing = [name for name in names if not any(Path(entry['file']).name == name + '.test.js' for entry in evidence)]
    failed = [entry['file'] for entry in evidence if entry['fail'] or entry['cancelled'] or not entry['tests']]
    skipped = [entry['file'] for entry in evidence if entry['skipped'] or entry.get('todo')]
    status = 'Passed automated checks'
    if case['Remaining verification']:
        status = 'Partial - remaining checks recorded'
    if missing or skipped:
        status = 'Partial - automated evidence incomplete'
    if failed:
        status = 'Review - mapped test file has failures'
    rows.append({'Case ID': case['Case ID'], 'Scenario': case['Scenario'], 'Result': status,
                 'Executed evidence': '; '.join(entry['file'] for entry in evidence),
                 'Remaining verification': case['Remaining verification'],
                 'Missing evidence': '; '.join(missing + skipped),
                 'Failure files': '; '.join(failed),
                 'Audit records': '; '.join(sorted({entry['audit'] for entry in evidence}))})

stamp = audits[0][1]['startedAt'][:10].replace('-', '')
destination = server / f'test/mbt-uat-results-{stamp}.csv'
with destination.open('w', newline='', encoding='utf-8-sig') as output:
    writer = csv.DictWriter(output, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
live = json.loads((server / 'test/uat-audits/live-verification-20261024.json').read_text())
source_matches = all(audit['sourceHashes'] == live['sourceHashes'] and not audit['sourceDrift'] for _, audit in audits)
summary = {
    'createdFrom': [str(path.relative_to(server)) for path, _ in audits],
    'firstStartedAt': audits[0][1]['startedAt'], 'lastFinishedAt': audits[-1][1]['finishedAt'],
    'runtime': audits[-1][1]['runtime'], 'matchesDeployedSources': source_matches,
    'latestResults': {key: sum(entry[key] for entry in latest.values()) for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']},
    'uniqueTestFiles': len(latest),
    'browserTestFiles': sum('browser' in file for file in latest),
    'browserTests': sum(entry['tests'] for file, entry in latest.items() if 'browser' in file),
    'caseResults': dict(Counter(row['Result'] for row in rows)),
    'allManualCasesSignedOff': False,
    'configurationFinding': '20YD maximum_payload_kg is not configured. Plan Transport requires bin payload capacity; configure the actual rating before 20YD transport UAT.',
    'limitations': ['Synthetic isolated data; external integrations disabled.',
                    'Real camera/scanner devices and physical driving not exercised.',
                    'Case-specific remaining checks are listed in the CSV; test totals are not manual-case pass counts.'],
    'resultFile': str(destination.relative_to(server))
}
summary_path = server / f'test/uat-audits/summary-{stamp}.json'
summary_path.write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
