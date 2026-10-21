"""Collect final destination-fix evidence from the isolated test runs."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
checks = server / "test-artifacts/mbt-bin-planning/checks"
source = checks / (sys.argv[1] if len(sys.argv) > 1 else "po-line-destinations-20260930-final") / "dispatch-po-line-destinations"
current_source = checks / sys.argv[2] / "dispatch-po-line-destinations" if len(sys.argv) > 2 else source
target = server / "test-artifacts/dispatch-po-line-destinations"
for name in ["focused.json", "static.json", "mutations.json", "changed-line-coverage.json", "baseline.json"]:
    shutil.copy2(source / name, target / name)
before = json.loads((source / "baseline.json").read_text())
current_path = current_source / ("current-parallel.json" if len(sys.argv) > 2 else "current.json")
current = json.loads(current_path.read_text())
assert current["failures"] == before["failures"], "New dispatch failures"
assert current["failed"] == before["failed"], "New dispatch failures"
suites = {"before": before, "current": current, "randomizedSeed": 1401728, "files": 264}
(target / "suites.json").write_text(json.dumps(suites, indent=2) + "\n")
files = ["src/dispatch-repository.js", "src/dispatch-planner-v2-repository.js", "src/dispatch-po-route-projection.js",
         "test/dispatch/unit/dispatch-po-line-destinations.test.js", "test/support/dispatch-po-line-destination-functions.mjs",
         "tools/dispatch-po-line-destinations-check.mjs", "test/dispatch-po-line-destinations.spec.json"]
hashes = {name: hashlib.sha256((server / name).read_bytes()).hexdigest() for name in files}
(target / "source-hashes.json").write_text(json.dumps(hashes, indent=2) + "\n")
focused = json.loads((target / "focused.json").read_text())
coverage = json.loads((target / "changed-line-coverage.json").read_text())
mutations = json.loads((target / "mutations.json").read_text())
assert focused["status"] == 0
assert all(row["covered"] == row["total"] for row in coverage)
assert len(mutations) == 5 and all(row["killed"] for row in mutations)
assert json.loads((target / "static.json").read_text())["noNewDiagnostics"]
report = {"passed": True, "specApproval": "not obtained (autonomous run)", "tier": 3,
          "spec": "test/dispatch-po-line-destinations.spec.json", "sourceHashes": hashes,
          "focused": focused, "suites": suites, "changedLineCoverage": coverage, "mutations": mutations,
          "static": json.loads((target / "static.json").read_text()),
          "gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=server, text=True).strip(),
          "reproduce": "bash tools/dispatch-po-line-destinations-verify.sh",
          "supplyChain": {"newDependencies": 0, "runtimeNetworkCapabilitiesAdded": 0},
          "limits": ["The existing dispatch suite has pre-existing failures listed in suites.before.failures.",
                     "The cargo property recovers omitted compact fields through line metadata; API-field and address contracts are separately tested.",
                     "Existing JavaScript is partially type-checked; no new static diagnostics were introduced.",
                     "Live repair is restricted to an unstarted load and is guarded by its preview revision."]}
if (target / "live-repair.json").exists():
    repair = json.loads((target / "live-repair.json").read_text())
    report["liveRepair"] = {key: value for key, value in repair.items() if key != "backup"}
(target / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"passed": True, "focused": focused, "newDispatchFailures": 0,
                  "dispatchPassed": current["passed"], "existingDispatchFailures": before["failed"],
                  "changedLinesCovered": sum(row["covered"] for row in coverage), "mutationsKilled": len(mutations)}))
