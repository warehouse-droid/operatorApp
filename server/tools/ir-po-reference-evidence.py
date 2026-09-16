"""Validate fresh IR regression evidence and identify the exact verified source."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
folder = root / "test-artifacts/ir-po-reference"


def totals(name):
    output = (folder / name).read_text()
    result = {key: sum(map(int, re.findall(rf"^(?:ℹ|#) {key} (\d+)$", output, re.M)))
              for key in ["tests", "pass", "fail", "cancelled", "skipped"]}
    assert result["tests"] > 0 and result["cancelled"] == 0, name
    return result


def full(name):
    output = (folder / name).read_text()
    progress = re.findall(r"\[isolation\] MBT main (\d+)/(\d+) ", output)
    assert progress and progress[-1][0] == progress[-1][1], f"Incomplete suite: {name}"
    assert "Isolated MBT main run failed in 1/" in output
    failed = sorted(set(re.findall(r"^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$", output, re.M)) - {"failing tests:"})
    return {"totals": totals(name), "files": int(progress[-1][1]), "failures": failed}


baseline, final = full("baseline-full.log"), full("full-final.log")
assert baseline["failures"] == final["failures"]
assert baseline["totals"]["fail"] == final["totals"]["fail"] == 1
assert final["failures"] == ["P3.12: browser specs share one worker-owned database-pool lifecycle"]
assert final["totals"]["tests"] == baseline["totals"]["tests"] + 5
assert final["files"] == baseline["files"] + 2
assert totals("red-reproduced.log")["fail"] == 5
focused = totals("focused-final.log")
assert focused["fail"] == 0
summary = json.loads((folder / "summary.json").read_text())
for file, digest in summary["sources"].items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, f"Stale evidence: {file}"
coverage = json.loads((folder / "coverage/coverage-final.json").read_text())
changes = json.loads((root / "test/ir-po-reference-changes.json").read_text())
branches = []
for change in changes:
    report = next(value for key, value in coverage.items() if key.endswith("/" + change["file"]))
    for key, branch in report["branchMap"].items():
        if branch.get("line") in change["changedLines"]:
            branches.append({"line": branch["line"], "counts": report["b"][key]})
assert all(count > 0 for branch in branches for count in branch["counts"])
result = {"baseline": baseline, "full": final, "focused": focused, "newFailures": 0,
          "changedBranches": branches, "staticAndMutation": summary,
          "sourceState": hashlib.sha256(json.dumps([(row["file"], row["afterSha256"]) for row in changes]).encode()).hexdigest()}
(folder / "verified-results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key != "staticAndMutation"}, indent=2))
