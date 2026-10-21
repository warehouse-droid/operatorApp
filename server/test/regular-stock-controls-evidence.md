# Regular stock approval controls and saved snapshots

Spec: [regular-stock-controls-spec.md](regular-stock-controls-spec.md). Tier 3, because SO reuse, confirmation concurrency and approval expiry govern external order writes. Spec approval: not obtained (autonomous run); the user explicitly requested implementation, deployment, re-raising expired requests and completed-request snapshots.

## Behavior and evidence

| Requirement | Evidence |
| --- | --- |
| Default 15-minute approval; configurable positive whole minutes; existing deadlines preserved | Unit validity cases, settings integration, exact deadline property (200 generated cases), real settings API/browser save |
| Disabled auto-approval gate forces manual review | Persisted settings integration, generated gate AND safety AND lead conjunction (200 cases), browser settings and re-raise |
| Explain manual-review causes and safety required per line | Named item/source/units/remaining/safety/lead/gate unit tests, manual safety browser review |
| Expiry blocks before and after a slow NetSuite read; completed or started actions recover | Integration expired preview/execute and slow-read no-write assertions; idempotent completed handoff after deadline; expiry property exempts started work |
| Re-raise approved items with fresh stock and current policy, preserve rejected items and history | Real database tests for revision, partial decisions, rejection preservation, changed stock and automatic reapproval; authenticated HTTP concurrent re-raise yields 200/409 with one audit event; browser re-raise |
| SO cannot be reused even for separate lines | Database unique ID and trimmed case-insensitive reference indexes; simultaneous two-request test has one winner/one precise reuse rejection and one remote TO write; same-request retry remains idempotent |
| Custom centered modal, meaningful NetSuite busy state, all buttons disabled, no duplicate requests | Delayed preview/execute browser gates, duplicate synthetic clicks, background rerender/disabled-attribute change, Escape/cancel, both SO location and two-route TO confirmation, countdown expiry, desktop/mobile screenshots |
| Completed requests show saved decision data | STREQ-000059 regression: 1,171.52 − 523 = 648.52 SQFT, safety 296.0278324, shortage zero; completed SCM/Sales and TO browser displays hide live balances and refresh actions; completed evidence service performs no new NetSuite refresh |
| Migration and existing workflows | Isolated transactional migration/backfill/uniqueness/rollback test; existing quantity mismatch, ancillary lines, revision guards, external adapter, legacy transfer and SCM suites retained |
| Role and yard access | New real HTTP re-raise access tests (401/403), existing shared Sales/SCM endpoint authorization suites |

## Final fresh run

Reproduce from repository root: `python3 server/tools/regular-stock-controls-check.py` with Docker access. It creates an internal network and fresh disposable PostgreSQL database, applies migrations, runs all layers and removes only its test resources. The existing pinned test images/environment provide Node 20.20.2, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0 and TypeScript 7.0.2. No dependency additions or package changes.

- Relevant regression suite: **185 passed**, zero new failures. Preserved baseline neighbor failure: `src/smart-scm-harness.js` / `Expected active item_master input.`.
- Focused reverse-order suite: **59/59 passed**.
- Browser: **16 workflow checks**, zero page errors; no browser-default dialog used.
- Changed executable lines: **214/214**; changed branches: **214/245**. Remaining branch gaps are explicitly retained in `changed-lines.json`; full branch coverage is not claimed.
- Five realistic mutants killed by the regression tests AND property-only tests: bypass gate, compare pre-request stock instead of remaining stock, bypass lead time, expire one millisecond late, expire already-started work. Temporary copies restored and the original suite rechecked.
- Syntax/strict core types/lint: pass, zero new diagnostics; 85 legacy lint diagnostics remain unchanged. New dialog, regression and tooling lint also passes.
- Package hash unchanged. Runtime patch introduces only the authenticated re-raise endpoint, local approval metadata/settings, unique SO constraints, and browser presentation. No new outbound destination, subprocess, filesystem or environment access; diff scanned for such capability/credential additions. No new dependency audit applies.
- Source manifest digest: `e6931f866032d13096436d9a12902602baa66ddfb1c19b30bdff2138655f7a46`. Per-file hashes: `test-artifacts/regular-stock-controls/checks.json`. Scoped runtime patch: [regular-stock-controls.changes.patch](regular-stock-controls.changes.patch).

The controls tests initially failed for missing gate, expiry, reasons, re-raise and SO uniqueness behavior. The completed-case regression reproduced the misleading 125.52 remaining / 170.5078 shortage after refreshing an already processed request. The fix preserves the original decision snapshot. An older VM browser fixture needed the new timer/dialog dependencies supplied; a browser test was corrected to navigate via SCM's existing Closed queue instead of an unsupported deep link. Coverage checkpoints before navigation preserve executed dialog callbacks. No behavioral assertion was weakened. Final complete fresh run followed the last runtime edit.

The earlier read-only investigation confirmed STREQ-000059 originally approved 1,171.52 SQFT less 523 SQFT, leaving 648.52 against safety 296.0278324. A later read-only closed-SO probe was blocked by a NetSuite user-defined workflow; no remote mutation was attempted and closing an SO is not claimed to change safety policy. The user clarified the safety threshold should remain unchanged.

## Limits and release

External order transports are stubbed only at the NetSuite boundary in isolated tests; application transactions, real HTTP handlers, adapters, browser UI and database constraints execute normally. No production SO/TO/PO was created or edited for validation. Strict types apply to the established domain/parser core; other files are covered by lint and execution. No performance SLA was requested. Human review of the executable spec was not obtained, so these results do not claim independent specification validation.

Deployment: [regular-stock-controls-20260929](../deployments/regular-stock-controls-20260929/README.md). Additive migration 240 is retained if the application image rolls back. The release overlays exactly 16 files on the previously deployed image; it preserves the worker, other services, environment and Compose configuration. Production verification checks the migration, settings, unique SO indexes, the saved reported-case snapshot and served application assets without making NetSuite calls.
