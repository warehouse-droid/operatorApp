"""Collect evidence for the delivery packing conversion rounding fix."""
import difflib
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "server/test-artifacts/group-underpack-20260915"
BACKUP = ROOT / "docker/backups/group-underpack-20260915"
FILES = ["src/delivery-repository.js", "src/delivery-packing-progress.js", "public/operator.js", "public/operator.html", "public/service-worker.js"]


def read_json(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resolved_cache_contracts(failures):
    names = ["operations-navigation-enhancements.test.js", "operator-customer-pickup-photo-gate-ui.contract.test.js", "operator-page-confirm-ui.contract.test.js"]
    log = (ARTIFACT / "cache-contracts.log").read_text()
    assert re.search(r"^ℹ fail 0$", log, re.MULTILINE), "Cache contract rerun did not pass"
    passed = set(re.findall(r"^✔ (.+) \([\d.]+(?:ms|s)\)$", log, re.MULTILINE))
    for name in names:
        before = (ARTIFACT / "cache-contract-baseline" / name).read_text()
        expected = before.replace("20260915-operator-receiving-v1", "20260915-packing-rounding-v1").replace("mbbs-yard-operator-v148-receiving-v1", "mbbs-yard-operator-v149-packing-rounding-v1")
        for root in [BACKUP / "release", ROOT / "server"]:
            assert (root / "test/mbt/unit" / name).read_text() == expected, "Only exact version expectations may change"
    resolved = sorted(set(failures) & passed)
    return {"resolvedFailures": resolved, "passedTests": len(passed), "runtimeUnchanged": True}


def coverage():
    report = read_json(ARTIFACT / "c8/coverage-final.json")
    rows = []
    for file in [file for file in FILES if not file.endswith(".html")]:
        before_path = BACKUP / "baseline" / file
        before = before_path.read_text().splitlines() if before_path.exists() else []
        after = (BACKUP / "release" / file).read_text().splitlines()
        changed = [line + 1 for tag, _, _, start, end in difflib.SequenceMatcher(None, before, after).get_opcodes()
                   if tag in ["insert", "replace"] for line in range(start, end)]
        data = report[f"/app/{file}"]
        for line in changed:
            if not after[line - 1].strip() or after[line - 1].lstrip().startswith(("//", "/**", "*")):
                continue
            count = max([0] + [data["s"][key] for key, span in data["statementMap"].items()
                               if span["start"]["line"] <= line <= span["end"]["line"]])
            rows.append({"file": file, "line": line, "count": count})
    assert rows and all(row["count"] > 0 for row in rows), rows
    result = {"covered": len(rows), "total": len(rows), "rows": rows}
    (ARTIFACT / "changed-coverage.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def collect():
    prior = ROOT / "server/test-artifacts/vrma-confirm-encoding-20260915"
    baseline = read_json(prior / "evidence.json")["fullSuite"]["currentFailures"]
    source = (ARTIFACT / "full-mbt.log").read_text()
    assert re.search(r"run (?:passed: 484 file|failed in \d+/484 file)", source), "Full suite is incomplete"
    failures = sorted(set(re.findall(r"^✖ (.+) \([\d.]+(?:ms|s)\)$", source, re.MULTILINE)))
    cache_contracts = resolved_cache_contracts(failures)
    unresolved = sorted(set(failures) - set(cache_contracts["resolvedFailures"]))
    added = sorted(set(unresolved) - set(baseline))
    assert not added, added
    diagnostics = lambda path: sorted(row for row in path.read_text().splitlines() if re.search(r": error TS\d+: ", row))
    types_before = diagnostics(prior / "types-final.log")
    types_after = diagnostics(ARTIFACT / "types.log")
    assert types_before and types_after
    new_types = sorted(set(types_after) - set(types_before))
    assert not new_types, new_types
    static = read_json(ARTIFACT / "static.json")
    assert not static["newFindings"]
    for file in FILES:
        assert sha(BACKUP / "release" / file) == static["hashes"][file] == sha(ROOT / "server" / file), file
    gauntlet = read_json(ARTIFACT / "gauntlet.json")
    assert len(gauntlet) == 6 and all(row["exitCode"] == 0 for row in gauntlet)
    mutants = read_json(ARTIFACT / "mutations.json")
    assert len(mutants) == 18 and all(row["killed"] for row in mutants)
    report = {"specApproval": "not obtained (autonomous run)", "sourceHashes": static["hashes"],
              "fullSuite": {"files": 484, "baselineFailures": baseline, "rawFullRunFailures": failures, "currentFailures": unresolved, "newFailures": added,
                            "cacheContractRerun": cache_contracts,
                            "passedTests": sum(map(int, re.findall(r"^ℹ pass (\d+)$", source, re.MULTILINE))),
                            "failedTests": sum(map(int, re.findall(r"^ℹ fail (\d+)$", source, re.MULTILINE)))},
              "types": {"baseline": len(types_before), "current": len(types_after), "newDiagnostics": new_types},
              "gauntlet": gauntlet, "mutations": mutants, "changedCoverage": coverage(),
              "coverageSummary": read_json(ARTIFACT / "c8/coverage-summary.json"),
              "replay": read_json(ARTIFACT / "replay-result.json"), "browser": read_json(ARTIFACT / "browser/result.json"),
              "static": static}
    assert report["replay"]["orders"] >= 1000 and report["replay"]["failures"] == 0
    assert report["browser"]["browserErrors"] == []
    assert report["browser"]["replayedProductionLines"] == 5 and report["browser"]["boundary"] == [2, 1]
    for name in ["live-before", "live-after"]:
        path = ARTIFACT / f"{name}.json"
        if path.exists():
            report[name] = {key: value for key, value in read_json(path).items() if key not in ["headers", "rawLines", "details", "lists"]}
    (ARTIFACT / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"newFailures": added, "newTypeDiagnostics": new_types,
                      "changedLinesCovered": report["changedCoverage"]["covered"], "sourceHashes": report["sourceHashes"]}))


if __name__ == "__main__":
    collect()
