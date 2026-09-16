# SN1400625 receiving: deleted parent rows

Spec approval: not obtained (autonomous run). Tier 3: inventory line identity.
Specification: [sn1400625-receiving-spec.md](sn1400625-receiving-spec.md).

## Finding and correction

SN1400625 / -81664606940713 is a local split of POB03669 / 939701. Its ledger
contains keys 4737066, 4851526, 4851527 and 4851536. Key **4851525** belongs
to retained parent history, with `netsuite_active=false` and
`sync_exception=line_deleted`; it does not belong to this shipment.

The deployed resolver reads the parent's inventory rows to map local identities
and explicitly deselect other open NetSuite lines. That query included retired
history and required every returned row to map to a current NetSuite line.
The read-only reproduction failed with the exact reported error before creating
a posting command. Current NetSuite evidence contains 15 lines; five retained
local deleted keys are absent: 4851525, 4851528, 4851529, 4851531, 4851535.

The correction adds `COALESCE(line.netsuite_active, true) = true` to the PO
source-row query. Existing selected-split ledger validation and live identity
checks still execute. No source row, split ledger, operator confirmation,
quantity or receipt record is edited. The scoped patch is
[sn1400625-receiving.changes.patch](sn1400625-receiving.changes.patch); it also
contains an inconsequential indentation change on the preceding SQL line.

## Observed execution

The candidate ran in memory inside the deployed app at
**2026-09-16 14:24:31 UTC**, with fresh NetSuite read APIs and a PostgreSQL
`REPEATABLE READ, READ ONLY` transaction. It produced this draft:

| Parent REST line | Receipt quantity | Selection |
| --- | ---: | --- |
| 1 | 360 | Receive |
| 24 | 360 | Receive |
| 25 | 288 | Receive |
| 6, 7, 34 | — | Explicitly deselected |

Parent: POB03669 / 939701. Memo and PO reference: SN1400625. Completed lines
remain excluded under the existing receipt policy. No receipt was submitted.
Production still runs the prior resolver; this work has not been deployed.

## Acceptance mapping

| Spec | Executed evidence |
| --- | --- |
| 1: exact incident mapping, quantities, memo and deselections | SQL-backed incident test; live replay through actual target resolver and draft builder |
| 2: retain required active, closed and completed validation | Missing-active example and property covering selected/unselected keys, including completed line 63 |
| 3: inactive selected sources and ambiguous identities reject | Inactive-source example/property, duplicate-live example, existing target/adversarial contracts |
| 4: native/split scope, exact source IDs and sparse line numbers | Native/split property and incident draft assertions; scoped diff retains the source-order predicates |
| 5: generated retired history and unchanged posting safeguards | 60 seeded PostgreSQL property cases, existing admission/service/adapter/property contracts, full-suite comparison |
| No production mutation, dependencies, migrations or API changes | Explicit read-only replay; scoped one-condition runtime diff; no dependency or migration files changed by this task |

## Verification

The RED run failed 4 of 6 new tests. The incident test emitted the exact original
4851525 error. It also exposed that a selected source marked inactive could
still pass when live NetSuite retained its identity. Assertions were unchanged
when the query filter was added; all 6 then passed.

- Focused receipt/posting suite: **77 passed, 0 failed, 0 skipped**.
- All 10 focused files also passed in a deterministic shuffled process order.
- Generated SQL cases: **60** per property run, seeds 1400625–1400627.
- Functional changed SQL line coverage: **1/1**, exercised 126 times. The
  adjacent whitespace-only change introduces no additional executable branch.
  SQL inclusion/exclusion behavior is checked against actual PostgreSQL.
- Four deliberate bugs were rejected by the focused tests and independently by
  the property tests: **4/4 + 4/4**. They include retired rows, exclude active
  rows, bypass active identity checks, or bypass split-source ledger checks.
- ESLint: **0 errors/warnings** on the runtime, new tests and JavaScript runner.
- TypeScript: **233 baseline errors, 233 candidate errors; no new diagnostics**.
- Python helpers and shell entry point passed syntax checks; scoped diff passed
  whitespace checks. JavaScript source/verification files passed the repository
  secret scanner. No new runtime capabilities or dependencies were introduced.
- Full-suite comparison: **2,532 passed, 7 failed, 1 skipped** across 500 files.
  The captured baseline has 2,526 passed, 7 failed and 1 skipped across 499
  files. Failing test names and counts match exactly: **zero new failures**.
  All six new tests ran and passed.

The seven baseline failures concern the browser-pool contract, omit-dev build
contract, two in-progress orderLine webhook contracts, SuiteQL orderLine
storage, migration upgrade, and deployment migration inventory. They were
present in the frozen source snapshot before this correction. The existing
test wrapper uses its pinned image's top-level SuiteScript files; no harness
or unrelated feature repair was folded into this incident.

No browser interaction was added: no UI changed. No dependency audit was run:
the dependency set is unchanged. Production acceptance of an actual receipt is
not established by a read-only draft; this verification deliberately does not
create inventory transactions. NetSuite may change after the observed read.

## Reproduction and source identity

From the repository root, rerun all local checks and the optional live read:

```sh
sudo -n env SN1400625_LIVE_REPLAY=1 bash server/tools/sn1400625-receiving-gauntlet.sh
```

Omit `SN1400625_LIVE_REPLAY=1` for isolated checks without production access.
The entry point uses fresh disposable PostgreSQL containers, the existing
`mbbs-retired-confirm-test:20260914` image (Node **20.20.2**) and installed
fast-check/c8/TypeScript/ESLint. No dependencies are installed. Mutants use
temporary source copies and never modify the workspace implementation.

Evidence and frozen source manifests are under
`server/test-artifacts/sn1400625-receiving/`. The source repository was already
dirty and remains so; no commit or reset was performed. Base Git HEAD:
`c82c71d6632ffef21ff0a77c3dabbce542f805e2`.

- Observed deployed/original resolver SHA-256:
  `ec677135b7c521ef4b83d4db7a95e141141363b2516f97f3fe9112f6148ba579`.
- Tested candidate resolver SHA-256:
  `53caf054ea8ad34c6a87cf7e6c71e3d0ba683858067767fc92c81a914d9cb8db`.
- Static-check reconstruction removes the functional condition and retains the
  harmless indentation change; the full baseline uses the untouched original
  snapshot. Both baseline and candidate diagnostics are retained.

`verified-results.json` is generated only after both full-suite logs finish and
their failing test names/counts match, all six new tests are discovered, and
focused/live evidence hashes still match the workspace.
