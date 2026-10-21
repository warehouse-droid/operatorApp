"""Summarize the final isolated run and authorize building its exact candidate."""
import hashlib
import json
import re
from pathlib import Path

server = Path(__file__).resolve().parents[1]
artifacts = server / "test-artifacts/local-vrma-final-qty-20261019"
results = artifacts / "results"
release = server / "deployments/local-vrma-final-qty-20261019"
read_json = lambda name: json.loads((results / name).read_text())
manifest = json.loads((release / "manifest.json").read_text())
assert "Scoped VRMA suite passed." in (artifacts / "suite.log").read_text()
assert "teardown_exit=0" in (artifacts / "teardown.log").read_text()
source = read_json("source-hashes.json")
for name, digest in source["hashes"].items():
    assert digest == hashlib.sha256((release / "candidate" / name).read_bytes()).hexdigest()
    assert digest == hashlib.sha256((server / name).read_bytes()).hexdigest()
mutations = read_json("mutations.json")
assert mutations and all(row["killed"] for row in mutations)
coverage = read_json("changed-line-coverage.json")
assert all(not row["missed"] for row in coverage)
lint = read_json("static-delta.json")
assert all(not row["added"] for row in lint)
baseline = read_json("baseline-failures.json")
assert baseline["baseline"] == baseline["candidate"]

def totals(name):
    text = (results / name).read_text()
    return {key: int(re.search(r"(?m)^# " + key + r" (\d+)$", text)[1]) for key in ["tests", "pass", "fail"]}

report = {
    "spec": "test/local-vrma-final-qty-20261019.spec.json",
    "specApproval": "not obtained (autonomous run); user explicitly confirmed local-only scope, maximum, and historical cleanup",
    "tier": 3,
    "command": "VRMA_FINAL_QTY_ROOT=$PWD/server/deployments/local-vrma-final-qty-20261019/candidate bash server/tools/local-vrma-final-qty-test.sh node tools/local-vrma-final-qty-suite.mjs",
    "candidateTreeHash": manifest["candidateTreeHash"],
    "runtimeSource": source,
    "regression": totals("regression.log"),
    "browser": totals("browser.log"),
    "reopenRegression": totals("reopen-candidate.log"),
    "preExistingFailures": baseline,
    "newFailures": 0,
    "changedExecutableBackendLineCoverage": coverage,
    "mutations": mutations,
    "staticAnalysis": lint,
    "typeChecking": "src/operator-load-state.js passed; runtime syntax and baseline-relative lint passed",
    "properties": "25 seeded quantity/conservation cases plus existing load confirmation and URL encoding properties",
    "adversarial": "Empty load, premature load, small overage, concurrent replay, unproven legacy order, dry-run write prevention, proof/audit storage rollback",
    "realExecution": "Full application HTTP load plus Chromium confirmation dialog; historical apply verified in disposable PostgreSQL",
    "dependencies": "No dependencies or lockfiles changed; no added outbound network capability",
    "cleanup": "Compose down --volumes --remove-orphans; both docker ps and docker ps -a retained; production health passed",
    "limits": [
        "The entire repository test suite was not run; the complete selected VRMA/loading regression suite was run.",
        "Two unrelated Control reopen expectations also fail against the unchanged production baseline; exact failure names retained.",
        "Full legacy delivery/operator modules are not statically typed; syntax and lint were compared with baseline.",
        "UI was checked in Chromium and rendered-message tests; backend changed-line coverage excludes punctuation-only lines.",
        "Suite repeated in fixed order, not randomized; no dependency audit required because dependencies did not change."
    ],
    "developmentNotes": [
        "Initial fixture SQL needed an explicit numeric cast.",
        "The baseline comparison needed its migration directory copied with the source.",
        "The coverage reporter needed the installed CommonJS module's default import.",
        "Review found manual PLT counts must be preserved; regression test failed before correction.",
        "All test infrastructure was removed after every run, including failed checks."
    ]
}
assert report["regression"]["fail"] == 0 and report["browser"]["fail"] == 0
(artifacts / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
(release / "validation-passed.json").write_text(json.dumps({"passed": True, "candidateTreeHash": manifest["candidateTreeHash"], "evidence": str(artifacts / "evidence.json")}, indent=2) + "\n")
print(json.dumps({"passed": True, "regression": report["regression"], "browser": report["browser"], "mutationsKilled": len(mutations), "candidateTreeHash": manifest["candidateTreeHash"]}))
