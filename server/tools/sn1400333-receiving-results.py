"""Validate completed full-suite logs and print reproducible receipt evidence."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
folder = root / "test-artifacts/sn1400333-receiving"


def full_result(name):
    output = (folder / f"{name}.log").read_text()
    progress = re.findall(r"\[isolation\] MBT main (\d+)/(\d+) ", output)
    assert progress and progress[-1][0] == progress[-1][1], f"{name} incomplete"
    assert re.search(r"Isolated MBT main run (?:failed|passed|completed)", output), f"{name} unfinished"
    failures = sorted(set(re.findall(r"^✖ (.+?) \([\d.]+ms\)$", output, re.M)))
    totals = {key: sum(map(int, re.findall(rf"^ℹ {key} (\d+)$", output, re.M)))
              for key in ["tests", "pass", "fail", "cancelled", "skipped"]}
    assert totals["cancelled"] == 0 and totals["tests"] > 2000, f"{name} invalid"
    return {"files": int(progress[-1][1]), "totals": totals, "failures": failures}


baseline = full_result("baseline-full")
final = full_result("full")
assert final["failures"] == baseline["failures"], "New full-suite failure"
assert final["totals"]["fail"] == baseline["totals"]["fail"], "New failing test"
assert final["files"] == baseline["files"] + 1, "Unexpected test discovery change"
assert final["totals"]["tests"] == baseline["totals"]["tests"] + 9, "New regressions not executed"
focused = json.loads((folder / "summary.json").read_text())
for file, digest in focused["sources"].items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, f"Stale evidence: {file}"
focused_output = (folder / "focused.log").read_text()
focused_totals = {key: int(re.findall(rf"^# {key} (\d+)$", focused_output, re.M)[-1])
                  for key in ["tests", "pass", "fail", "skipped"]}
assert focused_totals["fail"] == 0
coverage = json.loads((folder / "coverage/coverage-final.json").read_text())
branches = []
for change in json.loads((root / "test/sn1400333-receiving-changes.json").read_text()):
    report = next(value for key, value in coverage.items() if key.endswith("/" + change["file"]))
    for key, branch in report["branchMap"].items():
        if branch.get("line") in change["changedLines"]:
            branches.append({"file": change["file"], "line": branch["line"], "counts": report["b"][key]})
assert all(count > 0 for branch in branches for count in branch["counts"]), "Uncovered changed branch"
result = {"baseline": baseline, "final": final, "focused": focused_totals,
          "newFailures": 0, "staticAndMutation": focused,
          "changedBranches": {"covered": sum(len(branch["counts"]) for branch in branches), "details": branches},
          "toolSources": {file: hashlib.sha256((root / file).read_bytes()).hexdigest()
                          for file in ["tools/sn1400333-receiving-results.py",
                                       "tools/sn1400333-receiving-gauntlet.sh",
                                       "tools/sn1400333-receiving-live.sh", "package.json"]}}
(folder / "verified-results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key != "staticAndMutation"}, indent=2))
