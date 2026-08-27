# SOM05681-R1 current-item correction verification evidence

- Verification date: 2026-08-25 UTC
- Approved physical second-attempt identity: `UNI-WIN70T-RDM-GN`
- Functional source state: `aeedc953101ef18502b129d16bff88f13eb2da294745da93b07e9ed7459b2beb`
- Environment: disposable Docker Compose projects backed by isolated PostgreSQL
- Production/NetSuite writes: none
- Deployment: not performed

## Executable contract and RED evidence

The approved contract is `test/sales-order-reattempt-current-item-correction-spec.md`.
The initial tests failed because the application had no append-only completed-item
correction, projected the historical `CG` identity as current work, did not bind
the command to current quantity/lifecycle state, and did not gate future Driver
execution on genuine Operator load evidence.

Browser verification also exposed two real Pixel/Chromium interaction failures:
the two-column Control layout covered the correction button, then the scrolled
page caused modal checkbox/submit hit targets to drift. The final implementation
stacks the mobile layout, removes modal horizontal overflow, locks/restores the
underlying page position, and lets the modal own its scrolling. The same workflow
then passed without forced clicks.

## Final source-bound gauntlet

Command:

```text
bash server/tools/sales-order-reattempt-gauntlet.sh
```

Result: **PASS**, from `2026-08-25T19:13:01Z` through
`2026-08-25T19:14:22Z`. The complete log is
`test-artifacts/sales-order-reattempt/latest.log`.

The fresh-database gauntlet proved:

- clean application of migrations 001 through 179;
- 26/26 focused unit, property, adversarial, UI-contract, HTTP, PostgreSQL,
  concurrency, and SOM05681-shaped integration tests;
- exactly one append for same-key concurrent retries and rejection of a
  competing stale-key race;
- Admin-only preview/apply endpoints and zero mutation on stale input;
- 6,480 legacy re-load quantity properties;
- 20 re-load integration, 35 delivery, 25 yard-history, 49 UI, 5 photo-entry,
  and 14 idempotency scenarios;
- 15/15 re-load mutants and 6/6 correction mutants killed;
- 97.86% statements/lines, 100% functions, and 88.41% branches across the
  changed correction/re-load policy modules;
- lint with zero warnings, TypeScript checking, changed-line secret scanning,
  legacy/public syntax, and all changed server repository syntax;
- the complete Admin correction interaction in desktop Chromium, Pixel
  Chromium, and iPhone WebKit (3/3).

## Driver sequencing regressions

Against the same final application image, the disposable environment also
passed:

- Driver offline repository rollback;
- Driver offline client queue behavior;
- Driver stop reopen/evidence/manifest behavior;
- 5/5 yard-dependency mode scenarios;
- 17 yard-dependency structure assertions;
- consecutive physical-visit preview checks; and
- 16/16 plan-date online/offline execution tests.

## Critical SOM05681-R1 invariants

The production-shaped fixture proves that the completed child projects
`UNI-WIN70T-RDM-GN`, `16 PLT`, and `1470.08 SQFT` while retaining
`UNI-WIN70T-RDM-CG` as immutable historical identity. Applying the synthetic
preview/command:

- appends one immutable correction row and is idempotent;
- preserves original load evidence, Driver pickup/drop rows, timestamps,
  photos, completion events, parent quantities, saved plans, inventory, and
  billing disposition;
- creates no fake Operator load record;
- records the existing anomaly as `driver_completion_reconciliation` with an
  explicit missing-Operator-evidence warning;
- keeps the child `linked_parent_no_charge`; and
- blocks any future re-attempt from Driver start/completion paths until a real
  Operator load completed the matching cycle.

The current-item preview is the dry-run surface for the eventual one-time
production correction: it refreshes and uniquely maps the parent NetSuite line,
checks current quantity support, and returns a fingerprint binding child, cycle,
parent, line, before/after identity, quantity, and lifecycle. Production apply
remains a separate authorized action.

## Disposable teardown

The `mbbs-sales-order-reattempt-gauntlet` and
`mbbs-reattempt-current-item-red` projects were removed with their isolated
containers, networks, and temporary database state. After confirming that no
remaining container referenced them, the exact disposable image tags
`mbbs-mbt-p1-test-test:latest`, `mbbs-mbt-p1-runtime-check:latest`, and
`mbbs-mbt-p1-test-e2e:latest` were deleted. Final verification showed only the
three healthy `mbbs-operator-app` production containers; they were not restarted
or modified.
