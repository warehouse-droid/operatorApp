"""Validate and summarize the final, reproducible regression artifacts."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

server = Path(__file__).resolve().parents[1]
artifact = server / "test-artifacts/operator-direct-orderline"


def read(name):
    return json.loads((artifact / name).read_text())


def full(name):
    log = (artifact / name).read_text()
    files = re.findall(r"Isolated MBT main run failed in (\d+)/(\d+) file", log)
    assert len(files) == 1 and files[0][0] == "1", "Incomplete or unexpectedly failed full run"
    failures = re.findall(r"^✖ (.+?) \([0-9.]+ms\)$", log, re.M)
    assert failures == ["P3.12: browser specs share one worker-owned database-pool lifecycle"] * 2
    return {"files": int(files[0][1]), "tests": sum(map(int, re.findall(r"^ℹ tests (\d+)$", log, re.M))),
            "pass": sum(map(int, re.findall(r"^ℹ pass (\d+)$", log, re.M))),
            "fail": sum(map(int, re.findall(r"^ℹ fail (\d+)$", log, re.M))), "knownFailure": failures[0]}


checks, static, browser = [read(name) for name in ["checks.json", "static.json", "browser.json"]]
for report in [checks, static]:
    for file, digest in report["sources"].items():
        assert hashlib.sha256((server / file).read_bytes()).hexdigest() == digest, f"Changed after tests: {file}"
for row in read("full-source-state.json"):
    if row["file"].startswith(("src/", "public/", "test/")):
        assert hashlib.sha256((server / row["file"]).read_bytes()).hexdigest() == row["afterSha256"], row["file"]
assert checks["mutationKills"] == checks["propertyMutationKills"] == 7
assert checks["changedLineCoverage"] == 1
assert static["newTypeErrors"] == static["newLint"] == 0
assert browser["changedCoverage"]["missing"] == []
focused = (artifact / "focused-final.log").read_text()
assert "# fail 0\n" in focused
subprocess.run(["git", "diff", "--check"], cwd=server, check=True)
summary = {"source": read("source-state.json"), "baseline": full("baseline-full.log"), "final": full("full-final.log"),
           "focusedTests": int(re.search(r"^# tests (\d+)$", focused, re.M)[1]),
           "changedBackendLines": sum(row["lines"] for row in checks["changed"]),
           "changedBackendLineCoverage": checks["changedLineCoverage"], "browser": browser,
           "static": {key: value for key, value in static.items() if key != "sources"},
           "mutationKills": 7, "independentPropertyMutationKills": 7, "domainBranches": checks["domainBranches"],
           "node": checks["node"], "shuffleSeed": checks["shuffleSeed"]}
(artifact / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary))
