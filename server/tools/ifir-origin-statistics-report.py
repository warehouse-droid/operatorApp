#!/usr/bin/env python3
"""Build the requested IF/IR statistics from retained read-only operational evidence."""
import collections
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/ifir-origin-20261029'
source = [json.loads(line) for line in (OUT / 'source-audit.jsonl').read_text().splitlines()]
supplement = [json.loads(line) for line in (OUT / 'document-location-audit.jsonl').read_text().splitlines()]
period = next(row for row in source if row['phase'] == 'totals')
local = next(row for row in source if row['phase'] == 'local')
directory = {row['id']: row for block in source if block['phase'] == 'locations' for row in block['locations']}
headers = [row for block in source if block['phase'] == 'headers' for row in block['rows']]
assert len(headers) == len({row['id'] for row in headers}), 'Duplicate transaction headers'
assert len(headers) == sum(int(row['count']) for row in period['totals'])
for total in period['totals']:
    assert sum(row['type'] == total['type'] and row['status'] == total['status'] for row in headers) == int(total['count'])

locations = collections.defaultdict(set)
for block in supplement:
    if block['phase'] == 'document-locations':
        for row in block['rows']:
            locations[row['id']].add(row.get('location_id'))
assert set(locations) == {row['id'] for row in headers}
assert all(len(value) == 1 and None not in value for value in locations.values()), 'Missing or multiple main locations'

proofs = collections.defaultdict(list)
for row in local['proofs']:
    proofs[row['transaction_id']].append(row)
review = next(row for row in supplement if row['phase'] == 'review-creation-contexts')
assert not review.get('hasMore') and review['count'] == review['requested']
review_by_id = {row['recordid']: row for row in review['rows']}
assert all(row['type'] == '1' and row['field'] == 'TRANDOC.NKEY' and row['context'] == 'UIF'
           for row in review_by_id.values())

by_location = collections.defaultdict(collections.Counter)
details = []
linked_existing = []
for row in headers:
    kind = {'ItemShip': 'IF', 'ItemRcpt': 'IR'}[row['type']]
    external = row.get('externalid', '')
    application = external.startswith(('MBBS-OP-', 'MBBS-SOIF-'))
    if application:
        assert row['createdby'] == '8721'
        assert row['id'] in proofs, 'An app marker needs retained local posting evidence'
    elif row['createdby'] == '8721' or row['id'] in proofs:
        assert row['id'] in review_by_id, 'An unmarked app-user/linked record needs creation-context review'
    if not application and row['id'] in proofs:
        linked_existing.append(row['tranid'])
    location_id = next(iter(locations[row['id']]))
    assert location_id in directory
    origin = 'application' if application else 'netsuite_only'
    by_location[location_id][f'{kind}_{origin}'] += 1
    details.append({'type': kind, 'reference': row['tranid'], 'netsuite_id': row['id'],
                    'created_at_toronto': row['created_at'], 'document_date': row['transaction_date'],
                    'location_id': location_id, 'location': directory[location_id]['fullname'],
                    'origin': origin, 'external_id': external,
                    'classification_evidence': 'NetSuite app marker and local posting record' if application
                    else 'NetSuite UI creation note' if row['id'] in review_by_id
                    else 'No app marker or application creation record'})

location_order = ['1', '8', '14', '28', '37', '26', '15', '4', '5', '50']
summary = []
for location_id in sorted(by_location, key=lambda value: (location_order.index(value) if value in location_order else 99, value)):
    counts = by_location[location_id]
    entry = {'location_id': location_id, 'location': directory[location_id]['fullname']}
    for kind in ['IF', 'IR']:
        app = counts[f'{kind}_application']
        outside = counts[f'{kind}_netsuite_only']
        entry.update({f'{kind}_application': app, f'{kind}_netsuite_only': outside,
                      f'{kind}_total': app + outside,
                      f'{kind}_application_percent': round(100 * app / (app + outside), 1) if app + outside else None})
    summary.append(entry)

totals = {}
for kind in ['IF', 'IR']:
    app = sum(row[f'{kind}_application'] for row in summary)
    outside = sum(row[f'{kind}_netsuite_only'] for row in summary)
    totals[kind] = {'application': app, 'netsuite_only': outside, 'total': app + outside,
                    'application_percent': round(100 * app / (app + outside), 1)}
assert sum(row['total'] for row in totals.values()) == len(headers)

report = {'period': {key: period[key] for key in ['startDate', 'cutoff', 'timeZone', 'dateBasis', 'capturedAt']},
          'countingBasis': 'Existing NetSuite documents created during the period, counted once by main document location; IF status C (shipped), IR status Y.',
          'originBasis': 'App external IDs cross-checked against local posting records; NetSuite-only means created outside this application. Existing NetSuite documents later linked in the app remain NetSuite-only.',
          'locations': summary, 'totals': totals,
          'verification': {'remoteHeaders': len(headers), 'uniqueMainLocations': len(locations),
                           'appDocumentsWithLocalProof': sum(row['application'] for row in totals.values()),
                           'unmarkedAppUserOrLinkedRecordsReviewedAsNetSuiteUI': review['count'],
                           'linkedExistingDocumentsExcludedFromAppCount': linked_existing,
                           'pendingOrUncertainCommandsNotCountedUnlessRemoteDocumentExists': local['pending']},
          'limitations': ['Counts use creation dates, not backdated accounting/document dates.',
                          'Records deleted before the report are absent from current NetSuite totals.',
                          'Location follows the main document location, not each item line; child locations remain separate.']}
(OUT / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
with (OUT / 'by-location.csv').open('w', newline='') as file:
    writer = csv.DictWriter(file, fieldnames=list(summary[0]))
    writer.writeheader()
    writer.writerows(summary)
with (OUT / 'transactions.csv').open('w', newline='') as file:
    writer = csv.DictWriter(file, fieldnames=list(details[0]))
    writer.writeheader()
    writer.writerows(details)
print(json.dumps(report, indent=2))
