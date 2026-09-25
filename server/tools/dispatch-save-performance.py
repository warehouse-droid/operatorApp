"""Compare matched real-browser samples without relaxing the approved budgets."""
import argparse
import json
import math
from pathlib import Path
import statistics


def p95(values):
    return sorted(values)[math.ceil(len(values) * 0.95) - 1]


def describe(rows):
    first = [row['startupMs'][0] for row in rows]
    repeats = [value for row in rows for value in row['startupMs'][1:]]
    edits = [value for row in rows for value in row['editMs']]
    saves = [value for row in rows for value in row['saveMs']]
    return {'firstNavigationMs': statistics.mean(first), 'firstNavigationMedianMs': statistics.median(first), 'firstNavigationSamplesMs': first,
            'repeatNavigationMedianMs': statistics.median(repeats),
            'repeatNavigationP95Ms': p95(repeats),
            'editMedianMs': statistics.median(edits), 'editP95Ms': p95(edits),
            'saveP95Ms': p95(saves), 'startupRequestCounts': [row['requestCounts'] for row in rows]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default='server/test-artifacts/dispatch-save-reliability')
    parser.add_argument('--series', help='Preserved sample suffix, e.g. r2-pair, followed by 1..N')
    parser.add_argument('--replicates', type=int, default=1)
    parser.add_argument('--cold-series', help='Additional paired first-navigation-only sample suffix')
    parser.add_argument('--cold-replicates', type=int, default=0)
    args = parser.parse_args()
    assert args.replicates >= 1 and (args.series or args.replicates == 1)
    assert args.cold_replicates >= 0 and bool(args.cold_series) == bool(args.cold_replicates)
    root = Path(args.directory)
    def samples(mode, series=None, replicates=1):
        files = [f'browser-{mode}-{series}{index}.json' for index in range(1, replicates + 1)] if series else [f'browser-{mode}.json']
        data = [json.loads((root / file).read_text()) for file in files]
        assert all(row.get('completedAt') for row in data), 'Incomplete browser measurement'
        assert all(row['sources'] == data[0]['sources'] for row in data), 'Cannot combine different runtime versions'
        return data
    baseline, candidate = samples('baseline', args.series, args.replicates), samples('candidate', args.series, args.replicates)
    cold_baseline = samples('baseline', args.cold_series, args.cold_replicates) if args.cold_series else []
    cold_candidate = samples('candidate', args.cold_series, args.cold_replicates) if args.cold_series else []
    for full, cold in [(baseline, cold_baseline), (candidate, cold_candidate)]:
        assert all(row['sources'] == full[0]['sources'] for row in cold), 'Cold samples must use the same runtime'
        assert all(len(row['startupMs']) == 1 and not row['editMs'] for sample in cold for row in sample['reports'])
    results = []
    for engine in ['chromium', 'webkit']:
        before = describe([next(row for row in sample['reports'] if row['engine'] == engine) for sample in baseline])
        after = describe([next(row for row in sample['reports'] if row['engine'] == engine) for sample in candidate])
        for summary, extra in [(before, cold_baseline), (after, cold_candidate)]:
            first = summary['firstNavigationSamplesMs']
            first.extend(next(row for row in sample['reports'] if row['engine'] == engine)['startupMs'][0] for sample in extra)
            summary['firstNavigationMs'] = statistics.mean(first)
            summary['firstNavigationMedianMs'] = statistics.median(first)
        paired_first = [after_ms - before_ms for before_ms, after_ms in zip(before['firstNavigationSamplesMs'], after['firstNavigationSamplesMs'], strict=True)]
        regressions = [key for key in ['firstNavigationMs', 'repeatNavigationMedianMs', 'editP95Ms']
                       if after[key] > before[key]]
        if statistics.median(paired_first) > 0 and 'firstNavigationMs' not in regressions:
            regressions.append('firstNavigationMs')
        if after['saveP95Ms'] > before['saveP95Ms'] * 1.2:
            regressions.append('saveP95Ms')
        results.append({'engine': engine, 'baseline': before, 'candidate': after, 'regressions': regressions,
                        'pairedFirstNavigationDeltasMs': paired_first, 'pairedFirstNavigationMedianDeltaMs': statistics.median(paired_first)})
    report = {'results': results, 'passed': all(not row['regressions'] for row in results),
              'replicates': args.replicates, 'series': args.series,
              'coldReplicates': args.cold_replicates, 'coldSeries': args.cold_series,
              'baselineStartedAt': [row['startedAt'] for row in baseline], 'candidateStartedAt': [row['startedAt'] for row in candidate],
              'candidateSources': candidate[0]['sources'],
              'note': 'All rounds are retained and included. First navigation requires both the overall mean and the median paired change to show no increase; marginal medians remain visible. Repeated navigation uses all warm samples; edit/save p95 uses all samples. No additional timing tolerance is introduced; save p95 remains within 20%. Browser/host caching is reported without claiming network cold-cache control.'}
    (root / 'performance-comparison.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    assert report['passed'], 'Measured regression; investigate or repeat matched samples to establish whether it persists'
