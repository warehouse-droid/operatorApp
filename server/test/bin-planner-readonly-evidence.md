# Shared read-only planner evidence — 2026-09-27

Spec: [bin-planner-readonly-spec.md](bin-planner-readonly-spec.md).
Tier 2 UI correction. Spec approval: not obtained (autonomous run).
The user's explicit requirements define the acceptance criteria; no independent
spec review occurred. No new dependencies, migrations, server changes or commits.

The two planners now call the same load, stop, hover, assignment-control and
preview renderers. A read-only capability supplies a grey background, badge,
disabled inputs/actions and event/mutation guards. The per-load hyperlinks and
summary-only renderer are removed. Assigned flatbeds remain visible in BIN
Planning, with the existing truck-switch section in either direction.

## Final verification

Exact candidate image: `sha256:fc682f9ba4ac6876b67af9ea68f59308a3a8acb8e7de75336aa1bd8dec52052c`.
Five UI assets overlaid on the current live image; all 1,104 runtime files verified.
The unrelated local NetSuite harness change is excluded.
Final source manifest: 95 files,
`2c2bf077b588b87aff921f2ac6a4ba0e940acde2c802efab329a787a1d451422`.
Run: 2026-09-27T08:00:02.477321+00:00 to 2026-09-27T08:03:51.262648+00:00.

| Check | Result |
| --- | --- |
| BIN planning feature suite | 65/65, 21 files |
| Existing BIN compatibility suite | 155/155, 37 files |
| Dispatch regression suite | 228/232; same four recorded failures, no new failures |
| Maps, required pickups and disabled-MBT frontend tests | 34/34 |
| Repeated read-only, ownership and full planner browser tests | 7/7 |
| Seeded ownership property | 100 cases, seed 270927 |
| Manual mutants | 5/5 killed by behavioral failures; original source unchanged |
| JS syntax and differential lint | Both scripts pass syntax; no new diagnostics (Dispatch retains 11, adapter 0) |
| Candidate and rollback startup | App healthy, worker started, zero startup errors |
| Schema and secret-pattern diff checks | No pending migrations; no detected secrets; dependencies unchanged |

`test/mbt/integration/bin-planning-readonly-browser.test.js` compares the same
ordinary load across both pages: stop sequence, load/stop hover text, complete
preview detail text, assigned truck, grouped drops and manual returns. It covers
both truck-switch directions, disabled mutations (including synthetic events),
stop-click inspection, direct route refresh/optimization rejection, preview
collapse/close, in-memory and persisted snapshot equality, no writes, and zero
MBT requests from Dispatch with MBT disabled. Real Chromium runs against Express
and isolated PostgreSQL. Screenshots and raw coverage are under
`test-artifacts/mbt-bin-planning/checks/readonly-final-feature/`.

The companion unit file executes the production ownership, saved-timing and
mutation functions. Return loads and canonical BIN stops participate in the
ownership property. The existing full planner browser test verifies editable
BIN drag/drop, timing overrides, Google estimate persistence, saving,
confirmation, lease observers, mixed-load preservation and date navigation.

Browser V8 coverage executes 109/114 changed executable JS lines (Dispatch
92/97, adapter 17/17). The remaining five statements guard direct mutation entry
points; each is exercised by the focused unit test. A combined browser/VM branch
percentage is not claimed. CSS is verified by computed grey-background assertions
and actual screenshots. Static TypeScript checking is not configured for these
classic frontend scripts; syntax, name checks and real browser execution are used
instead. Unchanged backend type graphs were not rerun. Real Google provider
availability is outside this change; tests validate the shared map component and
existing route-estimate behavior without spending live provider quota.

## Failures found and resolved

RED reproduced missing full cards and BIN stops. Fixture setup was corrected to
use valid tooltip SKU labels and mutually consistent service overrides/timing;
assertions were retained. Exact cross-page comparisons then caught a different
BIN handoff label and rest-time calculation. The handoff uses the actual BIN
location, and read-only loads retain saved timing while the other planner has a
draft. Existing extracted-function harnesses now include the new ownership
helper, with their behavioral assertions unchanged.

A repeat run exposed a timing-dependent feed/navigation race. A
new test gates the adopting date response and a competing search response; it
failed with the prior date's pool. The BIN adapter now keeps date adoption in
control until completion and refreshes a changed search afterward. Both the
deterministic test and the original full browser race assertion pass.

The first mutation harness also ran unrelated unit tests after inverting ownership,
which introduced missing-environment errors. Final mutants are run against their
specific behavioral test, and all five produce valid assertion failures. The first
verification attempt and candidate remain in the `*-attempt1*` artifact directories.

The four unchanged Dispatch failures are:

- DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries
- DP-13 and DP-16: checkpoint list is metadata-only and compact reads/commands record bounded timings
- DP-33 frontend: active CO projection retains every current relationship pickup
- history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders

## Reproduction and artifacts

From the repository root, with the existing test Docker image and browser cache:

```sh
python3 server/tools/bin-planner-readonly-gauntlet.py
BIN_PLANNING_CHECK=readonly-final-baseline BIN_PLANNING_SOURCE_ROOT="$PWD/server/test-artifacts/bin-planner-readonly-release-20260927/candidate" bash server/tools/bin-planning-test.sh node tools/bin-planning-suites.mjs baseline
python3 server/tools/bin-planner-readonly-coverage.py
```

The gauntlet runs the candidate runtime, repeated browser checks, static checks
and the disposable-source mutation script. It checks frozen source hashes and
allows only the four recorded Dispatch failures. Full reports are in
`test-artifacts/bin-planner-readonly/final/`; release files, baseline, candidate,
per-file diffs, health/rollback evidence and receipt are in
`test-artifacts/bin-planner-readonly-release-20260927/`.

Deployment status is recorded separately in `deployment-result.json`; this test
report alone does not assert a live cutover.
