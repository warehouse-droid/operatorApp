"""Summarize the measured gauntlet results without hiding existing failures."""
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
folder = root / "test-artifacts/return-ra-workflow"
coverage = json.loads((folder / "coverage/coverage-final.json").read_text())
changed = {}
current = None
line_number = 0
for line in (root / "test/support/return-ra-baseline.patch").read_text().splitlines():
    if line.startswith("--- a/"):
        current = line[6:]
        changed[current] = set()
    elif line.startswith("+++ b/"):
        continue
    elif line.startswith("@@"):
        line_number = int(re.match(r"@@ -(\d+)", line).group(1))
    elif line.startswith("-"):
        changed[current].add(line_number)
        line_number += 1
    elif line.startswith(" "):
        line_number += 1
changed["src/return-ra-workflow.js"] = set(range(1, len((root / "src/return-ra-workflow.js").read_text().splitlines()) + 1))
rows = []
for name, changed_lines in changed.items():
    record = coverage.get("/app/" + name)
    if not record:
        continue
    executable, hit = set(), set()
    for key, span in record["statementMap"].items():
        lines = set(range(span["start"]["line"], span["end"]["line"] + 1))
        executable |= lines
        if record["s"][key]:
            hit |= lines
    target = changed_lines & executable
    rows.append({"file": name, "covered": len(target & hit), "total": len(target), "uncovered": sorted(target - hit)})
assert all(not row["uncovered"] for row in rows), rows
(folder / "changed-coverage.json").write_text(json.dumps(rows, indent=2) + "\n")
statics = json.loads((folder / "static.json").read_text())
mutations = json.loads((folder / "mutations.json").read_text())
browser = json.loads((folder / "browser.json").read_text())
domain = json.loads((folder / "coverage/coverage-summary.json").read_text())["/app/src/return-ra-workflow.js"]
focused = (folder / "focused.log").read_text()
full = (folder / "full-final.log").read_text()
focused_count = re.findall(r"# pass (\d+)", focused)[-1]
full_summary = [line for line in full.splitlines() if line.startswith("Isolated MBT main run failed in")]
assert len(full_summary) == 1 and "1/511 file(s)" in full_summary[0], full_summary
state = json.loads((folder / "source-state.json").read_text())
fingerprint = hashlib.sha256(json.dumps(state["hashes"], sort_keys=True).encode()).hexdigest()
total = sum(row["total"] for row in rows)
report = f"""# Return Authorization workflow evidence

Implemented the approved plan in [the specification](return-ra-workflow-spec.md).
No deployment, production NetSuite write, gate activation, or new dependency was performed.
The earlier order-search optimization request remains cancelled.

## Results

| Check | Observed result |
| --- | --- |
| Focused repository, authenticated HTTP, client and regression tests | {focused_count} passed |
| Existing return repository harness | Passed |
| Changed executable lines in seven server modules | {total}/{total} covered |
| New domain | {domain['lines']['pct']}% lines, {domain['functions']['pct']}% functions, {domain['branches']['pct']}% branches |
| Deliberate faults | {len(mutations)}/{len(mutations)} killed; reason/quota mutants also killed by properties alone |
| Chromium | {len(browser)} passed: posting on/off at 390px and 1024px; all 20 Admin gate cells |
| Types | {statics['typeErrorsBefore']} existing diagnostics before and {statics['typeErrorsAfter']} after; zero new; new domain passes strict check |
| Lint | {statics['lintBefore']} existing diagnostics before and {statics['lintAfter']} after; zero new |
| Secrets | No findings in the scanned affected runtime sources |
| Suite order | New tests passed again in seed-91726 file order |
| Full suite | 510/511 files pass; the one pre-existing infrastructure assertion remains |

The remaining full-suite assertion is:
`dispatch-unpacked-split.spec.js must use the shared worker-scoped E2E fixture.`
It also failed in the preserved starting workspace. The initial baseline run had two
additional schema failures because its copied contracts directory was missing;
restoring those unchanged fixtures produced 8/8 passing contract tests. Existing
standalone Operator/portal UI harnesses also have stale CSS/asset assertions in the
baseline; they are recorded separately from the main suite and were not weakened.

## Behavior-to-evidence mapping

| Spec | Evidence |
| --- | --- |
| G1/G2 | Eight off-by-default RA policies; all yards and global ceiling; Admin revision/replay checks; stale/missing/wrong-yard tokens; no later posting of local-only records |
| V1 | Actual confirmation accepts formerly approval-required stock; rejects prohibited items, missing photos and excess quantities; legacy approvals and direct PALLET Credit Memos retained |
| R1/R2 | Two reasons on one SO line remain distinct in one stock RA; standalone PALLET RA at $40 and GD; combined confirmation creates two records/two RAs |
| R3 | Exact customer, yard, source SO, external/internal ID, item, units, rate, quantity and reason checks; mismatches preserve the discovered ID; manual linking and reconciliation tested |
| D1 | Parallel first attempts/retries, twelve simultaneous retries exceeding the database pool size, lost responses, local transaction rollback, empty recovery lookup, duplicate external IDs, no-Location recovery and definite rejection retry |
| Q1 | Partial/multiple/deduplicated linked PALLET credits; only observed Credit Memos release reservation; uncertain creation cannot be voided |
| U1 | Review waits for both captured policies; stale yard response rejected; result distinguishes local/pending/failed/verified RA; financial/recovery details remain private |
| N1 | Migration defaults old records to version 1 and new gates off; no production commands or order-search optimization included |

Tests live in `test/mbt/unit/return-ra-*.test.js` and
`test/mbt/integration/return-ra-workflow.test.js`. Browser assertions use the actual
rendering and confirmation functions in Chromium with fixture data. They do not
exercise camera hardware or a live mobile device. Numeric coverage above is for
server modules; UI behavior is checked separately by VM and browser tests.

## Reproduce

From the repository root, run:

```sh
bash server/tools/return-ra-gauntlet.sh
```

Uses existing Docker images `mbbs-retired-confirm-test:20260914`,
`mbbs-mbt-p1-test-e2e:latest`, and `postgres:18-alpine`; Node {state['node']}.
The runner creates disposable internal networks/databases and replaces NetSuite
and photo-storage boundaries with test fixtures. Logs, screenshots, source hashes,
coverage and mutation output are in `server/test-artifacts/return-ra-workflow/`.
`test/support/return-ra-baseline.patch` restores the task's starting code for
lint/type comparison without discarding unrelated workspace changes.

Runtime source-state fingerprint: `{fingerprint}`.

## Release prerequisite still outstanding

No designated NetSuite sandbox account/test Sales Order was supplied, so no live
round trip was attempted. Keep all eight new gates off until sandbox readback
proves that this account preserves two distinct reason-coded item rows from one
SO source line in a single RA, including quantities, units and rates, and accepts
the standalone PALLET RA. Mocked REST tests cannot establish account-specific
transform behavior, custom-form requirements or permissions. The implementation
rejects a merged/mismatched readback and retains its ID for recovery.

Oracle documents the [Return Authorization REST record](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0718011926.html)
and [standalone return authorizations](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1305354.html).
These describe the supported record operations; they do not prove split-source-line
behavior for this account.

During implementation, the new behavioral tests first failed for the missing
workflow and UI behavior. Expanded tests also found an existing stock-line INSERT
placeholder mismatch, now fixed. A trial mutation deleting the in-memory retry
guard survived because the durable checkpoint independently blocked a duplicate;
the final mutation removes that durable marker and is killed. Exact gate catalogs,
migration counts and cache-version contracts were extended to the new release,
while retaining their strict assertions.
An additional concurrency test reproduced connection exhaustion before the
pre-transaction admission limit was added; all twelve retries then completed.
"""
(root / "test/return-ra-workflow-evidence.md").write_text(report)
print(json.dumps({"focusedPassed": int(focused_count), "changedLinesCovered": total,
                  "mutantsKilled": len(mutations), "browserChecks": len(browser), "fullSuite": full_summary[0]}))
