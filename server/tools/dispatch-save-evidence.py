"""Summarize completed, source-bound save gates; never turn partial runs into passes."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/dispatch-save-reliability'


def read(name):
    return json.loads((ARTIFACT / name).read_text())


def source_matches(sources, root=ROOT):
    def digest(name):
        path = root / name
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    return bool(sources) and all(digest(name) == value for name, value in sources.items())


def bound(name, allow_failure=False):
    data = read(f'{name}-sources.json')
    return (data.get('completedAt') and source_matches(data['sources'])
            and (allow_failure or data.get('exitCode') == 0))


def evidence(scope='release'):
    report, failures = {}, []

    def gate(name, run):
        excluded = {'pr': {'stress', 'races', 'soak', 'history', 'sourceHistory', 'performance', 'full', 'suiteHealth'},
                    'full': {'history', 'sourceHistory', 'suiteHealth'}, 'release': set()}
        if name in excluded[scope]:
            report[name] = {'skipped': True, 'reason': f'{scope} CI scope; private history and current diagnostic artifacts remain release evidence.'}
            return
        try:
            value, passed = run()
            report[name] = {'passed': bool(passed), **value}
            if not passed:
                failures.append(name)
        except (OSError, KeyError, ValueError, TypeError, AssertionError) as error:
            report[name] = {'passed': False, 'unavailable': str(error)}
            failures.append(name)

    checks = read('checks.json')
    gate('focused', lambda: ({'completedAt': checks.get('completedAt'), 'mutationsKilled': len(checks['kills']),
                             'propertyMutationsKilled': len(checks['propertyKills'])},
                            checks.get('completedAt') and source_matches(checks['sources']) and bound('checks')
                            and len(checks['kills']) >= 6 and checks['kills'] == checks['propertyKills']))
    for mode, minimum in [('stress', 10000), ('races', 1000), ('soak', 3600000)]:
        def result(mode=mode, minimum=minimum):
            data = read(f'{mode}.json')
            count = data.get('elapsedMs', 0) if mode == 'soak' else data.get('races' if mode == 'races' else 'saves', 0)
            return ({key: data.get(key) for key in ['startedAt', 'completedAt', 'saves', 'races', 'elapsedMs', 'replays', 'viewers', 'maxUpdateMs', 'error']},
                    data.get('completedAt') and not data.get('error') and count >= minimum and source_matches(data['sources']))
        gate(mode, result)

    def history():
        data = read('private-history/replay-final-report.json')
        counts = Counter(row.get('result', row['classification']) for row in data['records'])
        expected = sum(data['tables'][name]['records'] for name in ['dispatch_plan_commands', 'dispatch_plan_snapshot_history', 'dispatch_plan_snapshots'])
        return ({'startedAt': data['startedAt'], 'completedAt': data.get('completedAt'), 'retainedStates': len(data['records']),
                 'outcomes': dict(counts), 'maximumMs': data['maxUpdateMs'], 'over500ms': len(data['updatesOver500ms']),
                 'unexpectedFailures': len(data['unexpected']), 'gaps': data['gaps']},
                data.get('completedAt') and data.get('sourceUnchanged') and source_matches(data['sources'])
                and len(data['records']) == expected and not data['unexpected'])
    gate('history', history)
    def source_history():
        data = read('private-history/replay-source-events.json')
        expected = sum(data['tables'][name]['records'] for name in ['dispatch_plan_commands', 'dispatch_plan_snapshot_history', 'dispatch_plan_snapshots'])
        hidden = [row for row in data['records'] if row.get('sourceEvent', {}).get('simulated')
                  and not row['sourceEvent'].get('observedInRefresh')]
        return ({'completedAt': data.get('completedAt'), 'retainedStates': len(data['records']),
                 'simulatedSourceEvents': data['sourceEvents'], 'visibleRefreshes': data['sourceRefreshesObserved'],
                 'hiddenRefreshesByRejection': dict(Counter(row.get('code', 'unexplained') for row in hidden)),
                 'unexpectedFailures': len(data['unexpected']), 'gaps': data['gaps']},
                data.get('completedAt') and data.get('sourceUnchanged') and source_matches(data['sources'])
                and len(data['records']) == expected and data['sourceEventSimulation']
                and data['sourceEvents'] > 0 and data['sourceRefreshesObserved'] > 0 and not data['unexpected']
                and data['sourceRefreshesObserved'] + len(hidden) == data['sourceEvents']
                and all(row.get('result') == 'rejected' and row.get('code') == 'NETSUITE_ORDER_CLOSED' for row in hidden))
    gate('sourceHistory', source_history)
    gate('sourceBrowser', lambda: ({'engines': read('source-browser.json')}, bound('source-browser')
        and {row['engine'] for row in read('source-browser.json')} == {'chromium', 'webkit'}
        and all(row['sourceEvents'] == 3 and row['sourceDataVisible'] and row['newerEditPreserved']
                and row['falseConflicts'] == 0 and row['maximumActionMs'] <= 500 for row in read('source-browser.json'))))

    def browsers():
        data, source = read('playwright.json'), read('playwright-source.json')
        return ({'engines': data, 'completedAt': source['completedAt']}, source_matches(source['sources'])
                and {row['engine'] for row in data} == {'chromium', 'webkit'}
                and all(row['lateAckPreserved'] and row['lostResponseRecovered'] and row['exactReplay']
                        and row['confirmationRetriedOnce'] and row['draftExportExcludesLease']
                        and row['maximumActionMs'] <= 500 and row['maximumFrameGapMs'] <= 500
                        and row['backgroundSaveHeldMs'] >= 1500 for row in data))
    gate('playwright', browsers)
    gate('journal', lambda: ({'engines': read('journal-browser.json')}, len(read('journal-browser.json')) == 2
                            and bound('journal') and all(row['roundTrip'] and row['bounded'] and row['survivedReload'] and row['separatedOwners']
                                    for row in read('journal-browser.json'))))
    gate('snapshotBrowser', lambda: ({'engines': read('snapshot-browser.json')}, bound('snapshot-browser')
         and {row['engine'] for row in read('snapshot-browser.json')} == {'chromium', 'webkit'}
         and all(row['exactRestoreRetry'] and row['oneCommit'] and row['pendingRestoreBlocksExitAndDate']
                 and row['missingArchiveReported'] for row in read('snapshot-browser.json'))))
    gate('complexity', lambda: (read('complexity.json'), bound('complexity') and not read('complexity.json')['exceeded']))
    gate('rollback', lambda: (read('rollback-compatibility.json'), bound('rollback')
         and read('rollback-compatibility.json')['priorSourceReadsAcknowledgedPlan']))
    def suite_health():
        reports = {}
        for mode in ['baseline', 'candidate']:
            data = read(f'flake-order-{mode}.json')
            metadata = read(f'flake-order-{mode}-sources.json')
            assert source_matches(metadata['sources'], ARTIFACT / 'baseline' if mode == 'baseline' else ROOT)
            rows = []
            for attempt in data['attempts']:
                log = (ARTIFACT / f"flake-order-{mode}-{attempt['attempt']}.log").read_text()
                rows.append(attempt['sameFailure'] and '"integrityPreserved":true' in log)
            reports[mode] = {'sameLegacyAssertionFailures': sum(rows), 'runs': len(rows),
                             'allPersistedIntegrityChecksPassed': all(rows), 'completedAt': data.get('completedAt')}
        return ({'cancelFirstSchedule': reports,
                 'note': 'Original assertions retained. Both versions scrub an already-cancelled CO; the old exactly-one-success assertion depends on arrival order.'},
                all(row['completedAt'] and row['runs'] == 10 and row['allPersistedIntegrityChecksPassed'] for row in reports.values()))
    gate('suiteHealth', suite_health)
    gate('performance', lambda: (read('performance-comparison.json'), read('performance-comparison.json')['passed']
                                and source_matches(read('performance-comparison.json')['candidateSources'])))
    for name in ['full', 'adjacent']:
        gate(name, lambda name=name: (read(f'{name}-comparison.json'), not read(f'{name}-comparison.json')['newFailures'] and bound(name, allow_failure=True)))
    gate('static', lambda: (read('static-comparison.json'), not read('static-comparison.json')['newLint']
                           and not read('static-comparison.json')['newTypes'] and bound('static')))
    gate('secrets', lambda: (read('secrets.json'), not read('secrets.json')['findings'] and bound('secrets')))
    coverage = read('changed-line-coverage.json')
    gate('coverage', lambda: ({'files': coverage}, all(not row['uncovered'] for row in coverage.values()) and bound('coverage')))
    gate('inventory', lambda: (read('inventory.json'), bound('inventory') and read('inventory.json')['newDependencies'] == 0))
    sources = read('checks-sources.json')['sources']
    return {'passed': not failures, 'failedGates': failures, 'sources': sources,
            'sourceState': hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest(), 'gates': report}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--scope', choices=['pr', 'full', 'release'], default='release')
    args = parser.parse_args()
    report = evidence(args.scope)
    (ARTIFACT / ('evidence.json' if args.scope == 'release' else f'evidence-{args.scope}.json')).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'failedGates': report['failedGates']}))
    if args.check:
        assert report['passed'], 'Release blocked by incomplete or failed evidence gates'
