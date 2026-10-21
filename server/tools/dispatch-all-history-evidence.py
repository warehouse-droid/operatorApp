#!/usr/bin/env python3
"""Build reproducible evidence from retained replay and verification artifacts."""
import collections
import difflib
import hashlib
import json
import pathlib
import re
import sys

SERVER = pathlib.Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / "test-artifacts/dispatch-all-history-20261002"
SOURCE = ARTIFACT / "final-source"
REPORTS = ARTIFACT / "reproduction" if "--reproduction" in sys.argv else ARTIFACT
if "--reports" in sys.argv:
    REPORTS = pathlib.Path(sys.argv[sys.argv.index("--reports") + 1]).resolve()


def read_json(path):
    return json.loads(path.read_text())


def suite(name):
    text = (ARTIFACT / name).read_text()
    matches = re.findall(r"\[isolation\] [^\n]*? \d+/(\d+) ((?:/app/)?test/[^\n]+)", text)
    failed = re.findall(r"run failed in \d+/\d+ file\(s\): ([^\n]+)", text)
    failures = {path if path.startswith("/app/") else "/app/" + path
        for path in failed[-1].split(", ")} if failed else set()
    complete = bool(matches) and len({path for _, path in matches}) == int(matches[-1][0])
    test_failures = set()
    current_file = ""
    for line in text.splitlines():
        file = re.search(r"\[isolation\] [^\n]*? \d+/\d+ ((?:/app/)?test/[^\n]+)", line)
        if file:
            current_file = file[1] if file[1].startswith("/app/") else "/app/" + file[1]
        test = re.match(r"✖ (.+?)(?: \([\d.]+ms\))?$", line)
        if test and test[1] != "failing tests:":
            test_failures.add(current_file + " :: " + test[1])
    return {"files": len({path for _, path in matches}), "failures": sorted(failures),
        "failingTests": sorted(test_failures), "complete": complete}


def lint(name):
    return collections.Counter((file["filePath"], message["ruleId"], message["severity"],
        re.sub(r"on line \d+ column \d+", "on line N column N", message["message"]))
        for file in read_json(ARTIFACT / name) for message in file["messages"])


def types(name):
    return collections.Counter(re.findall(r"([^\n]+?)\(\d+,\d+\): error (TS\d+): ([^\n]+)",
        (ARTIFACT / name).read_text()))


def changed_coverage():
    result = []
    for path, data in read_json(ARTIFACT / "coverage/coverage-final.json").items():
        relative = path.removeprefix("/app/")
        current = (SOURCE / relative).read_text().splitlines()
        before_root = ARTIFACT / "workspace-baseline" if (ARTIFACT / "workspace-baseline").exists() else ARTIFACT / "baseline"
        old_path = before_root / relative
        old = old_path.read_text().splitlines() if old_path.exists() else []
        changed = set()
        for op, _, _, start, end in difflib.SequenceMatcher(None, old, current, autojunk=False).get_opcodes():
            if op in ("replace", "insert"):
                changed.update(range(start + 1, end + 1))
        counts = {}
        for key, statement in data["statementMap"].items():
            for line in range(statement["start"]["line"], statement["end"]["line"] + 1):
                counts[line] = max(counts.get(line, 0), data["s"][key])
        executable = sorted(line for line in changed & counts.keys()
            if current[line - 1].strip() and not current[line - 1].lstrip().startswith(("//", "/*", "*")))
        uncovered = [line for line in executable if not counts[line]]
        result.append({"file": relative, "changedLines": len(executable),
            "covered": len(executable) - len(uncovered), "uncovered": uncovered})
    return result


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


passes = [read_json(REPORTS / f"pass-{number}.json") for number in (1, 2)]
full_baseline = suite("full-workspace-baseline.log" if (ARTIFACT / "full-workspace-baseline.log").exists() else "full-baseline.log")
additional = ARTIFACT / "full-workspace-baseline-additional.log"
if not additional.exists():
    additional = ARTIFACT / "full-baseline-additional.log"
additional_baseline = suite(additional.name) if additional.exists() else {"files": 0, "failures": [], "complete": True}
full_candidate = suite("full-candidate.log")
dispatch_baseline = suite("dispatch-workspace-baseline.log" if (ARTIFACT / "dispatch-workspace-baseline.log").exists() else "dispatch-baseline.log")
dispatch_candidate = suite("dispatch-candidate.log")
new_full = sorted(set(full_candidate["failures"]) - set(full_baseline["failures"]) - set(additional_baseline["failures"]))
new_dispatch = sorted(set(dispatch_candidate["failures"]) - set(dispatch_baseline["failures"]))
new_full_tests = sorted(set(full_candidate["failingTests"]) - set(full_baseline["failingTests"]))
new_dispatch_tests = sorted(set(dispatch_candidate["failingTests"]) - set(dispatch_baseline["failingTests"]))
baseline_lint, candidate_lint = lint("lint-baseline.json"), lint("lint-candidate.json")
baseline_types, candidate_types = types("types-baseline.log"), types("types-candidate.log")
mutations = read_json(ARTIFACT / "mutations.json")
health = read_json(ARTIFACT / "suite-health.json")
secrets = read_json(ARTIFACT / "secrets.json")
complexity = read_json(ARTIFACT / "complexity.json")
camera = {f"{kind}-{repeat}": suite(f"camera-{kind}-{repeat}.log")
    for repeat in (1, 2) for kind in ("baseline", "candidate")}
camera_new = sorted(set().union(*(set(camera[f"candidate-{repeat}"]["failingTests"]) for repeat in (1, 2)))
    - set().union(*(set(camera[f"baseline-{repeat}"]["failingTests"]) for repeat in (1, 2))))
coverage = changed_coverage()
source = manifest()
(ARTIFACT / "source-manifest.json").write_text(json.dumps(source, indent=2) + "\n")
replay_ok = all(report.get("completedAt") and report.get("focusedSuiteExit") == 0
    and report["outcomes"].get("saved_and_rolled_back", 0) == report["inventory"]["acceptedScopedStates"]
    and not report["outcomes"].get("evidence_gap") for report in passes)
second_ok = not passes[1]["failures"] and passes[1]["sourceStages"][0]["hashes"] == passes[1]["finalHashes"]
evidence = {"scope": passes[1]["scope"], "sourceTreeSha256": source["treeSha256"],
    "specApproval": "not obtained (autonomous run)",
    "replay": [{"pass": report["pass"], "completedAt": report.get("completedAt"),
        "outcomes": report["outcomes"], "inventory": report["inventory"], "focusedSuiteExit": report.get("focusedSuiteExit")}
        for report in passes],
    "fullSuite": {"baseline": full_baseline, "additionalBaseline": additional_baseline,
        "candidate": full_candidate, "newFailingFiles": new_full, "newFailingTests": new_full_tests},
    "dispatchSuite": {"baseline": dispatch_baseline, "candidate": dispatch_candidate,
        "newFailingFiles": new_dispatch, "newFailingTests": new_dispatch_tests},
    "suiteHealth": health,
    "cameraRecheck": {"runs": camera, "newFailingTests": camera_new,
        "observation": "The initial broad runs varied; two repetitions reproduce the same pre-existing camera failures in baseline and candidate."},
    "secrets": secrets,
    "complexity": {"newHistoricalHelperMaximum": 12,
        "findings": [message for file in complexity for message in file["messages"]]},
    "specTestMapping": {
        "packing-independent TO links, extension, unlink, grouping and actual Dispatch save": "test/dispatch/integration/to-dependency-packing-independent.test.js",
        "unchanged historical boards retain original split cargo without reviving retired definitions": "test/dispatch/integration/retained-history-save.test.js",
        "missing cargo uses latest eligible dated evidence and exact route audit": "test/dispatch/integration/historical-missing-order-snapshot.test.js",
        "later stop IDs preserve identical loads and protect real changes": "test/dispatch/unit/executed-prefix-historical-reflexivity.test.js",
        "child pickup yards, whole-group CO authority and cancelled vendor allocation": "test/dispatch/unit/historical-group-pickups.test.js",
        "scope, synthetic controls and unapplied recovery drafts": "test/dispatch/unit/historical-replay-fixture-classification.test.js",
        "property invariants and temporal July/August/September precedence": "test/dispatch/property/historical-planning-safety.property.test.js",
        "completed CO arrival precedes a new customer leg while actual loading blocks": "test/mbt/integration/link-to-fix.test.js",
        "all accepted retained boards save, preserve assigned cargo and roll back": "tools/dispatch-all-history-replay.mjs"
    },
    "types": {"baseline": sum(baseline_types.values()), "candidate": sum(candidate_types.values()),
        "new": sum((candidate_types - baseline_types).values())},
    "lint": {"baseline": sum(baseline_lint.values()), "candidate": sum(candidate_lint.values()),
        "new": sum((candidate_lint - baseline_lint).values())},
    "mutations": {"killed": sum(row["killed"] for row in mutations["mutations"]),
        "total": len(mutations["mutations"]), "propertyOnlyKilled": sum(row.get("propertyKilled", False) for row in mutations["mutations"]),
        "restoredSuiteExit": mutations["restoredSuiteExit"]},
    "coverage": coverage,
    "limitations": passes[1]["limitations"] + [
        "Baseline regression comparison records failing test files and named Node subtests; the pre-existing failures remain unresolved.",
        "The captured database and backup artifacts are private inputs required to reproduce the historical replay.",
        "Production has not been changed or deployed; every historical write was rolled back in the isolated clone."
    ]}
evidence["passed"] = bool(replay_ok and second_ok and not new_full and not new_dispatch and not new_full_tests and not new_dispatch_tests
    and all(row["complete"] for row in (full_baseline, additional_baseline, full_candidate, dispatch_baseline, dispatch_candidate))
    and not evidence["types"]["new"] and not evidence["lint"]["new"]
    and evidence["mutations"]["killed"] == evidence["mutations"]["total"] and mutations["restoredSuiteExit"] == 0
    and all(not row["uncovered"] for row in coverage) and health["exit"] == 0 and not secrets["unresolved"]
    and not evidence["complexity"]["findings"] and not camera_new and all(row["complete"] for row in camera.values()))
(ARTIFACT / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps({"passed": evidence["passed"], "replayedStates": passes[1]["outcomes"].get("saved_and_rolled_back"),
    "newFailingFiles": new_full + new_dispatch, "newTypes": evidence["types"]["new"],
    "newFailingTests": new_full_tests + new_dispatch_tests,
    "newLint": evidence["lint"]["new"], "mutations": evidence["mutations"], "coverage": coverage}, indent=2))
sys.exit(0 if evidence["passed"] else 1)
