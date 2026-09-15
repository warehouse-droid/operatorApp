from collections import Counter
from pathlib import Path
import difflib
import json
import re


root = Path(__file__).resolve().parents[1]
artifacts = root / "test-artifacts/activity-allocation-scope"
final = artifacts / "final"


def diagnostics(name):
    return Counter(re.sub(r"\(\d+,\d+\)", "(line)", line)
                   for line in (final / name).read_text().splitlines()
                   if ": error TS" in line)


assert not diagnostics("types.log") - diagnostics("types-baseline.log"), "New type diagnostics"
lint = (final / "lint.log").read_text()
assert not re.search(r"\d+:\d+\s+(error|warning)", lint), lint


def suite(name):
    source = (final / name).read_text()
    match = re.search(r"Isolated MBT main run failed in (\d+)/(\d+) file\(s\): (.+)", source)
    counts = {key: sum(map(int, re.findall(rf"^(?:#|ℹ) {key} (\d+)$", source, re.M)))
              for key in ("tests", "pass", "fail", "skipped")}
    assert counts["tests"] > 2000, "Full MBT run did not complete"
    return counts, set(match.group(3).split(", ")) if match else set()


baseline_counts, baseline_failures = suite("mbt-baseline.log")
counts, failures = suite("mbt.log")
assert not failures - baseline_failures, f"New failing test files: {failures - baseline_failures}"
assert counts["fail"] <= baseline_counts["fail"], "New failing tests"
legacy = (final / "legacy.log").read_text()
legacy_match = re.search(r"Legacy full baseline passed: (\d+) harnesses", legacy)
assert legacy_match, legacy[-3000:]
assert "Legacy full baseline passed:" in (final / "legacy-baseline.log").read_text()

before = (artifacts / "baseline/dispatch-load-assignment.js").read_text().splitlines()
after = (root / "src/dispatch-load-assignment.js").read_text().splitlines()
changed = {line + 1 for op, _, __, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes()
           if op != "equal" for line in range(start, end)}
coverage = json.loads((final / "coverage/coverage-final.json").read_text())
data = next(value for path, value in coverage.items() if path.endswith("/src/dispatch-load-assignment.js"))
executable = {}
for key, location in data["statementMap"].items():
    for line in range(location["start"]["line"], location["end"]["line"] + 1):
        if line in changed and after[line - 1].strip() and not after[line - 1].lstrip().startswith("//"):
            executable[line] = max(executable.get(line, 0), data["s"][key])
missing = [line for line, hits in executable.items() if not hits]
assert executable and not missing, f"Uncovered changed executable lines: {missing}"

mutation = [json.loads(line) for line in (final / "mutation.log").read_text().splitlines()]
assert mutation[-1] == {"restored": True, "mutantsKilled": 5, "propertiesKilled": 5}
live = json.loads((final / "live.log").read_text())
assert live["allowed"] and live["realCargoEditRejected"] and live["productionTransactionReadOnly"]
policy_text = (final / "dispatch-policy.log").read_text()
policy_baseline = (final / "dispatch-policy-baseline.log").read_text()
policy_failures = set(re.findall(r"^not ok \d+ - (.+)$", policy_text, re.M))
assert policy_failures == set(re.findall(r"^not ok \d+ - (.+)$", policy_baseline, re.M))
policy_counts = {key: int(re.search(rf"^# {key} (\d+)$", policy_text, re.M).group(1))
                 for key in ("tests", "pass", "fail")}
summary = {"mbt": counts, "baselineMbt": baseline_counts, "preexistingFailedFiles": sorted(failures),
           "legacyHarnesses": int(legacy_match.group(1)), "changedExecutableLinesCovered": len(executable),
           "changedExecutableLines": sorted(executable), "typeDiagnostics": sum(diagnostics("types.log").values()),
           "newTypeDiagnostics": 0, "lintErrors": 0, "mutation": mutation[-1], "live": live,
           "dispatchPolicies": policy_counts, "preexistingPolicyFailures": sorted(policy_failures)}
(final / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
