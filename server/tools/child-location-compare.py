"""Compare exact failing test names; timing and line-number drift are immaterial."""
import collections
import json
from pathlib import Path
import re
import sys


def failures(path):
    text = Path(path).read_text()
    assert 'Isolated MBT main run ' in text, 'Incomplete full regression run: ' + str(path)
    current = ''
    result = set()
    for line in text.splitlines():
        if line.startswith('[isolation]'):
            current = line.split('/app/')[-1]
        if line.startswith('✖ ') and not line.startswith('✖ failing tests:'):
            result.add(current + ': ' + re.sub(r' \([\d.]+m?s\)$', '', line[2:]))
    return result


if __name__ == '__main__':
    before, after = failures(sys.argv[1]), failures(sys.argv[2])
    result = {'baselineFailures': sorted(before), 'currentFailures': sorted(after),
              'newFailures': sorted(after - before), 'resolvedFailures': sorted(before - after)}
    Path(sys.argv[3]).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'baseline': len(before), 'current': len(after), 'newFailures': result['newFailures']}))
    sys.exit(bool(result['newFailures']))
