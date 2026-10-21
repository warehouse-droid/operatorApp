"""Compare recorded baseline failures without hiding failures added by this task."""
import collections
import json
import re
import sys
from pathlib import Path

artifacts = Path(sys.argv[1])

def regression(phase):
    content = (artifacts / f"{phase}-regression.log").read_text()
    failed = re.findall(r"Isolated MBT main run failed in (\d+)/(\d+) file\(s\): (.*)", content)
    passed = re.findall(r"Isolated MBT main run passed: (\d+) file\(s\), (\d+) test\(s\)", content)
    if failed:
        count, total, names = failed[-1]
        files = set(names.split(", "))
        assert len(files) == int(count), "Incomplete failed-file summary"
        return files, int(total)
    assert passed, f"{phase} test run did not complete"
    return set(), int(passed[-1][0])

def types(phase):
    content = (artifacts / f"{phase}-types.log").read_text()
    assert "tsc --project" in content, f"{phase} typecheck did not execute"
    return collections.Counter(re.findall(r"^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$", content, re.M))

def lint(phase):
    content = (artifacts / f"{phase}-lint.log").read_text()
    assert "eslint --config" in content, f"{phase} linter did not execute"
    results = collections.Counter()
    file = None
    for line in content.splitlines():
        if line.startswith('/app/'):
            file = line.strip()
        match = re.match(r"\s+\d+:\d+\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$", line)
        if match:
            results[(file, match[1], match[2], match[3])] += 1
    return results

baseline_files, baseline_total = regression('baseline')
final_files, final_total = regression('final')
new_types = types('final') - types('baseline')
new_lint = lint('final') - lint('baseline')
report = {
    'baselineFiles': baseline_total, 'finalFiles': final_total,
    'baselineFailingFiles': sorted(baseline_files), 'finalFailingFiles': sorted(final_files),
    'newFailingFiles': sorted(final_files - baseline_files),
    'baselineTypeErrors': sum(types('baseline').values()), 'finalTypeErrors': sum(types('final').values()),
    'newTypeErrors': [dict(location=key[0],code=key[1],message=key[2],count=value) for key,value in new_types.items()],
    'baselineLintErrors': sum(lint('baseline').values()), 'finalLintErrors': sum(lint('final').values()),
    'newLintErrors': [dict(location=key[0],severity=key[1],message=key[2],rule=key[3],count=value) for key,value in new_lint.items()]
}
(artifacts / 'regression-comparison.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({key:value for key,value in report.items() if key not in ['baselineFailingFiles','finalFailingFiles']},indent=2))
if report['newFailingFiles'] or new_types or new_lint:
    sys.exit(1)
