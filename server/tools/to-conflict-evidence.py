"""Collect the TO conflict cleanup's recorded checks without touching a database."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "server/test-artifacts/to-conflict-cleanup-20260915"
PREVIOUS = ROOT / "server/test-artifacts/to-cleanup-20260915"


def read_json(path):
    return json.loads(path.read_text())


def regression(name, filename, expected_files, baseline):
    source = (ARTIFACT / filename).read_text()
    assert re.search(rf"run (?:passed: {expected_files} file|failed in \d+/{expected_files} file)", source), name
    failures = sorted(set(re.findall(r"^✖ (.+) \([\d.]+(?:ms|s)\)$", source, re.MULTILINE)))
    added = sorted(set(failures) - set(baseline))
    assert not added, (name, added)
    return {"files": expected_files, "baselineFailures": baseline, "currentFailures": failures,
            "newFailures": added, "passedTests": sum(map(int, re.findall(r"^ℹ pass (\d+)$", source, re.MULTILINE))),
            "failedTests": sum(map(int, re.findall(r"^ℹ fail (\d+)$", source, re.MULTILINE)))}


def source_state(manifest):
    runtime = ROOT / "docker/backups/to-conflict-cleanup-20260915/runtime"
    checked = {}
    for name, expected in manifest["sourceHashes"].items():
        path = runtime / name[3:] if name.startswith("../src/") else ROOT / "server/tools" / name
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        assert actual == expected, f"Source changed: {name}"
        checked[name] = actual
    files = sorted((ROOT / "server/tools").glob("to-conflict-*"))
    files += [ROOT / "server/test/dispatch" / group / "to-conflict-cleanup.test.js" for group in ["unit", "integration"]]
    files += [ROOT / "server/test/to-conflict-cleanup-spec.md"]
    return {"manifestSources": checked, "files": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files if path.is_file()}}


def collect():
    previous = read_json(PREVIOUS / "evidence.json")
    report = {name: regression(name, filename, count, previous[name]["currentFailures"])
              for name, filename, count in [("mbt", "mbt-final.log", 480), ("dispatch", "dispatch-final-2.log", 136)]}
    diagnostics = lambda path: sorted(line for line in path.read_text().splitlines() if re.search(r": error TS\d+: ", line))
    before = diagnostics(PREVIOUS / "final/types-current.log")
    after = diagnostics(ARTIFACT / "types-final.log")
    assert before and after, "Missing type-check results"
    added = sorted(set(after) - set(before))
    assert not added, added
    report["types"] = {"baseline": len(before), "current": len(after), "newDiagnostics": added}
    report["gauntlet"] = read_json(ARTIFACT / "final/results.json")
    assert len(report["gauntlet"]) == 5 and all(row["exitCode"] == 0 for row in report["gauntlet"])
    report["coverage"] = read_json(ARTIFACT / "final/c8/coverage-summary.json")
    assert report["coverage"]["total"]["lines"]["pct"] == 100
    report["mutations"] = read_json(ARTIFACT / "mutations.json")
    assert len(report["mutations"]) == 10 and all(row["killed"] for row in report["mutations"])
    assert not read_json(ARTIFACT / "lint.json")
    report["secretsAndToolchain"] = (ARTIFACT / "secrets-toolchain.log").read_text().strip()
    assert "Secret scan passed:" in report["secretsAndToolchain"]
    report["dryRun"] = read_json(ARTIFACT / "production/summary.json")
    report["rehearsal"] = read_json(ARTIFACT / "rehearsal.json")
    assert report["dryRun"]["sha256"] == report["rehearsal"]["manifestSha256"]
    assert report["rehearsal"]["changedOrders"] == 26
    assert report["rehearsal"]["localReplanningBlocked"] == 19
    assert report["rehearsal"]["netSuitePlanningAllowed"] == 7
    report["sourceState"] = source_state(read_json(ARTIFACT / "production/manifest.json"))
    for name in ["apply-result", "verification", "runtime-verification"]:
        path = ARTIFACT / "production" / f"{name}.json"
        if path.exists():
            report[name] = read_json(path)
    if "apply-result" in report:
        assert report["apply-result"]["manifestSha256"] == report["dryRun"]["sha256"]
        assert report["apply-result"]["changedOrders"] == 26
    if "verification" in report:
        assert report["verification"]["changedOrders"] == 0
    today_path = ARTIFACT / "production/today-read.json"
    transfers_path = ARTIFACT / "production/today-transfers.json"
    if today_path.exists() and transfers_path.exists():
        today = read_json(today_path)
        transfers = read_json(transfers_path)
        assert all(not row.get("error") for group in ["routes", "operator", "search"] for row in today[group])
        assert all(row.get("found") and row.get("warningCount") == 0 for row in today["operator"])
        assert all(isinstance(rows, list) for rows in today["feeds"].values())
        assert not transfers["blockers"]
        assert all(row["warnings"] == 0 for row in transfers["orders"])
        report["today"] = {"date": today["date"], "plans": today["plans"], "loads": len(today["loads"]),
                           "driverRoutes": len(today["routes"]), "driverJobs": sum(len(row["jobs"]) for row in today["routes"]),
                           "salesOrders": len(today["operator"]), "transferOrders": transfers["orders"], "blockers": []}
    (ARTIFACT / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"mbtNewFailures": report["mbt"]["newFailures"], "dispatchNewFailures": report["dispatch"]["newFailures"],
                      "newTypeDiagnostics": added, "coveredLines": report["coverage"]["total"]["lines"],
                      "rehearsalOrders": report["rehearsal"]["changedOrders"], "manifestSha256": report["dryRun"]["sha256"]}))


if __name__ == "__main__":
    collect()
