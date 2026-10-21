"""Collect the current-source notice checks without changing application data."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("checks")
parser.add_argument("coverage")
parser.add_argument("log")
args = parser.parse_args()
server = Path(__file__).resolve().parent.parent
artifact = server / "test-artifacts/executed-review-active-lines"
checks = Path(args.checks)
coverage_root = Path(args.coverage)
log = Path(args.log).read_text()
suites = json.loads((checks / "suites.json").read_text())
hashes = json.loads((checks / "source-hashes.json").read_text())
assert hashes == json.loads((coverage_root / "source-hashes.json").read_text())
for name, digest in hashes.items():
    assert hashlib.sha256((server / name).read_bytes()).hexdigest() == digest, name
assert suites["current"]["failures"] == suites["baseline"]["failures"]
assert "Active lines and re-plan mutations killed: 8/8" in log
static = next(json.loads(line) for line in log.splitlines() if line.startswith('{"static":'))
assert static["static"] == "no new diagnostics"
coverage = json.loads((coverage_root / "coverage/coverage-final.json").read_text())
changed = []
for name in ["src/dispatch-repository.js", "src/dispatch-executed-order-review-repository.js",
             "src/dispatch-executed-order-review.js", "public/dispatch.js"]:
    old = (artifact / "baseline" / Path(name).name).read_text().splitlines()
    current = (server / name).read_text().splitlines()
    added = {line + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old, b=current).get_opcodes()
             if tag in ("insert", "replace") for line in range(start, end)}
    data = next(value for key, value in coverage.items() if key.endswith("/" + name))
    executable = {line for item in data["statementMap"].values()
                  for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    hit = {line for key, item in data["statementMap"].items() if data["s"][key] > 0
           for line in range(item["start"]["line"], item["end"]["line"] + 1)}
    relevant = added & executable
    assert relevant <= hit, (name, sorted(relevant - hit))
    changed.append({"file": name, "covered": len(relevant & hit), "total": len(relevant)})
report = {"suites": suites, "mutationsKilled": 8, "mutationsTotal": 8, "static": static,
          "changedLineCoverage": changed, "sourceHashes": hashes,
          "artifacts": {"checks": str(checks), "coverage": str(coverage_root), "log": args.log}}
(artifact / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
total = sum(row["total"] for row in changed)
counts = suites["current"]
failures = "\n".join("- " + name for name in counts["failures"])
evidence = f'''# Current source notices and re-plan requests

Spec approval: not obtained for the initial fix (autonomous run). The user explicitly selected dispatcher review and re-plan, rather than automatic recalculation. See [the specification](dispatch-executed-review-active-lines-spec.md).

The source-review lookup now excludes inactive historical sales lines while historical order search retains its existing behavior. Real differences on assigned physical stops generate a persistent notice, including before driver activity starts. Remaining work is labelled “re-plan requested”; fully executed work remains a review notice. Source syncing and valid planning saves do not depend on acknowledgement. Executed comparison/reconciliation still uses only executed contexts.

## Verification

- Final randomized adjacent suite: {counts['tests']} tests, {counts['passed']} passed, {counts['failed']} pre-existing failures; zero new failures against the captured baseline. Shuffle seed: 28092026.
- Focused coverage run: 21 tests passed, including actual HTTP/browser behavior and a real webhook update while a prior notice remains pending.
- Changed executable lines: {total}/{total} executed. Branch coverage is available in the raw coverage artifact; this is not a claim of exhaustive branch coverage.
- Deliberate regressions: 8/8 caught, including the property suite catching a missing re-plan flag. The new property runs 80 generated assignment/execution/quantity cases.
- Static checks: zero new diagnostics; {static['existingLint']} existing lint diagnostics and {static['existingTypeDiagnostics']} existing type diagnostics. New test/check files are lint-clean. Baseline type output can compile duplicate copies through existing absolute imports; comparison deduplicates identical file/line/message blocks after normalizing the temporary checkout prefix.
- No dependencies, database schema, execution records, or acknowledgement data were changed. No production deployment was performed.

The live read-only replay of SOA09413 returned 3 active lines, salesQty 1426.64 and weight 50321.73, with no corrected notice. The former historical lookup returned 8 lines, salesQty 1490.315 and weight 54294.14. All five alleged additions were inactive rows. The latest retained webhook source-modified timestamp was 2026-09-27 18:36 UTC. The existing acknowledgement remains stored.

## Scenario mapping

| Scenario | Evidence |
| --- | --- |
| Exact false additions and inflated totals | `dispatch-executed-review-active-lines.test.js`: SOA09413 regression; read-only live replay |
| Historical cargo still available | Current-source lookup test and existing fulfilled-SO planning suites |
| Real additions, removals and quantity changes | Combined change regression and stable-token assertion |
| Old pending/acknowledged false notices disappear without deleting evidence | Both stored-observation regressions |
| Planned, partly executed, fully executed and unassigned work | New integration scenarios and 80 generated property cases |
| Source processing and saving continue | Actual webhook test, executed-prefix comparison, existing HTTP command/restore tests and Chromium save-before-confirmation test |
| Re-plan wording and immediate refresh | New frontend function tests; the unchanged full frontend runs in Chromium |
| Lease, concurrency, preserved jobs/photos and route locks | Existing review and executed-prefix integration/concurrency suites |

## Reproduce and limits

Run `bash tools/executed-review-active-lines-gauntlet.sh` from `server`. Add `--live` to repeat the read-only production replay; that mode requires the original incident and unchanged live baseline modules. The task patch reconstructs the captured baseline if its artifact folder is missing. Test image: `mbbs-bin-planning-test:20260927`; tool versions and source hashes are recorded under `test-artifacts/executed-review-active-lines`.

Pre-existing failures were retained without weakening assertions:

{failures}

Initial new regressions failed for all five inactive-line cases and both new re-plan scenarios before implementation. The first baseline comparison lacked the migration directory in its temporary copy; the runner was corrected. Static checking found and fixed two test-variable shadowing warnings. No new performance benchmark was added: the existing indexed, batched source lookup now includes all assigned order refs. Metadata outside the existing cargo/location comparison is not newly classified as a planning change. No deployment/rollback rehearsal or dependency/license audit was necessary for this local, dependency-free correction.
'''
(server / "test/dispatch-executed-review-active-lines-evidence.md").write_text(evidence)
print(json.dumps({"tests": counts, "changedLines": total, "mutations": "8/8", "static": static}, indent=2))
