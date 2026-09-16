"""Validate completed regression evidence against the actual source hashes."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
folder = root / "test-artifacts/sn1400625-receiving"


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
assert final["totals"]["tests"] == baseline["totals"]["tests"] + 6, "New regressions not executed"
checks = json.loads((folder / "summary.json").read_text())
for file, digest in checks["files"].items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == digest, f"Stale evidence: {file}"
focused_output = (folder / "focused.log").read_text()
focused = {key: int(re.findall(rf"^# {key} (\d+)$", focused_output, re.M)[-1])
           for key in ["tests", "pass", "fail", "skipped"]}
assert focused["fail"] == 0 and focused["skipped"] == 0
assert len(checks["mutations"]) == 8 and all(row["killed"] for row in checks["mutations"])
live = json.loads((folder / "live-replay.json").read_text()) if (folder / "live-replay.json").exists() else None
if live:
    assert live["candidateSha256"] == checks["sourceSha256"], "Stale live replay"
    assert live["selected"] == [{"orderLine": 1, "quantity": 360, "location": 1},
                                {"orderLine": 24, "quantity": 360, "location": 1},
                                {"orderLine": 25, "quantity": 288, "location": 1}]
result = {"baseline": baseline, "final": final, "focused": focused, "newFailures": 0,
          "staticAndMutation": checks, "liveReplay": live,
          "tools": {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in [
              "tools/sn1400625-receiving-results.py", "tools/sn1400625-receiving-gauntlet.sh",
              "tools/sn1400625-receiving-live.py", "package.json"]}}
(folder / "verified-results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: result[key] for key in ["baseline", "final", "focused", "newFailures"]}, indent=2))
