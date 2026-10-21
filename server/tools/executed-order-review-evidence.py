#!/usr/bin/env python3
"""Verify final logs against the pre-change capture; never contacts production."""
import collections
import hashlib
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
artifact = root / "test-artifacts/executed-order-review"
baseline = Path(sys.argv[1]).resolve()
manifest = json.loads((root / "tools/executed-order-review-files.json").read_text())


def read(name):
    return (artifact / name).read_text()


def failures(log):
    assert re.search(r"Isolated Dispatch save adjacent run (?:passed|failed)", log), "Adjacent suite did not finish"
    return sorted(set(re.sub(r" \([\d.]+ms\)$", "", line[2:])
                      for line in log.splitlines() if line.startswith("✖ ") and line != "✖ failing tests:"))


def lint_counts(name):
    return collections.Counter((entry["filePath"].replace("/app/", ""), message.get("ruleId"), message["severity"], re.sub(r"on line \d+ column \d+", "at the outer declaration", message["message"]))
                               for entry in json.loads(read(name)) for message in entry["messages"])


for name in ["focused-final.log", "random-final.log"]:
    assert "Isolated Executed source review run passed:" in read(name), name
old_failures = failures(read("adjacent-baseline-final.log"))
new_failures = failures(read("adjacent-current-final.log"))
assert not set(new_failures) - set(old_failures), f"New adjacent test failures: {set(new_failures) - set(old_failures)}"
types_before = collections.Counter(read("types-baseline-final.log").splitlines())
types_after = collections.Counter(read("types-current-final.log").splitlines())
assert not types_after - types_before, "New TypeScript diagnostics"
lint_before = lint_counts("lint-baseline-final.log")
lint_after = lint_counts("lint-current-final.log")
assert not lint_after - lint_before, f"New lint diagnostics: {lint_after - lint_before}"
mutations = json.loads(read("mutations.json"))
assert len(mutations) == 7 and all(result["killed"] for result in mutations)
assert all(result["propertyKilled"] for result in mutations if result["propertyKilled"] is not None)
coverage = json.loads((artifact / "coverage/coverage-summary.json").read_text())
assert coverage["total"]["lines"]["pct"] == 100, "Unexecuted lines in new feature modules"

files = manifest["production"] + manifest["tests"] + sorted(str(file.relative_to(root)) for file in (root / "tools").glob("executed-order-review*"))
hashes = {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in files}
secret_patterns = [r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", r"\bAKIA[A-Z0-9]{16}\b", r"\bsk-(?:live|proj)-[A-Za-z0-9_-]{24,}"]
secret_hits = []
for file in files:
    # Compare changed lines for existing files; fixture-only disposable passwords are not credentials.
    old_lines = set((baseline / file).read_text().splitlines()) if (baseline / file).exists() else set()
    added = "\n".join(line for line in (root / file).read_text().splitlines() if line not in old_lines)
    if any(re.search(pattern, added) for pattern in secret_patterns):
        secret_hits.append(file)
assert not secret_hits, f"Potential secrets in changed files: {secret_hits}"
summary = {
    "sourceTreeSha256": hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
    "sourceFiles": hashes,
    "gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "versions": json.loads(read("versions-final.json")),
    "image": read("image-final.txt").strip(),
    "focused": read("focused-final.log").strip().splitlines()[-1],
    "randomized": read("random-final.log").strip().splitlines()[-1],
    "adjacentBaseline": read("adjacent-baseline-final.log").strip().splitlines()[-1],
    "adjacentCurrent": read("adjacent-current-final.log").strip().splitlines()[-1],
    "preexistingFailedTestNames": old_failures,
    "newFailedTestNames": sorted(set(new_failures) - set(old_failures)),
    "typeDiagnostics": {"baseline": sum(types_before.values()), "current": sum(types_after.values()), "new": 0},
    "lintDiagnostics": {"baseline": sum(lint_before.values()), "current": sum(lint_after.values()), "new": 0},
    "coverageNewModules": coverage["total"],
    "mutationsKilled": len(mutations),
    "propertyMutantsKilled": sum(result["propertyKilled"] is True for result in mutations),
    "secretScanHits": secret_hits,
    "limits": [
        "Spec approval not obtained: autonomous run.",
        "Coverage measures the four new domain/repository/address modules; legacy wiring and the browser are covered by functional/contract tests, without a complete changed-line coverage measurement.",
        "Branch coverage is reported separately; .c8rc.json thresholds target src/mbt and were not used as a feature branch gate.",
        "Existing TypeScript/lint errors remain; the repository TypeScript configuration does not type-check every JavaScript file.",
        "Complexity was reviewed manually; the existing Dispatch lint profile does not define a numeric complexity gate.",
        "Pre-change source capture is required to reproduce comparisons in this already dirty workspace.",
        "No new dependencies. Secret scanning uses explicit credential patterns, not a full external scanner.",
        "Tests use the real local order mirror schema and isolated HTTP/browser execution; no live NetSuite writes or full production load benchmark.",
        "No production deployment performed by the test runner."
    ]
}
(artifact / "evidence-final.json").write_text(json.dumps(summary, indent=2) + "\n")
report = f"""# Executed source updates: verification evidence

Spec approval: not obtained (autonomous run). Tier 3. This report verifies the requested behavior within the scenarios below; it is not a claim that every production scenario is covered.

Verified source changes no longer require acknowledgement before saving Dispatch work. A separate persistent warning explains what changed and records the dispatcher's explicit confirmation of that source version. The submitted refresh is reconciled to the recorded execution snapshot; the authoritative source order stays updated. Manual removal, reordering, reassignment and unverified cargo changes retain the prefix lock.

GOA-8930-8931 and SOA08930 keep their valid address when a refresh/draft contains blanks. Explicit blank edits fail in the browser and API. TOB01111 warns about the removed PER-MM80S-2237-SCG line (326.48 SQFT), PALLET quantity 29 → 25 EACH, and separately labelled calculated pallet changes. The warning does not claim the dispatcher made the source edit or that it happened after execution.

## Final run

- {summary['focused']}
- {summary['randomized']}
- New broader-suite failures: {len(summary['newFailedTestNames'])}. See the exact baseline/current summaries and failed test names in `test-artifacts/executed-order-review/evidence-final.json`.
- New lint/type diagnostics: 0 / 0. Existing diagnostics remain (lint: {summary['lintDiagnostics']['current']}; TypeScript output lines: {summary['typeDiagnostics']['current']}).
- Four new feature modules: {coverage['total']['lines']['covered']}/{coverage['total']['lines']['total']} lines executed; {coverage['total']['branches']['pct']}% branches; {coverage['total']['functions']['pct']}% functions.
- Deliberate regressions detected: 7/7. The property suite alone detected all 5 applicable domain/address mutants.
- Credential-pattern scan: 0 hits. No dependencies added. Docker image: `{summary['image']}`.
- Source tree SHA-256: `{summary['sourceTreeSha256']}`. All file hashes and tool versions are in the machine-readable report. Existing workspace changes were preserved; no commit or staging was performed.

## Scenarios and evidence

| Requirement / failure mode | Executable evidence |
| --- | --- |
| TOB01111 line removal, quantity/derived-total warnings | `test/dispatch/unit/dispatch-executed-order-review.test.js`; exact minimized incident fixture/test |
| GOA-8930-8931 nested blank address, immutable/idempotent refresh | Domain unit/property tests; existing split-address, stale-address and grouped-action suites |
| Save before confirmation, keeping job records and stops | `test/dispatch/integration/dispatch-executed-order-review.test.js`: actual HTTP PUT, V2 command save, snapshot restore |
| Source address/yard copied directly to an executed stop | Domain source-stop regression and command/restore integration scenario |
| Warning survives save/reload, newer update needs another confirmation | Persistent-ledger integration tests and source-version properties |
| Authentication, edit lease, invalid/stale tokens, concurrent acknowledgement | HTTP and adversarial integration cases; concurrent attempts produce one audit entry |
| Driver prefix still protected | Existing prefix unit, contract, property, adversarial, integration and concurrency suites; forged cargo/source properties |
| Browser warning, nonblocking save, explicit confirmation, blank form, HTML escaping | `test/dispatch/frontend/dispatch-executed-order-review.browser.test.mjs`, full Dispatch script in Chromium |
| Atomic migration rollback | Review-table drop/reapply within a rolled-back transaction in the disposable database; original observations recovered exactly |
| Real incident replay | `tools/executed-order-review-replay.mjs` plus `test/dispatch/fixtures/executed-order-incidents.json` |

The isolated Docker network has a fresh PostgreSQL database and does not load a production environment file. Integration tests seed executed driver work, modify the local NetSuite mirror, and exercise the real application/repositories. This simulates data after NetSuite ingestion; incoming webhook delivery is not replayed. The browser uses mocked network boundaries and the actual frontend implementation.

## Reproduce

Run `bash server/tools/executed-order-review-gauntlet.sh` from the repository. `EXECUTION_REVIEW_BASELINE` may select the pre-change source capture. The default capture is under `server/test-artifacts/executed-order-review/baseline`; a clean commit cannot represent that initially dirty workspace. The runner creates and removes disposable internal Docker networks/databases and requires the recorded local test image. Runtime versions are recorded in `versions-final.json`.

## Failures found and limits

Initial tests exposed missing source-review behavior; the user's clarification replaced the initial acknowledgement save gate with an independently persisted review. Further tests found grouped PO reset handling, legacy aliases, stop-level source refresh cases, and PO pickup metadata that must remain separate from delivery data. These were fixed without removing the prefix-lock assertions. The source-stop RED run had 14 passes and 1 assertion failure before implementation; the PO pickup regression had 15 passes and 1 assertion failure before its fix. One integration fixture initially changed a TO dispatch override that did not change its canonical destination; it was corrected to update the actual mirrored destination and now explicitly asserts that the source address changes. The first migration attempt used a bigint actor key; it was corrected to match the existing text operator ID before release.

The first coverage command inherited the unrelated `src/mbt` branch threshold and failed despite passing tests. The final feature command explicitly reports branches separately and gates 100% line execution for its four new modules. An intermediate report overlapped the last implementation edit and was discarded; the affected suites, coverage and mutations were repeated on the final source. Full changed-line coverage across the existing application files and browser was not measured. These paths have functional/contract tests. JavaScript outside the repository TypeScript configuration is not fully type-checked. Complexity review was manual under the existing Dispatch lint profile. Secret scanning uses explicit patterns; no external vulnerability/license audit was needed because dependencies did not change. There was no production-sized latency benchmark or live NetSuite write.

## Release state

The feature is implemented and tested in the workspace. It has not been deployed to the live application. Release requires migration `212_dispatch_executed_order_reviews.sql` before the new app code starts. The runtime file list is `tools/executed-order-review-files.json`; the scoped patch is `test-artifacts/executed-order-review/review.patch`. Existing changed runtime files were compared with the captured production baseline. A rollback to the previous app image can retain the additive review table and its acknowledgements.
"""
(root / "test/dispatch-executed-order-review-evidence.md").write_text(report)
with tarfile.open(artifact / "release-overlay.tar.gz", "w:gz") as archive:
    for file in manifest["production"]:
        archive.add(root / file, arcname=f"app/{file}")
    archive.add(artifact / "evidence-final.json", arcname="evidence.json")
    archive.add(root / "test/dispatch-executed-order-review-evidence.md", arcname="EVIDENCE.md")
    archive.add(root / "tools/executed-order-review-files.json", arcname="files.json")
    archive.add(artifact / "production-baseline.json", arcname="production-baseline.json")
print(json.dumps({key: value for key, value in summary.items() if key != "sourceFiles"}, indent=2))
