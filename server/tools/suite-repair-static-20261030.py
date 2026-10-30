"""Compare static diagnostics with HEAD without suppressing existing rules."""
from collections import Counter
import json
from pathlib import Path
import re
import subprocess
import tarfile


def baseline_source(checks, baseline_commit):
    root = checks.ARTIFACT / 'static-baseline'
    root.mkdir()
    tracked = set(checks.run('git', 'ls-tree', '-r', '--name-only', baseline_commit).decode().splitlines())
    paths = ['server/' + folder for folder in ['src', 'public', 'test', 'tools', 'contracts', 'migrations']]
    paths += [name for name in tracked if name.startswith('server/') and len(Path(name).parts) == 2
              and Path(name).suffix in ['.js', '.mjs', '.json']]
    child = subprocess.Popen(['git', 'archive', baseline_commit, *paths], cwd=checks.ROOT, stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=child.stdout, mode='r|') as archive:
            for member in archive:
                if not member.isfile():
                    continue
                assert '..' not in Path(member.name).parts and not member.name.startswith('/')
                target = root / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(0o644)
    finally:
        assert child.wait() == 0
    return root / 'server'


def diagnostics(kind, body):
    if kind == 'types':
        return [{'file': match[1], 'rule': match[4], 'message': match[5], 'line': int(match[2])}
                for line in body.splitlines()
                if (match := re.match(r'^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)', line))]
    start = body.find('[{"filePath":')
    assert start >= 0, 'ESLint did not produce its JSON diagnostic report'
    rows, _ = json.JSONDecoder().raw_decode(body[start:])
    return [{'file': row['filePath'].removeprefix('/app/'), 'rule': item.get('ruleId') or 'fatal',
             'message': item['message'], 'line': item.get('line', 0), **({'fix': item['fix']} if 'fix' in item else {})}
            for row in rows for item in row['messages']]


def fingerprint(row):
    message = re.sub(r'on line \d+ column \d+', 'at the enclosing declaration', row['message'])
    return row['file'], row['rule'], message


def compare(checks, candidate_command, runtime, changed, fix_new=False, baseline_commit='859dbc987d88fdd41b475f3738cefe9704aae3ea'):
    baseline = baseline_source(checks, baseline_commit)
    old_server = checks.SERVER
    try:
        checks.SERVER = baseline
        baseline_command = checks.config(baseline, 'static-baseline')
    finally:
        checks.SERVER = old_server
    report = {'baselineCommit': baseline_commit}
    for kind in ['types', 'lint']:
        results = {}
        for label, command, source in [('baseline', baseline_command, baseline), ('candidate', candidate_command, runtime)]:
            files = [name for name in changed if (source / name).is_file()]
            arguments = ['npm', 'run', 'typecheck:mbt'] if kind == 'types' else [
                'npx', '--no-install', 'eslint', '--config', 'eslint.mbt.config.js', '--format', 'json', '--max-warnings=0', *files]
            code, output = checks.logged(command + ['run', '--rm', '--no-deps', '-T', 'test', *arguments], kind + '-' + label, 600)
            found = diagnostics(kind, output)
            assert code in [0, 1, 2] and (found or code == 0), kind + ' checker failed without diagnostics'
            results[label] = {'exitCode': code, 'diagnostics': found}
        remaining = Counter(fingerprint(row) for row in results['baseline']['diagnostics'])
        new = []
        for row in results['candidate']['diagnostics']:
            key = fingerprint(row)
            if remaining[key]:
                remaining[key] -= 1
            else:
                new.append(row)
        report[kind] = {'baselineCount': len(results['baseline']['diagnostics']),
                        'candidateCount': len(results['candidate']['diagnostics']), 'newCount': len(new), 'newDiagnostics': new}
        if kind == 'lint' and fix_new:
            applied = []
            for name in sorted({row['file'] for row in new if row.get('fix')}):
                target = checks.ROOT / 'server' / name
                original = (runtime / name).read_text()
                assert target.read_text() == original, 'Source changed while lint was running: ' + name
                fixes, end = [], -1
                for row in sorted((r for r in new if r['file'] == name and r.get('fix')), key=lambda r: r['fix']['range'][0]):
                    start, stop = row['fix']['range']
                    if start >= end:
                        fixes.append(row['fix'])
                        end = stop
                updated = original
                for fix in reversed(fixes):
                    start, stop = fix['range']
                    updated = updated[:start] + fix['text'] + updated[stop:]
                target.write_text(updated)
                applied.append({'file': name, 'fixes': len(fixes)})
            report[kind]['appliedFixes'] = applied
        checks.emit({'stage': 'static-' + kind, **{k: v for k, v in report[kind].items() if k != 'newDiagnostics'}})
    report['passed'] = all(report[k]['newCount'] == 0 for k in ['types', 'lint'])
    return report
