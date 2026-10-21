"""Summarize recorded checks and operational results."""
import hashlib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / "test-artifacts/split-draft-identity-20261020"
RELEASE = SERVER / "deployments/split-draft-identity-20261020"
read = lambda base, name: json.loads((base / name).read_text())
final, health = [read(OUT, mode + ".json") for mode in ["final", "health"]]
static, mutations = [read(OUT, name + ".json") for name in ["static", "mutations"]]
published = read(RELEASE, "published.json")
live = read(RELEASE, "live-apply.json")
verified = read(RELEASE, "live-verify.json")
assert final["tests"] == final["pass"] == health["tests"] == health["pass"] == 149
assert final["fail"] == health["fail"] == 0
assert live["verified"]["quantities"] == verified["quantities"]
assert live["retainedHash"] == verified["retainedHash"]
assert live["retainedBefore"] == live["retainedAfter"]
source_hash = hashlib.sha256((TASK / "candidate/public/dispatch.js").read_bytes()).hexdigest()
assert mutations["sourceHash"] == source_hash
summary = {
    "specApproval": "not obtained (autonomous run)",
    "tests": final["tests"], "pass": final["pass"], "fail": final["fail"],
    "reverseFileOrder": {"tests": health["tests"], "pass": health["pass"], "fail": health["fail"]},
    "changedLineCoverage": mutations["changedLineCoverage"],
    "mutationsKilled": sum(row["killed"] for row in mutations["mutations"]),
    "mutationsTotal": len(mutations["mutations"]),
    "propertyOnlyKilled": sum(row["propertyOnly"]["killed"] for row in mutations["mutations"]),
    "static": static, "sourceHash": source_hash,
    "published": published,
    "live": {"quantities": verified["quantities"], "familyTotal": verified["familyTotal"],
             "retiredSource": verified["retiredSource"], "retainedHash": verified["retainedHash"],
             "auditCount": len(verified["audits"])},
    "limitations": [
        "The complete application's test suite was not run; scope is dispatch split, resplit, unsplit, quantity, refresh and history behavior.",
        "2916 existing browser-script type diagnostics remain identical; the patch adds none.",
        "Properties exercise camelCase transaction IDs and conservation; explicit tests cover snake_case IDs and row-only fallback. Those two mutants survive the property-only subset but fail the complete focused suite.",
        "Browser tests use fixture network boundaries; separate integration tests execute real database/service/HTTP paths in disposable PostgreSQL.",
        "No independent human review of the specification was obtained."
    ],
    "resolvedFailures": [
        "Captured live code failed five identity tests, including the exact nonnegative-quantity browser error.",
        "The first candidate run passed 148/149 tests; the browser fixture lacked the v2 save endpoint. Added the network boundary response without changing assertions; all 149 then passed.",
    ]
}
(OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
report = f"""# Split draft identity correction

The form now retains quantities across a refresh that changes only a local
row ID. The transaction line ID takes precedence; row fallback is preserved.
The deployed patch changes one JavaScript line and the asset version.

SOA09140-S4 was replaced through the guarded resplit service with S5
(2,232 SQFT) and S6 (2,356 SQFT). S1 (1,860) and S3 (1,984), their native
lines, groups, PO allocations, driver records and stored routes were
verified unchanged. The active family totals 8,432 SQFT. One resplit audit
was recorded. There were no active plan editors when the transaction ran.

Spec approval: not obtained (autonomous run).

Evidence:

- RED: 5/6 focused checks failed on the captured live code.
- Final: {final['pass']}/{final['tests']} passed; no failures or skips.
- Reversed file order: {health['pass']}/{health['tests']} passed.
- Changed executable lines: 1/1 exercised in Chromium.
- Manual mutants: 4/4 killed by the focused suite; properties alone kill
  2/4 (the other two require the explicit alias/fallback scenarios).
- Type diagnostics: {static['baselineTypeErrors']} before and
  {static['currentTypeErrors']} after; zero new diagnostics.
- Lint: zero new diagnostics; both new test files clean.
- No dependencies, schema changes or unrelated deployed source changes.
- Test containers, disposable volumes and networks removed after every run.
- Production health and served asset hashes verified after deployment.

Source SHA-256: `{source_hash}`.

Spec mapping: acceptance 1–5 map to the identity VM/property/browser tests
and existing quantity tests; acceptance 6 maps to resplit/history/HTTP
tests plus the guarded live transaction; acceptance 7 maps to the image
tree and runtime hash checks; acceptance 8 maps to the before/after
operational evidence in this directory.

Reproduce automated checks:
`python3 server/tools/split-draft-identity-20261020/verify.py`

The operational apply script is deliberately separate and must not be
rerun as a test. Logs, screenshots, coverage and the detailed limitations
are in `server/test-artifacts/split-draft-identity-20261020/summary.json`.
"""
(RELEASE / "EVIDENCE.md").write_text(report)
print(json.dumps({"tests": final["tests"], "pass": final["pass"], "live": summary["live"]}))
