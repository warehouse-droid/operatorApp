"""Reproduce the stored-return-ID verification using disposable test databases."""
from concurrent.futures import ThreadPoolExecutor
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
OUT = SERVER / "test-artifacts/return-stored-orderline"
BEFORE = OUT / "workspace-before"
FROZEN = OUT / "verification-final"
FILES = ["src/return-netsuite.js", "src/return-stored-orderline.js"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def phase(name, source, subnet, command):
    env = dict(os.environ, RETURN_STORED_SOURCE_ROOT=str(source), RETURN_STORED_TEST_SUBNET=subnet)
    with (OUT / (name + ".log")).open("wb") as log:
        result = subprocess.run(["bash", str(SERVER / "tools/return-stored-orderline-isolated.sh"), *command],
                                cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    print(json.dumps({"phase": name, "exit": result.returncode}), flush=True)
    return result.returncode


def full_results(name):
    text = (OUT / (name + ".log")).read_text()
    counts = {}
    for key in ["tests", "pass", "fail", "cancelled", "skipped"]:
        counts[key] = sum(map(int, re.findall(r"^\s*ℹ " + key + r" (\d+)\s*$", text, re.M)))
    failures = re.findall(r"^Isolated MBT main run failed in \d+/\d+ file\(s\): (.+)$", text, re.M)
    success = re.search(r"Isolated MBT main run passed: (\d+) file\(s\), (\d+) test\(s\)\.", text)
    assert len(failures) == 1 or success, "Full suite did not complete: " + name
    counts["failedFiles"] = sorted(failures[0].split(", ")) if failures else []
    counts["failedTests"] = {}
    for section in text.split("[isolation]")[1:]:
        filename = section.splitlines()[0].split()[-1]
        if filename in counts["failedFiles"]:
            counts["failedTests"][filename] = sorted(set(re.findall(r"^✖ (.+?)(?: \([\d.]+ms\))?$", section, re.M)) - {"failing tests:"})
    return counts


def changed_coverage():
    report = json.loads((OUT / "coverage/coverage-final.json").read_text())
    result = {}
    for file in FILES:
        old = (BEFORE / file).read_text().splitlines() if (BEFORE / file).exists() else []
        new = (FROZEN / file).read_text().splitlines()
        changed = set()
        for action, _, _, start, end in difflib.SequenceMatcher(a=old, b=new).get_opcodes():
            if action in {"replace", "insert"}:
                changed.update(range(start + 1, end + 1))
        coverage = report["/app/" + file]
        line_hits = {}
        for key, statement in coverage["statementMap"].items():
            for line in range(statement["start"]["line"], statement["end"]["line"] + 1):
                line_hits[line] = max(line_hits.get(line, 0), coverage["s"][key])
        executable = changed & line_hits.keys()
        missing = sorted(line for line in executable if not line_hits[line])
        result[file] = {"covered": len(executable) - len(missing), "executableChangedLines": len(executable), "missing": missing}
        assert not missing, (file, missing)
    return result


def frozen_source():
    if not FROZEN.exists():
        shutil.copytree(BEFORE, FROZEN)
        for file in FILES + ["test/mbt/unit/return-stored-orderline.test.js", "test/mbt/integration/return-stored-orderline.test.js",
                             "test/return-stored-orderline-spec.json"]:
            shutil.copy2(SERVER / file, FROZEN / file)
        for file in (SERVER / "tools").glob("return-stored-orderline-*"):
            if file.is_file():
                shutil.copy2(file, FROZEN / "tools" / file.name)
        (OUT / "frozen-source-manifest.json").write_text(json.dumps(frozen_hashes(), indent=2) + "\n")
    assert json.loads((OUT / "frozen-source-manifest.json").read_text()) == frozen_hashes(), "Frozen verification source changed."
    assert {file: digest(SERVER / file) for file in FILES} == {file: digest(FROZEN / file) for file in FILES}


def frozen_hashes():
    return {str(path.relative_to(FROZEN)): digest(path) for folder in ["src", "public", "migrations", "test", "tools", "contracts"]
            for path in (FROZEN / folder).rglob("*") if path.is_file()}


def collect():
    frozen_source()
    source = {file: digest(FROZEN / file) for file in FILES}
    baseline, final = full_results("full-baseline"), full_results("full-final")
    added = sorted(set(final["failedFiles"]) - set(baseline["failedFiles"]))
    assert not added, added
    for file, tests in final["failedTests"].items():
        assert set(tests) <= set(baseline["failedTests"].get(file, [])), (file, tests)
    checks = json.loads((OUT / "checks.json").read_text())
    assert checks["passed"] and checks["sourceHashes"] == source
    assert {file: digest(SERVER / file) for file in FILES} == source, "Source changed during verification."
    summary = json.loads((OUT / "coverage/coverage-summary.json").read_text())
    coverage = changed_coverage()
    data = {"passed": True, "specApproval": "not obtained (autonomous run)", "sourceHashes": source,
            "entryPoint": "python3 server/tools/return-stored-orderline-gauntlet.py", "fullBaseline": baseline,
            "fullFinal": final, "newFailures": added, "checks": checks, "changedLineCoverage": coverage,
            "mappingCoverage": summary["/app/src/return-stored-orderline.js"],
            "skipped": {"dependencyAudit": "No dependency changes.", "migrationRollback": "No migration or mapping-data changes.",
                        "productionRA": "Physical return confirmation and creation require the Operator's actual quantities and photos."},
            "notes": ["The initial baseline/final attempts lacked the already-installed browser mount and were stopped. The final fresh run supplies it.",
                      "Docker default address pools were full; this task uses explicit isolated internal test subnets.",
                      "Concurrency criterion was corrected to preserve the existing pending replay contract; remote string IDs are compared as numeric database IDs.",
                      "Unrelated dispatch and fulfillment files changed in the shared workspace during the initial final run. That contaminated result is retained separately and is excluded; final verification uses a frozen copy of the original code plus only the two return files and their tests.",
                      "The initial coverage command inadvertently applied global MBT thresholds to an existing 1,000-line caller. The final command checks every changed line and separately enforces 95% lines/statements/functions and 90% branches on the new mapper.",
                      "The pre-existing Aggregate browser test hung in both baseline and final. The final fresh full runs use identical 120-second test and 300-second file deadlines; timeouts are reported as failures, never passes."]}
    (OUT / "evidence.json").write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps({"passed": True, "focused": checks["tests"], "fullPassed": final["pass"],
                      "baselineFailures": len(final["failedFiles"]), "newFailures": added, "changedLineCoverage": coverage}), flush=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    assert (BEFORE / "src/return-netsuite.js").exists(), "Capture the unchanged workspace baseline first."
    frozen_source()
    source = {file: digest(FROZEN / file) for file in FILES}
    (OUT / "run-inputs.json").write_text(json.dumps({"sourceHashes": source,
        "baselineCaller": digest(BEFORE / FILES[0]), "testDeadlineMs": 120000, "fileDeadlineMs": 300000}, indent=2) + "\n")
    for name in ["checks.json", "evidence.json", "full-baseline.log", "full-final.log", "final-checks-run.log"]:
        (OUT / name).unlink(missing_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(phase, "full-baseline", BEFORE, "10.254.68.0/24", ["npm", "test"]),
                   pool.submit(phase, "full-final", FROZEN, "10.254.67.0/24", ["npm", "test"]),
                   pool.submit(phase, "final-checks-run", FROZEN, "10.254.66.0/24", ["node", "tools/return-stored-orderline-check.mjs"])]
        status = [future.result() for future in futures]
    assert status[2] == 0, "Focused verification failed."
    collect()


if __name__ == "__main__":
    collect() if sys.argv[1:] == ["--collect"] else main()
