#!/usr/bin/env python3
"""Summarize final, reproducible cargo/route verification without hiding gaps."""
import collections
import datetime
import difflib
import hashlib
import json
import pathlib
import re
import sys

SERVER = pathlib.Path(__file__).resolve().parents[1]
ORIGINAL = SERVER / "test-artifacts/dispatch-all-history-20261002"
ROOT = ORIGINAL / "cargo-route"
SOURCE = ROOT / "final-source"
PRODUCTION = ["src/driver-repository.js", "src/dispatch-retained-link-manifests.js",
              "src/dispatch-load-assignment.js", "public/dispatch.js"]


def read(path):
    return json.loads(path.read_text())


def suite(path):
    path = path.resolve()
    text = path.read_text()
    matches = re.findall(r"\[isolation\] [^\n]*? \d+/(\d+) ((?:/app/)?test/[^\n]+)", text)
    failed = re.findall(r"run failed in \d+/\d+ file\(s\): ([^\n]+)", text)
    files = {name.removeprefix("/app/") for _, name in matches}
    failures = {name.removeprefix("/app/") for name in failed[-1].split(", ")} if failed else set()
    named, current = set(), ""
    for line in text.splitlines():
        file = re.search(r"\[isolation\] [^\n]*? \d+/\d+ ((?:/app/)?test/[^\n]+)", line)
        if file:
            current = file[1].removeprefix("/app/")
        test = re.match(r"✖ (.+?)(?: \([\d.]+ms\))?$", line)
        if test and test[1] != "failing tests:":
            named.add(current + " :: " + test[1])
    return {"path": str(path.relative_to(ORIGINAL) if path.is_relative_to(ORIGINAL) else path.relative_to(SERVER)), "files": len(files),
            "tests": sum(map(int, re.findall(r"^ℹ tests (\d+)$", text, re.M))),
            "complete": bool(matches) and len(files) == int(matches[-1][0]),
            "failingFiles": sorted(failures), "failingTests": sorted(named)}


def lint(path):
    return collections.Counter((file["filePath"], message["ruleId"], message["severity"],
        re.sub(r"on line \d+ column \d+", "on line N column N", message["message"]))
        for file in read(path) for message in file["messages"])


def types(path):
    return collections.Counter(re.findall(r"([^\n]+?)\(\d+,\d+\): error (TS\d+): ([^\n]+)", path.read_text()))


def manifest():
    files = {}
    for directory in ("src", "public", "test", "tools", "contracts", "migrations"):
        for path in sorted((SOURCE / directory).rglob("*")):
            if path.is_file():
                files[str(path.relative_to(SOURCE))] = hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted(SOURCE.glob("*.json")) + sorted(SOURCE.glob("eslint*.js")):
        files[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    tree = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"treeSha256": tree, "files": files}


def coverage():
    result = []
    data = read(ROOT / "coverage/coverage-final.json")
    for file in PRODUCTION:
        rows = (SOURCE / file).read_text().splitlines()
        prior = ORIGINAL / "final-source" / file
        old = prior.read_text().splitlines() if prior.exists() else []
        changed = set()
        for op, _, _, start, end in difflib.SequenceMatcher(None, old, rows, autojunk=False).get_opcodes():
            if op in ("insert", "replace"):
                changed.update(range(start + 1, end + 1))
        counts = {}
        file_data = data["/app/" + file]
        for key, statement in file_data["statementMap"].items():
            for line in range(statement["start"]["line"], statement["end"]["line"] + 1):
                counts[line] = max(counts.get(line, 0), file_data["s"][key])
        executable = sorted(line for line in changed & counts.keys()
            if rows[line - 1].strip() and not rows[line - 1].lstrip().startswith(("//", "/*", "*")))
        missing = [line for line in executable if not counts[line]]
        branches = [key for key, branch in file_data["branchMap"].items()
                    if branch["line"] in changed]
        result.append({"file": file, "changedExecutableLines": len(executable),
            "covered": len(executable) - len(missing), "uncovered": missing,
            "changedBranchPaths": sum(len(file_data["b"][key]) for key in branches),
            "coveredBranchPaths": sum(sum(count > 0 for count in file_data["b"][key]) for key in branches)})
    return result


def audit(report):
    keys = ["loads", "pickups", "deliveries", "contentChecks", "driverContentChecks",
            "toLinkedDeliveries", "poLinkedDeliveries"]
    streams = {}
    for stream in ("snapshot", "command"):
        rows = [row for row in report["records"] if row["stream"] == stream]
        streams[stream] = {"states": len(rows),
            **{key: sum(row[key] for row in rows) for key in keys},
            "unresolvedCargoStops": sum(len(row["evidenceGaps"]) for row in rows),
            "unresolvedRouteChecks": dict(collections.Counter(issue["check"] for row in rows for issue in row["routeIssues"])),
            "routesSupportedByDatedExecution": sum(len(row["executionSupportedRoutes"]) for row in rows)}
    return {"pass": report["pass"], "completedAt": report.get("completedAt"),
        "states": len(report["records"]), "failureCount": len(report["failures"]),
        "outcomes": dict(collections.Counter(row["result"] for row in report["records"])),
        "sourceStable": all(stage["hashes"] == report.get("finalHashes") for stage in report["sourceStages"]),
        "streams": streams}


def main():
    audits = [read(ROOT / f"pass-{number}.json") for number in (1, 2)]
    saves = [read(ROOT / "save-replays" / f"pass-{number}.json") for number in (1, 2)]
    suites = {}
    for category in ("full", "dispatch"):
        baseline_path = ROOT / f"{category}-baseline.log"
        if not baseline_path.exists():
            baseline_path = ORIGINAL / f"{category}-candidate.log"
        before, after = suite(baseline_path), suite(ROOT / f"{category}-candidate.log")
        suites[category] = {"baseline": before, "candidate": after,
            "newFailingFiles": sorted(set(after["failingFiles"]) - set(before["failingFiles"])),
            "newFailingTests": sorted(set(after["failingTests"]) - set(before["failingTests"]))}
    baseline_types = ROOT / "types-baseline.log"
    if not baseline_types.exists():
        baseline_types = ORIGINAL / "types-candidate.log"
    bt, ct = types(baseline_types), types(ROOT / "types-candidate.log")
    bl, cl = lint(ROOT / "lint-baseline.json"), lint(ROOT / "lint-candidate.json")
    mutations, secrets = read(ROOT / "mutations.json"), read(ROOT / "secrets.json")
    focused, shuffled = suite(ROOT / "focused-final.log"), suite(ROOT / "shuffle.log")
    covered = coverage()
    state = manifest()
    (ROOT / "source-manifest.json").write_text(json.dumps(state, indent=2) + "\n")
    core = {file: state["files"][file] for file in PRODUCTION}
    workspace_matches = all(hashlib.sha256((SERVER / file).read_bytes()).hexdigest() == digest
                            for file, digest in core.items())
    comparable = [{key: row[key] for key in ("index", "stream", "sourceId", "planId", "planDate", "result",
                    "loads", "pickups", "deliveries", "contentChecks", "driverContentChecks", "evidenceGaps", "routeIssues")}
                  for row in audits[0]["records"]]
    comparable_second = [{key: row[key] for key in comparable[0]} for row in audits[1]["records"]] if comparable else []
    save_summary = []
    for report in saves:
        save_summary.append({"pass": report["pass"], "completedAt": report.get("completedAt"),
            "inventory": report["inventory"], "outcomes": report["outcomes"],
            "focusedSuiteExit": report.get("focusedSuiteExit"),
            "sourceStable": all(stage["hashes"] == report.get("finalHashes") for stage in report["sourceStages"])})
    unresolved = [{key: row[key] for key in ("planId", "planDate", "evidenceGaps", "routeIssues", "executionSupportedRoutes")}
                  for row in audits[1]["records"] if row["stream"] == "snapshot" and (row["evidenceGaps"] or row["routeIssues"])]
    (ROOT / "unresolved-final-stops.json").write_text(json.dumps(unresolved, indent=2) + "\n")
    checks = {
        "pairedContentAudits": all(report.get("completedAt") and len(report["records"]) == 3101 and not report["failures"]
                                  and all(stage["hashes"] == report["finalHashes"] for stage in report["sourceStages"]) for report in audits),
        "pairedContentResultsIdentical": comparable == comparable_second,
        "pairedSaveReplays": all(row["completedAt"] and row["focusedSuiteExit"] == 0 and row["sourceStable"]
            and row["outcomes"].get("saved_and_rolled_back") == row["inventory"]["acceptedScopedStates"] == 3101
            and not row["outcomes"].get("evidence_gap") for row in save_summary),
        "broadRegression": all(row["baseline"]["complete"] and row["candidate"]["complete"]
            and not row["newFailingFiles"] and not row["newFailingTests"] for row in suites.values()),
        "types": not ct - bt, "lint": not cl - bl,
        "focused": focused["complete"] and not focused["failingFiles"] and focused["tests"] == 194,
        "shuffled": shuffled["complete"] and not shuffled["failingFiles"] and shuffled["tests"] == 194,
        "mutations": len(mutations["mutations"]) == 8 and all(row["killed"] for row in mutations["mutations"])
            and all(row["propertyOnly"]["killed"] for row in mutations["mutations"] if row["propertyOnly"])
            and mutations["restoredSuiteExit"] == 0,
        "coverage": all(not row["uncovered"] for row in covered),
        "complexity": not (ROOT / "complexity.log").read_text().strip(),
        "secrets": not secrets["findings"], "workspaceProductionMatchesTestedSource": workspace_matches,
    }
    evidence = {"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Accepted retained August/September 2026 snapshots and full command receipts; newest dated evidence wins over July.",
        "specApproval": "not obtained (autonomous run); user explicitly authorized checks and fixes",
        "sourceTreeSha256": state["treeSha256"], "productionHashes": core,
        "checks": checks, "logicRegressionGatesPassed": all(checks.values()),
        "historicalEvidenceComplete": not unresolved,
        "contentAudits": [audit(report) for report in audits], "saveReplays": save_summary,
        "broadSuites": suites, "focused": focused, "shuffled": shuffled,
        "types": {"baseline": sum(bt.values()), "candidate": sum(ct.values()), "new": sum((ct - bt).values())},
        "lint": {"baseline": sum(bl.values()), "candidate": sum(cl.values()), "new": sum((cl - bl).values())},
        "coverage": covered, "mutations": mutations, "secretsAndVersions": secrets,
        "specTestMapping": {
            "TO allocation belongs only at its pickup yard; duplicate SO lines conserve quantities": "test/dispatch/unit/linked-stop-cargo.test.js (300 generated cases, seed 20261002)",
            "PO manifests establish vendor stops and scope each vendor and destination": "test/dispatch/unit/linked-stop-cargo.test.js",
            "Grouped children appear only at their physical source yard; whole CO authority survives": "test/dispatch/unit/linked-stop-cargo.test.js",
            "Shared TO includes every linked SO allocation online and offline": "test/dispatch/integration/linked-driver-stop-content.test.js",
            "Full PO pickup and linked SO allocation appear once, preserving execution identities": "test/dispatch/integration/linked-driver-stop-content.test.js",
            "Packing-independent links retain physical execution guards": "test/dispatch/integration/to-dependency-packing-independent.test.js and original 117-test history safety gate",
            "Dated cargo and route evidence reconciled per retained stop": "tools/dispatch-history-cargo-oracle.mjs and tools/dispatch-history-cargo-replay.mjs",
            "Actual V2 saves retain assigned order cargo and roll back every write": "tools/dispatch-all-history-replay.mjs (two complete fresh passes, 133-test completion gates)"},
        "limits": [
            "Historical cards with no retained material cargo cannot be independently verified. They are evidence gaps, not verified empty deliveries.",
            "Incomplete intermediate saved edits and missing dated TO-arrival/pickup evidence are explicitly listed, including final snapshots.",
            "The audit compares dated plan cargo projections. Original authoritative source versions and all past SQL-backed driver displays are unavailable; real driver online/offline behavior is separately checked with isolated fixtures.",
            "Repository-wide pre-existing failures remain. The gate requires zero new failures rather than claiming the whole repository passes.",
            "Changed-line coverage is the constraint. Whole-file global coverage covers large pre-existing modules and is not asserted; changed branch counts are reported separately.",
            "Private captured history and the existing local Docker images are required to reproduce this run. No new packages were installed.",
            "No production deployment or business-data repair was performed."],
        "verificationCorrections": [
            "The initial expanded focused runner shared a database and collided on a fixed-date driver fixture. Existing per-file database isolation fixed the verification setup; no assertion changed.",
            "The initial c8 invocation inherited whole-file global thresholds. Final coverage uses the specified changed-line gate, reporting whole-file and branch results separately."]}
    (ROOT / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    final = evidence["contentAudits"][1]["streams"]["snapshot"]
    text = ["# Historical pickup, delivery and linked-route verification", "",
        f"Logic regression gates passed: **{evidence['logicRegressionGatesPassed']}**. Complete historical evidence: **{evidence['historicalEvidenceComplete']}**.", "",
        "Two independent audits each checked 3,101 accepted August/September states. Both real V2 save replays rolled back every write. Newer dated evidence takes precedence over July.", "",
        "Fixed TO cargo duplicated at the SO source, missing shared-TO allocations, repeated allocation subtraction on duplicate lines, PO vendor and delivery scope, physical PO/CO pickup contents, shared-PO double counting, grouped child yard scope, and non-material fees displayed as cargo.", "",
        f"Final 60 snapshots contain {final['pickups']} pickup stops and {final['deliveries']} delivery stops. {final['contentChecks']} Dispatch content comparisons and {final['driverContentChecks']} driver plan-content comparisons ran per pass.", "",
        f"Historical limits remain: {final['unresolvedCargoStops']} delivery stops have no retained material-cargo evidence; {sum(final['unresolvedRouteChecks'].values())} route checks lack dated pickup/TO-arrival proof ({final['unresolvedRouteChecks']}). See [unresolved final stops](unresolved-final-stops.json).", "",
        f"Focused regressions: {focused['tests']} tests in {focused['files']} files; shuffled rerun: {shuffled['tests']}. Manual mutants: 8/8 killed, including two independently killed by the property test. Changed executable lines: {sum(row['covered'] for row in covered)}/{sum(row['changedExecutableLines'] for row in covered)}.", "",
        f"New failures: full suite {len(suites['full']['newFailingTests'])}; Dispatch suite {len(suites['dispatch']['newFailingTests'])}; types {evidence['types']['new']}; lint {evidence['lint']['new']}. Existing repository failures are preserved in [machine-readable evidence](evidence.json).", "",
        "For example, a full 51-pallet PO supplying 38 pallets to a customer and 13 to the yard now shows 51 at the vendor pickup, 38 at the customer and 13 at the yard. A shared TO supplying 4 + 3 pieces shows all 7 online and offline.", "",
        "Spec approval was not obtained (autonomous run). The user authorized the checks and fixes. No production deployment occurred.", "",
        f"Source tree SHA-256: `{state['treeSha256']}`. Tool versions and every gate are recorded in evidence.json. Reproduce with `bash server/tools/dispatch-history-cargo-gauntlet.sh` from the repository root; previous reports are preserved before rerunning.", ""]
    (ROOT / "REPORT.md").write_text("\n".join(text))
    print(json.dumps({"checks": checks, "logicRegressionGatesPassed": evidence["logicRegressionGatesPassed"],
        "historicalEvidenceComplete": evidence["historicalEvidenceComplete"], "finalSnapshots": final}, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
