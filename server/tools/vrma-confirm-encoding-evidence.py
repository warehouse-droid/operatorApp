"""Collect evidence for the two-file Operator URL identifier fix."""
import difflib
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "server/test-artifacts/vrma-confirm-encoding-20260915"
BACKUP = ROOT / "docker/backups/vrma-confirm-encoding-20260915"
FILES = ["src/operator-yard-authorization.js", "src/operator-yard-route.js"]


def read_json(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def coverage():
    report = read_json(ARTIFACT / "c8/coverage-final.json")
    rows = []
    for file in FILES:
        before_path = BACKUP / "baseline" / file
        before = before_path.read_text().splitlines() if before_path.exists() else []
        after = (BACKUP / "release-final" / file).read_text().splitlines()
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
    prior = ROOT / "server/test-artifacts/to-conflict-cleanup-20260915"
    baseline = read_json(prior / "evidence.json")["mbt"]["currentFailures"]
    source = (ARTIFACT / "full-mbt-final.log").read_text()
    assert re.search(r"run (?:passed: 482 file|failed in \d+/482 file)", source), "Full suite is incomplete"
    failures = sorted(set(re.findall(r"^✖ (.+) \([\d.]+(?:ms|s)\)$", source, re.MULTILINE)))
    added = sorted(set(failures) - set(baseline))
    assert not added, added
    diagnostics = lambda path: sorted(row for row in path.read_text().splitlines() if re.search(r": error TS\d+: ", row))
    types_before = diagnostics(prior / "types-final.log")
    types_after = diagnostics(ARTIFACT / "types-final.log")
    assert types_before and types_after
    new_types = sorted(set(types_after) - set(types_before))
    assert not new_types, new_types
    static = read_json(ARTIFACT / "static.json")
    assert not static["findings"]
    for file in FILES:
        assert sha(BACKUP / "release-final" / file) == static["hashes"][file] == sha(ROOT / "server" / file), file
    gauntlet = read_json(ARTIFACT / "gauntlet.json")
    assert len(gauntlet) == 6 and all(row["exitCode"] == 0 for row in gauntlet)
    mutants = read_json(ARTIFACT / "mutations.json")
    assert len(mutants) == 10 and all(row["killed"] for row in mutants)
    report = {"specApproval": "not obtained (autonomous run)", "sourceHashes": static["hashes"],
              "fullSuite": {"files": 482, "baselineFailures": baseline, "currentFailures": failures, "newFailures": added,
                            "passedTests": sum(map(int, re.findall(r"^ℹ pass (\d+)$", source, re.MULTILINE))),
                            "failedTests": sum(map(int, re.findall(r"^ℹ fail (\d+)$", source, re.MULTILINE)))},
              "types": {"baseline": len(types_before), "current": len(types_after), "newDiagnostics": new_types},
              "gauntlet": gauntlet, "mutations": mutants, "changedCoverage": coverage(),
              "coverageSummary": read_json(ARTIFACT / "c8/coverage-summary.json")}
    for name in ["live-before", "live-after"]:
        path = ARTIFACT / f"{name}.json"
        if path.exists():
            report[name] = {key: value for key, value in read_json(path).items() if key != "beforeState"}
    (ARTIFACT / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"newFailures": added, "newTypeDiagnostics": new_types,
                      "changedLinesCovered": report["changedCoverage"]["covered"], "sourceHashes": report["sourceHashes"]}))


if __name__ == "__main__":
    collect()
