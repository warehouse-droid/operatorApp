"""Reconcile the completed authorized backfill and write a dispatch-readable report."""
import collections
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/actual-arrival-repair'
before = json.loads((ARTIFACT / 'history-before.json').read_text())
after = json.loads((ARTIFACT / 'history-after.json').read_text())
backfill = json.loads((ARTIFACT / 'history-backfill.json').read_text())
assert backfill['originalDriverEvidenceUnchanged'], 'Original evidence fingerprint mismatch'
assert backfill['summary']['failedRoutes'] == 0, 'Historical routes remain failed'
assert len(backfill['routes']) == backfill['summary']['appliedRoutes']
assert after['reconciliation']['recordsAttempted'] == sum(route['recordCount'] for route in backfill['routes'])
for key, id_key in [('plans', 'id'), ('snapshots', 'planId')]:
    assert {row[id_key]: row['hash'] for row in before[key]} == {row[id_key]: row['hash'] for row in after[key]}, f'Historical {key} changed'
old = {str(row['recordId']): row for row in before['arrivals']}
new = {str(row['recordId']): row for row in after['arrivals']}
assert old.keys() == new.keys()
for record_id in old:
    assert all(old[record_id][key] == new[record_id][key] for key in ['startedAt', 'completedAt']), record_id

reasons = collections.Counter()
unresolved = []
for route, entry in backfill['results'].items():
    date, driver = route.split('|', 1)
    for stop in entry['unresolvedStops']:
        reasons[stop['reason']] += 1
        retained = sum(bool(new[str(record_id)]['actualArrival']) for record_id in stop['recordIds'])
        unresolved.append({'date': date, 'driver': driver, 'orders': ', '.join(stop['orders']), 'load': stop['load'],
                           'reason': stop['reason'], 'recordIds': ', '.join(map(str, stop['recordIds'])),
                           'previousDerivedArrivalsRetained': retained})
csv_path = ARTIFACT / 'unresolved-arrivals.csv'
with csv_path.open('w', newline='') as out:
    writer = csv.DictWriter(out, fieldnames=['date', 'driver', 'orders', 'load', 'reason', 'recordIds', 'previousDerivedArrivalsRetained'])
    writer.writeheader()
    writer.writerows(unresolved)

counts = {'records': len(new), **backfill['summary'], 'firstDate': backfill['routes'][0]['planDate'],
          'lastDate': backfill['routes'][-1]['planDate'],
          'canonicalArrivalsBefore': sum(bool(row['actualArrival']) for row in old.values()),
          'canonicalArrivalsAfter': sum(bool(row['actualArrival']) for row in new.values()),
          'newlyResolvedRecords': sum(not old[key]['actualArrival'] and bool(new[key]['actualArrival']) for key in old),
          'changedExistingArrivals': sum(bool(old[key]['actualArrival']) and bool(new[key]['actualArrival']) and old[key]['actualArrival'] != new[key]['actualArrival'] for key in old),
          'unavailableVisits': sum(row['previousDerivedArrivalsRetained'] == 0 for row in unresolved),
          'visitsRetainingPreviousArrival': sum(row['previousDerivedArrivalsRetained'] > 0 for row in unresolved),
          'unresolvedReasons': dict(reasons), 'originalDriverEvidenceUnchanged': True, 'historicalPlansUnchanged': True,
          'maximumSampleStatusQueryMs': max((row['statusQueryMs'] for row in after['examples']), default=None)}
(ARTIFACT / 'history-summary.json').write_text(json.dumps(counts, indent=2) + '\n')
lines = ['# Historical actual-arrival recalculation', '',
         f"Processed **{counts['records']} completed pickup/dropoff records across {counts['appliedRoutes']} driver-days**, {counts['firstDate']} through {counts['lastDate']}.", '',
         f"{counts['resolvedVisits']} physical visits resolved; {counts['unchangedFirstVisits']} first visits kept their original PWA start; {counts['unresolvedVisits']} visits remain unresolved. Failed routes: {counts['failedRoutes']}.", '',
         f"Canonical arrival records: {counts['canonicalArrivalsBefore']} before, {counts['canonicalArrivalsAfter']} after; {counts['newlyResolvedRecords']} records newly resolved and {counts['changedExistingArrivals']} prior arrival times corrected. Grouped orders can share one physical visit.", '',
         'Original driver rows (including starts, completions and photos) and historical plans/snapshots match their before-state fingerprints. Existing derived arrivals are retained where a replacement could not be established.', '',
         f"Of the {counts['unresolvedVisits']} unresolved recalculations, {counts['unavailableVisits']} visits display Arrival unavailable and {counts['visitsRetainingPreviousArrival']} retain their previous derived arrival.", '',
         '| Unresolved reason | Physical visits |', '| --- | ---: |']
lines += [f'| {reason} | {count} |' for reason, count in reasons.most_common()]
lines += ['', 'Exact dates, drivers, orders, load and reason: [unresolved-arrivals.csv](unresolved-arrivals.csv).', '',
          'Deployment health, runtime hashes, complete route/run IDs, immutable evidence fingerprints and before-arrival backup are retained alongside this report.']
(ARTIFACT / 'history-report.md').write_text('\n'.join(lines) + '\n')
print(json.dumps(counts))
