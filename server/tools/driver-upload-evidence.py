#!/usr/bin/env python3
"""Verify retained results and write the local Driver upload evidence report."""
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "test-artifacts/driver-upload-reliability"


def read(name):
    return (ARTIFACTS / name).read_text()


def load(name):
    return json.loads(read(name))


def require(condition, explanation):
    if not condition:
        raise RuntimeError(explanation)


def tap_counts(name):
    source = read(name)
    result = {field: int(re.findall(rf"^# {field} (\d+)$", source, re.M)[-1])
              for field in ["tests", "pass", "fail"]}
    require(result["fail"] == 0 and result["tests"] == result["pass"], f"Failed or incomplete tests: {name}")
    return result


def regressions(name):
    source = read(name)
    files = re.findall(r"^\[isolation\] Driver PWA regressions \d+/71 (.+)$", source, re.M)
    failures = sorted(set(re.findall(r"^✖ (.+?) \([\d.]+ms\)$", source, re.M)))
    require(len(files) == 71 and len(set(files)) == 71, f"Incomplete regression execution: {name}")
    counts = {field: sum(map(int, re.findall(rf"^ℹ {field} (\d+)$", source, re.M)))
              for field in ["tests", "pass", "fail"]}
    return {"files": len(files), "counts": counts, "failedTests": failures}


def type_diagnostics(name):
    return Counter(re.sub(r"\(\d+,\d+\)", "(line,column)", line.strip())
                   for line in read(name).splitlines() if ": error TS" in line)


def browser_results():
    report = load("browser-report.json")
    results = []

    def visit(suite):
        for spec in suite.get("specs", []):
            for case in spec["tests"]:
                require(len(case["results"]) == 1 and case["results"][0]["status"] == "passed",
                        f"Browser test failed or retried: {spec['title']}")
                result = {"name": spec["title"], "project": case["projectName"]}
                for attachment in case["results"][0].get("attachments", []):
                    if attachment["name"] == "historical-coverage":
                        if "body" in attachment:
                            result["history"] = json.loads(base64.b64decode(attachment["body"]))
                        else:
                            path = Path(attachment["path"].replace("/app/test-artifacts/", f"{ARTIFACTS}/"))
                            result["history"] = json.loads(path.read_text())
                results.append(result)
        for child in suite.get("suites", []):
            visit(child)

    for suite in report["suites"]:
        visit(suite)
    require(len(results) == 48, "The final browser run must contain 40 historical routes and 8 fault cases.")
    by_project = {}
    for project in ["chromium-mobile", "webkit-mobile"]:
        cases = [case for case in results if case["project"] == project]
        history = [case["history"] for case in cases if "history" in case]
        require(len(cases) == 24 and len(history) == 20, f"Incomplete mobile replay: {project}")
        by_project[project] = {"passed": len(cases), "historicalRoutes": len(history),
                               "logicalJobs": sum(case["logicalJobs"] for case in history),
                               "photos": sum(case["photos"] for case in history)}
    return {"passed": len(results), "byProject": by_project, "cases": results}


def main():
    unit = tap_counts("coverage-unit.log")
    http = tap_counts("final-http.log")
    coverage = load("coverage-unit/coverage-summary.json")
    require(coverage["total"]["lines"]["pct"] == 100, "New upload modules have uncovered lines.")
    http_coverage = load("coverage-http/coverage-summary.json")
    repository_coverage = next(value for name, value in http_coverage.items()
                               if name.endswith("/driver-upload-failure-repository.js"))
    require(repository_coverage["lines"]["pct"] == 100, "Failure repository has uncovered lines.")
    mutants = load("mutations.json")
    require(len(mutants) == 10 and all(case["killed"] for case in mutants), "A targeted mutant survived.")
    require(all(case["propertyKilled"] for case in mutants if case["propertyExpected"]), "A progress mutant survived the property tests.")
    require("Secret scan passed:" in read("secrets-unit.log"), "Secret scanning did not pass.")
    require(not read("quality-focused-unit.log").strip(), "Focused lint/types did not pass.")
    baseline = regressions("regressions-baseline.log")
    current = regressions("regressions.log")
    require(current["failedTests"] == baseline["failedTests"], "New Driver PWA regression failures exist.")
    require(current["counts"] == baseline["counts"], "Driver regression counts changed unexpectedly.")
    current_types = type_diagnostics("repository-types-unit.log")
    baseline_types = type_diagnostics("baseline-types-unit.log")
    new_types = current_types - baseline_types
    require(not new_types, f"New type errors: {dict(new_types)}")
    type_report = {"currentDiagnostics": sum(current_types.values()), "baselineDiagnostics": sum(baseline_types.values()),
                   "distinctDiagnostics": len(current_types), "newDiagnostics": dict(new_types)}
    (ARTIFACTS / "type-baseline-comparison.json").write_text(json.dumps(type_report, indent=2) + "\n")
    (ARTIFACTS / "regression-baseline-comparison.json").write_text(json.dumps({"baseline": baseline, "current": current, "newFailures": []}, indent=2) + "\n")
    backend = next(json.loads(line) for line in read("backend-history.log").splitlines() if line.startswith('{"status":'))
    require(backend["status"] == "passed" and backend["replayedJobs"] == 194, "Historical server replay is incomplete.")
    browsers = browser_results()
    capture = load("historical-capture.json")
    require(hashlib.sha256((ROOT / "test/fixtures/driver-upload-history.json").read_bytes()).hexdigest() == capture["fixtureSha256"], "The frozen historical fixture changed.")
    source_start = load("final-source-start.json")
    source_end = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_start}
    require(source_start == source_end, "Implementation changed during final verification.")
    source_hash = hashlib.sha256(json.dumps(source_end, sort_keys=True).encode()).hexdigest()
    for name in ["final-docker-ps.txt", "final-docker-ps-a.txt"]:
        require(not re.search(r"^mbbs-driver-upload-", read(name), re.M), "An upload test container remains.")
    health = read("final-production-health.txt")
    require(len(health.splitlines()) == 4 and all(line.endswith((" healthy", " running")) for line in health.splitlines()), "Production health check failed.")
    versions = {name: json.loads((ARTIFACTS / f"toolchain/node_modules/{name}/package.json").read_text())["version"]
                for name in ["@playwright/test", "fast-check", "c8", "eslint", "typescript"]}
    tree = {"implementationSha256": source_hash, "implementationFiles": source_end, "toolVersions": versions,
            "gitHead": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()}
    (ARTIFACTS / "source-tree.json").write_text(json.dumps(tree, indent=2) + "\n")
    summary = {"generatedAt": datetime.now(timezone.utc).isoformat(), "notDeployed": True, "source": tree,
               "unit": unit, "http": http, "coverage": coverage["total"], "failureRepositoryCoverage": repository_coverage,
               "mutantsKilled": len(mutants), "regressions": current, "types": type_report,
               "capture": capture, "backend": backend, "browsers": browsers, "productionHealth": health.splitlines()}
    (ARTIFACTS / "final-evidence.json").write_text(json.dumps(summary, indent=2) + "\n")
    days = "\n".join(f"| {day} | {value['jobRecords']} | {value['drivers']} | {value['plans']} |" for day, value in capture["byDate"].items())
    browser_rows = "\n".join(f"| {project} | {value['passed']} | {value['historicalRoutes']} | {value['logicalJobs']} | {value['photos']} |" for project, value in browsers["byProject"].items())
    failures = "\n".join(f"- {name}" for name in current["failedTests"])
    report = f"""# Driver PWA upload reliability — local evidence

Implemented locally on October 13, 2026. Not deployed; migration 282 was applied only to disposable test databases.
The approved [specification](driver-upload-reliability-spec.md) is implemented. Implementation SHA-256: `{source_hash}`.

## Investigation and resulting behavior

The baseline upload flow could wait indefinitely for upload authorization, storage, or a response body. This was reproduced with a stalled network boundary. Aurther's prior pickup saved two photo references at 07:12:38 Toronto time; the next drop started at 07:13:30 and completed at 08:13:35. That timeline does not identify the failed network operation: the original failure reason was not retained.

The PWA now shows measured current-photo progress and a byte-weighted overall percentage. Sending all bytes displays “Waiting for confirmation”; saving is a separate phase. Authorization receives 60 seconds, transfer receives its own size-based 90-second to six-minute budget, and saving receives 120 seconds. Failed attempts retain selected photos and confirmed references. A lost completion response is checked against server history before another write. Network errors retain the flag used by existing offline recovery.

Authenticated failure records persist in `delivery_audit_log` with action `driver.photo_upload.failed`, driver/device/session identity, stage, job/photo, attempt, timestamps, byte counts, percentage, duration, status, code, version and safe reason. Messages redact credentials and image data. The local queue keeps at most 100 records, reports overflow, survives disconnection, partitions by identity, and deduplicates acknowledged retries. Storage-quota denial retains an in-memory fallback. Assets use `20261013-driver-upload-v1` and shell cache v45; the logical client protocol stays unchanged.

## Fresh validation

| Layer | Result |
| --- | --- |
| Unit, property and asset contracts | {unit['pass']}/{unit['tests']} passed; 700 seeded property examples |
| Real HTTP/database audit checks | {http['pass']}/{http['tests']} passed; 8 simultaneous retries produced exactly one immutable audit entry |
| New upload module and diagnostic validator | {coverage['total']['lines']['covered']}/{coverage['total']['lines']['total']} lines executed; {coverage['total']['branches']['pct']}% branches |
| Failure persistence repository | {repository_coverage['lines']['covered']}/{repository_coverage['lines']['total']} lines executed |
| Targeted mutations | {len(mutants)}/{len(mutants)} killed; both progress mutations also killed by properties alone |
| Syntax, focused lint, diagnostic types | Passed, zero warnings/errors |
| Existing Driver regression files | {current['files']} files; {current['counts']['pass']}/{current['counts']['tests']} tests passed; zero NEW failures |
| Repository types | {type_report['currentDiagnostics']} existing diagnostics ({type_report['distinctDiagnostics']} distinct); zero NEW diagnostics |
| Secret scan | Passed; no dependencies or lockfiles added |
| Historical server replay | {backend['replayedJobs']} records, {backend['replayedPhysicalVisits']} physical visits, {backend['consolidatedPhysicalVisits']} consolidated visits; retry preserved photo evidence |
| Mobile browser execution | {browsers['passed']}/{browsers['passed']} passed with no retries |

All ten mutants were also run against the property suite alone. The eight non-math mutations survived that narrower suite and were killed by the unit/contract tests; properties establish progress invariants, not the other behaviors.

| Browser | Passed | Historical driver routes | Logical jobs completed | Fixture photos |
| --- | --- | --- | --- | --- |
{browser_rows}

## Seven-day snapshot

Source dates are October 7–13, 2026 in America/Toronto. Read-only capture: `{capture['capturedAt']}`; SHA-256 `{capture['fixtureSha256']}`. Six source drivers and six confirmed plans are represented. Today's snapshot is partial. October 11 has an empty confirmed plan; October 12 has no plan or job records to replay.

| Source date | Captured job records | Drivers with records | Confirmed plans |
| --- | --- | --- | --- |
{days}

The server corpus replays all 194 captured records, including incomplete records. Browser cases execute all 20 assigned driver/day routes from the captured plans, which can include additional planned work beyond the captured job records. Each browser also checks visible progress, HTTP rejection, connection loss, partial retry and a lost completion response.

## Behavior-to-test mapping

- Percentages, unknown lengths, independent deadlines, cancellation, storage confirmation, HTTP/network errors, queue bounds/ownership/denial/redaction: `test/mbt/unit/driver-upload-reliability.test.js` and `test/mbt/property/driver-upload-progress.test.js`.
- Logout isolation, retained BIN slots, pre/post DVIR reconciliation, signature failure, explicit safe retry and progress rendering: `test/mbt/unit/driver-upload-lifecycle.test.js`.
- Stalled API response body, invalid successful response and preserved auth/version/device headers: `test/mbt/unit/driver-upload-request.test.js`.
- Bounded hostile diagnostics: `test/mbt/unit/driver-upload-failure.test.js`; authenticated persistence, revocation, concurrent deduplication, immutable retries and body-size rejection: `test/mbt/integration/driver-upload-failure-http.test.js`.
- Visible current/overall percentages, retained previews, retry skipping and lost-response recovery: `test/driver-upload/faults.spec.js` against the actual isolated application.
- Whole historical routes, truck switch, persisted evidence, reload recovery and route advancement: `test/driver-upload/historical.spec.js` plus `src/driver-seven-day-replay-harness.js`.
- HTML/module/cache/worker consistency: `test/mbt/unit/driver-pwa-recovery-assets.test.js`. Its version expectations were advanced to the approved new assets while retaining every consistency assertion and adding module load order.

## Existing failures and limits

The following regression failures also occur with the original source. They assert older hard-coded cache/asset generations (v41/v43) against the original v44 shell. They remain unchanged:

{failures}

Repository type errors also match the original source, including duplicate occurrences. The whole unrelated MBBS suite was not run; all existing Driver test files in unit/property/integration/adversarial/concurrency groups were run. Line coverage above applies to the new upload/diagnostic modules and repository; it is not a claim of full coverage for the legacy Driver or entire server.

The historical fixture contains no real photos or credentials. Tests use JPEG fixtures and an isolated R2 contract server, with Samsara/customer writes disabled. Direct-pickup dependencies are reconstructed from captured manifests, not a historical dependency-event timeline. Source dates are retained in reports while routes run on the current isolated company day; only the test countdown is accelerated. Browser execution uses Chromium/WebKit with mobile profiles, not physical phones. Service workers are blocked for operational replay; atomic shell wiring is verified separately. This does not validate live R2 availability, physical camera permissions or real cellular conditions. No historical logging can retroactively establish Aurther's original network cause.

Failures found during development were retained in the artifact logs: unbounded waits, incorrect floating-point percentage rounding, stale-screen completion recovery, lost diagnostics after storage quota denial, invalid durations after clock changes and lost network-error classification. Historical fixture IDs were shortened to satisfy the existing PWA limit; missing direct dependencies were seeded without weakening production guards. Four fixed fake test tokens were explicitly documented for the secret scanner; scan rules were unchanged.

## Reproduction and cleanup

Run from the repository root: `bash server/tools/driver-upload-verify-all.sh`.
The entry point runs every layer and generates this report. Existing locked dev dependencies are installed into the artifact toolchain only when absent. Recorded tool versions: `{json.dumps(versions, sort_keys=True)}`; Node 20.20.2, browser image `mbbs-to-yard-test-browser:20261009`. The original source snapshots needed for comparison are retained under `test-artifacts/driver-upload-reliability/baseline`; the dirty workspace was preserved and no commit was created.

Every test uses `mbbs-tests.slice` and bounded memory, CPU, PID and tmpfs settings. Cleanup is registered before containers start. Each Compose stack is removed with volumes/orphans; one-off containers use `--rm`. Both `docker ps` and `docker ps -a` confirm no task-owned test containers remain. Production app/database/Ollama are healthy and the webhook worker is running. Production, rollback data and operational audit records were outside cleanup.

Machine-readable results, exact source hashes, per-layer commands/logs, screenshots, browser traces and teardown evidence are retained in `server/test-artifacts/driver-upload-reliability/`, including `final-evidence.json`, `source-tree.json`, `regression-baseline-comparison.json`, `type-baseline-comparison.json`, `browser-report.json`, `mutations.json` and the final health/container lists.
"""
    (ROOT / "test/driver-upload-reliability-evidence.md").write_text(report)
    print(json.dumps({"unitPassed": unit["pass"], "httpPassed": http["pass"], "browserPassed": browsers["passed"],
                      "historicalRecords": backend["replayedJobs"], "mutantsKilled": len(mutants),
                      "newRegressionFailures": 0, "newTypeErrors": 0, "sourceSha256": source_hash, "notDeployed": True}))


if __name__ == "__main__":
    main()
