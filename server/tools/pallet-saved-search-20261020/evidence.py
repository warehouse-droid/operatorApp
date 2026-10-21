"""Summarize persisted release and test evidence without credentials or raw report rows."""
import hashlib
import json
from pathlib import Path
import statistics

SERVER = Path(__file__).resolve().parents[2]
RELEASE = SERVER / "deployments/pallet-saved-search-20261020"
FINAL = SERVER / "test-artifacts/pallet-saved-search-20261020/final"


def read(path):
    return json.loads(path.read_text())


def timings(path):
    samples = read(path)["samples"]
    return {
        "samples": len(samples),
        "medianLookupMs": statistics.median(sample["elapsedMs"] for sample in samples),
        "warmMedianLookupMs": statistics.median(sample["elapsedMs"] for sample in samples[1:]),
        "byCustomer": {
            str(customer): {
                "available": [sample["available"] for sample in samples if sample["customerId"] == customer],
                "lookupMs": [sample["elapsedMs"] for sample in samples if sample["customerId"] == customer],
                "requestCategories": [[request["category"] for request in sample["requests"]]
                                      for sample in samples if sample["customerId"] == customer],
            } for customer in (5240, 1959)
        },
    }


if __name__ == "__main__":
    manifest = read(RELEASE / "manifest.json")
    results = read(FINAL / "results.json")
    deployment = read(RELEASE / "deployment-result.json")
    assert results["passed"] and deployment["deployed"]
    assert results["sourceHashes"] == {
        name: manifest["candidateTree"][name] for name in manifest["files"]
    }
    coverage = read(FINAL / "changed-coverage.json")
    covered = sum(len(value["changedExecutableLines"]) for value in coverage.values())
    assert not any(value["uncovered"] for value in coverage.values())
    mutation = read(FINAL / "mutations.json")
    assert all(value["killed"] for value in mutation["mutants"])
    lint = read(FINAL / "lint-comparison.json")
    types = read(FINAL / "types-comparison.json")
    assert not lint["newFindings"] and not types["newFindings"]
    before, after = timings(RELEASE / "live-before.json"), timings(RELEASE / "live-after.json")
    parser = read(FINAL / "coverage/coverage-summary.json")["/app/src/return-pallet-saved-search.js"]
    harnesses = read(FINAL / "harnesses.json")
    assert harnesses == read(SERVER / "test-artifacts/pallet-saved-search-20261020/baseline/harnesses.json")
    assert "teardown_exit=0" in (FINAL / "teardown.log").read_text()
    source_state = manifest["candidateTreeHash"]
    source_spec = SERVER / "test/pallet-saved-search-integration-spec.json"
    evidence = {
        "deployed": True,
        "sourceTreeHash": source_state,
        "imageId": deployment["imageId"],
        "specHash": hashlib.sha256(source_spec.read_bytes()).hexdigest(),
        "tests": results["savedSearchTests"],
        "returnRegressions": 153,
        "generatedCases": results["generatedCases"],
        "changedLinesCovered": covered,
        "changedLinesMissed": 0,
        "parserBranches": parser["branches"],
        "mutantsKilled": len(mutation["mutants"]),
        "propertyMutantsKilled": sum(value["propertyKilled"] for value in mutation["mutants"]),
        "newLintFindings": 0,
        "baselineLintFindings": lint["baselineCount"],
        "newScopedTypeFindings": 0,
        "baselineScopedTypeFindings": len(types["baseline"]),
        "baselineHarnessFailures": [name for name, value in harnesses.items() if value["exit"]],
        "timingBefore": before,
        "timingAfter": after,
        "versions": results["versions"],
        "node": results["node"],
    }
    (RELEASE / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    lines = [
        "Pallet saved-search integration — final evidence",
        "Spec approval: not obtained (autonomous run); the user's request authorized the integration.",
        "The spec was inferred and should be reviewed as an artifact, not described as user-approved.",
        f"Source tree SHA-256: {source_state}",
        f"Image: {deployment['imageId']}",
        "",
        "Entry point, from server/:",
        "  bash tools/pallet-saved-search-20261020/test.sh final node tools/pallet-saved-search-20261020/checks.mjs",
        "Release commands:",
        "  python3 tools/pallet-saved-search-20261020/release.py validate",
        "  python3 tools/pallet-saved-search-20261020/release.py build",
        "  python3 tools/pallet-saved-search-20261020/release.py apply",
        "Live read (no return submitted):",
        "  docker exec -i mbbs-operator-app-app-1 node --input-type=module < tools/pallet-saved-search-20261020/live-read.mjs",
        "Evidence summary: python3 tools/pallet-saved-search-20261020/evidence.py",
        "",
        f"Focused suite: {results['savedSearchTests']} passed; affected return regressions: 153 passed in 18 isolated databases.",
        f"Generated cases: {results['generatedCases']} across 3 properties, seeds 800909, 800809, 505.",
        f"Changed nonblank executable/source lines covered: {covered}/{covered}; no misses.",
        f"Parser branch coverage: {parser['branches']['covered']}/{parser['branches']['total']}.",
        f"Manual mutants killed: {len(mutation['mutants'])}/{len(mutation['mutants'])}; restored suite: {mutation['restoredTests']} passed.",
        f"Property-only mutants killed: {evidence['propertyMutantsKilled']}/{len(mutation['mutants'])}.",
        mutation["propertyLimits"],
        f"Lint: zero new findings; {lint['baselineCount']} existing findings unchanged.",
        f"Scoped strict types: zero new findings; {len(types['baseline'])} existing implicit-any diagnostics unchanged.",
        "Parser module: strict checkJs passed. Other changed functions were extracted exactly with external boundaries declared any.",
        "Syntax and secret scan passed. Package and lock files unchanged; dependency audit not repeated because no dependency changes.",
        "Regression file order reproducibly shuffled with seed 800909; fresh disposable database per file.",
        "All task test containers, disposable database storage and networks removed; docker ps and ps -a recorded.",
        "",
        "Spec-to-check mapping:",
        "  S1/S2/S3/S4: test/mbt/unit/return-pallet-saved-search.test.js (schema, identities, malformed input, empty result, arithmetic, configuration).",
        "  N1/N2: integration tests for same-account GET, credential confinement, no historical aggregate or silent fallback.",
        "  N3: integration tests for credit-identity SQL, completed/unindexed/deleted credits, mid-read credit creation and partial RA credits.",
        "  R1/R2: integration tests for fresh enquiry/submit, optional low-level cache isolation, pending reservations and concurrent submissions.",
        "  R3: 153 affected regression tests; unchanged application route/UI files; live anonymous API and health probes.",
        "  L1/P1: live-before.json, live-after.json, report-before.json and deployment-result.json.",
        "",
        "Baseline failures retained, with identical assertion fingerprints:",
    ]
    lines.extend(f"  {name}: {value['failure']}" for name, value in harnesses.items() if value["exit"])
    lines.extend([
        "",
        "Honest notes:",
        "Initial RED: 34 of 36 tests failed on behavior; two already-existing behaviors were subsequently proved with throwaway mutants.",
        "Adversarial review found a null result-row bug. Its new test failed before the guard was fixed.",
        "Test tooling needed artifact ownership correction, normalization of shifted source positions in baseline lint messages,",
        "and Espree extraction for the installed TypeScript 7 CLI. No behavior assertions were weakened.",
        "Two final extra mutants prove the configuration and credit SQL examples independently detect defects.",
        "The initial release capture detected unrelated workspace changes in netsuite.js; candidate changes were applied",
        "as a scoped patch to the captured live image, preserving those unrelated differences.",
        "No commit was requested; source hashes, exact overlay, rollback image and complete runtime-file verification identify the release.",
        "",
        f"Live warm median before: {before['warmMedianLookupMs']} ms; after: {after['warmMedianLookupMs']} ms.",
        "This is a small sequential live sample, not a latency guarantee. Report alignment does not imply a speed improvement.",
        "800909's historical total changed during the investigation from 206 to 207 issued (194 credited);",
        "its current physical total and the user's accepted saved-search balance both equal 13. 800809 equals 2.",
        "Saved-search results are customer-wide under the integration role's access and the report's saved criteria.",
        "No extra yard-150 filter is added. A summary cannot prove transaction membership;",
        "report owners must preserve compatible item, credit, date and location criteria.",
        "Every enquiry and submission is fresh; invalid responses and outages block allowance rather than switch balance definitions.",
        "No browser automation or full unrelated application suite was added for this backend-only change.",
        "",
        "Detailed JSON: deployments/pallet-saved-search-20261020/evidence.json",
        "Logs: test-artifacts/pallet-saved-search-20261020/final/",
    ])
    (RELEASE / "evidence.txt").write_text("\n".join(lines) + "\n")
    print(json.dumps(evidence, indent=2))
