"""Compare regression results and capture the exact tested TO source hashes."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "server/test-artifacts/to-cleanup-20260915"
BACKUP = ROOT / "docker/backups/to-cleanup-20260915"

def failures(path):
    text = path.read_text()
    assert "run failed in" in text or "run passed:" in text, f"Suite has not finished: {path}"
    names = set()
    for match in re.finditer(r"^(?:✖ |not ok \d+ - )(.+)$", text, re.M):
        value = re.sub(r" \([\d.]+m?s\)$", "", match[1])
        if value != "failing tests:":
            names.add(value)
    return sorted(names)

report = {}
for scope, current in [("mbt", "final-mbt"), ("dispatch", "current-dispatch")]:
    before = failures(ARTIFACT / f"baseline-{scope}.log")
    after = failures(ARTIFACT / f"{current}.log")
    added = sorted(set(after) - set(before))
    assert not added, f"New {scope} failures: {added}"
    report[scope] = {"baselineFailures": before, "currentFailures": after, "newFailures": added}
results = json.loads((ARTIFACT / "final/results.json").read_text())
assert all(result["exitCode"] == 0 for result in results)
report["gauntlet"] = results
assert "# pass 2" in (ARTIFACT / "browser-final.log").read_text()
assert "# fail 0" in (ARTIFACT / "browser-final.log").read_text()
report["browserTests"] = 2
deployment = json.loads((BACKUP / "deployment-manifest.json").read_text())
report["hashes"] = {name: hashlib.sha256((BACKUP / "release" / name).read_bytes()).hexdigest() for name in deployment["after"]}
assert report["hashes"] == deployment["after"]
report["manifestSha256"] = json.loads((ARTIFACT / "production/summary.json").read_text())["sha256"]
assert json.loads((ARTIFACT / "rehearsal.json").read_text())["manifestSha256"] == report["manifestSha256"]
(ARTIFACT / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"newMbtFailures": 0, "newDispatchFailures": 0, "browserTests": 2,
                  "baselineMbtFailures": len(report["mbt"]["baselineFailures"]),
                  "baselineDispatchFailures": len(report["dispatch"]["baselineFailures"]),
                  "manifestSha256": report["manifestSha256"], "runtimeFiles": len(report["hashes"])}))
