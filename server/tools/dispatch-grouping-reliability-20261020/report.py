"""Write auditable results without including business order details or credentials."""
import hashlib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / "test-artifacts/dispatch-grouping-reliability-20261020"
read = lambda path: json.loads(path.read_text())
files = read(TASK / "source-review.json")["changedFiles"]
result = {
    "task": "Edit Mode delay and grouping reliability",
    "specApproval": "not obtained (autonomous run)",
    "tier": 3,
    "specification": read(TASK / "spec.json"),
    "specAmendment": read(TASK / "spec-amendment-1.json"),
    "reproduce": "python3 server/tools/dispatch-grouping-reliability-20261020/gauntlet.py",
    "baseline": read(OUT / "baseline.json"),
    "regressions": read(OUT / "final.json"),
    "randomizedFileOrder": read(OUT / "health.json"),
    "static": read(OUT / "static.json"),
    "mutations": read(OUT / "mutations.json"),
    "changedLineCoverage": read(OUT / "changed-coverage.json"),
    "sourceReview": read(TASK / "source-review.json"),
    "sourceHashes": {name: hashlib.sha256((TASK / "candidate" / name).read_bytes()).hexdigest() for name in files},
    "specMapping": {
        "editOwnershipAndLease": "edit-group-reliability.browser.test.mjs; order-update-save.test.js; edit-group-reliability.test.js",
        "completeGroupingDespiteRefreshes": "group-hydration-concurrency.test.js (40 generated scenarios) and Playwright Group flow",
        "selectionPlanAndDraftSafety": "edit-group-reliability.browser.test.mjs; dispatch-freshness-races.test.js",
        "poAllocationPreservation": "edit-group-reliability.test.js; sales-split-allocation-unsplit.test.js; resplit-sibling-group-allocations.test.js",
        "transactionAndHistoricalSafety": "allocation race, failed-write rollback, and history-preservation integration regressions",
        "existingRoutePreserved": "before-state.json / after-state.json read-only plan and allocation hashes"
    },
    "knownLimits": [
        "One pre-existing DP-33 source-regex contract failure remains; no new regression failures.",
        "The affected Dispatch regression suite was run; the entire repository-wide application suite was not run for this scoped release.",
        "Types are compared against the live-source baseline; the repository already has many type errors.",
        "Changed-line coverage uses V8 execution ranges; no aggregate branch-coverage percentage is claimed.",
        "The grouping concurrency property suite kills one of five mutants; focused browser and database tests kill the remaining four.",
        "No dependency audit was needed because dependencies did not change.",
        "No production business orders were grouped or saved by the diagnostic browser.",
        "Broader initial Loading Plan performance remains outside this prioritized release."
    ],
    "testHarnessCorrections": [
        "Restored missing runtime globals and URL parsing in existing hydration/lease fixtures without weakening assertions.",
        "The isolated real-click page needed the production stylesheet and a valid heartbeat response.",
        "The assignment HTTP fixture needed an actual planned stop.",
        "Baseline and candidate type checks use identical shared type declarations."
    ],
    "cleanup": {mode: read(OUT / f"cleanup-{mode}.json") for mode in ["final", "static", "mutations", "health"]}
}
release = SERVER / "deployments/dispatch-grouping-reliability-20261020/published.json"
if release.exists():
    result["release"] = read(release)
live = SERVER / "artifacts/dispatch-edit-group-verification-20261020/browser.json"
if live.exists():
    browser = read(live)
    assert not browser.get("failure")
    round = browser["rounds"][0]
    assert round["grouping"]["error"] is None
    assert [order["id"] for order in round["grouping"]["orders"]] == ["SOA09143-S5", "SOA09140-S5"]
    assert [order["quantities"] for order in round["grouping"]["orders"]] == [[36, 1], [2232]]
    assert not round["grouping"]["dirty"]
    assert all(read(live.parent / "preservation.json").values())
    finished = next(json.loads(line) for line in (live.parent / "proxy.jsonl").read_text().splitlines()
                    if json.loads(line).get("event") == "finished")
    assert finished["credentialsRemoved"]
    production = {"mbbs-operator-app-app-1", "mbbs-operator-app-db-1",
                  "mbbs-operator-app-webhook-worker-1", "mbbs-operator-app-ollama-1"}
    for filename in ["docker-ps.txt", "docker-ps-a.txt"]:
        lines = (live.parent / filename).read_text().splitlines()
        assert {line.split()[0] for line in lines} == production
        assert all(" Up " in line for line in lines)
    assert read(live.parent / "production-health.json")["ok"]
    result["livePlaywright"] = {
        "failure": browser.get("failure"),
        "rounds": [{key: row.get(key) for key in ["loadedMs", "editMs", "releaseMs", "editBlockedByExistingLease", "disabledReason", "grouping"]}
                   for row in browser.get("rounds", [])],
        "planSplitsAndAllocationsPreserved": True,
        "diagnosticCredentialsRemoved": True,
        "onlyProductionContainersRemain": True,
        "assignmentResponses": [{"bytes": row.get("bytes"), "ms": row.get("totalMs")}
                                for row in finished["requests"] if row["pathname"] == "/api/dispatch/planned-assignments"]
    }
(OUT / "evidence.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"evidence": str(OUT / "evidence.json"),
                  "pass": result["regressions"]["pass"], "knownFailures": result["regressions"]["fail"]}))
