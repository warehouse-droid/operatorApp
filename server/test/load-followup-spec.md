# Load follow-up — approved implementation specification

Approved by the user's “Implement the plan” on 2026-09-17. Tier 3: inventory,
partial completion, concurrent posting and durable recovery. Use existing Node,
PostgreSQL, Docker, node:test, fast-check, c8, ESLint, TypeScript and Playwright;
no dependencies, migrations or automatic commits. Preserve unrelated changes.

## Executable acceptance criteria

1. Different webhook payloads at the same source timestamp use arrival order,
   never hash order, including queued, failed, running and completed predecessors.
   Duplicate hashes remain idempotent; strictly older timestamps remain stale.
   Missing timestamps retain arrival-order behavior. Concurrent enqueues serialize.
2. Customer Pickup and Delivery Prep warn before loading when eligible unfinished
   lines lack confirmed quantities: three confirmed of four means one missing.
   Count all pages and full selected consolidation orders; exclude completed,
   non-loadable and direct-supply lines. Cancel/ESC changes no draft. Continue
   posts only confirmed quantities; next scan shows only remaining quantities.
3. Order detail/lookup exposes a minimal durable posting summary. Active claims
   block loading across refreshes/operators. Verification mismatch retains an
   observed transaction reference separately from verified completion. Never
   weaken verification, expose private job/photo data, or generate a fresh
   transform to recover an uncertain attempt. Keep fresh transform + verification
   without remote source/history/duplicate preflight.
4. Reconcile SOB120541/995451 to existing IF153890/996410 only after exact source,
   external ID, item, location and quantity verification. Accepted quantities by
   orderLine are 1:156.75, 2:24.6, 3:2 and 8:2. User explicitly confirmed all four
   were loaded. Import missing item 602/key4967891, preserve immutable original
   submission, audit the variance, record confirmation/load history and complete
   the existing command atomically. Repetition is a no-op; failure rolls back.
5. Audit the 13 same-timestamp discarded updates using current source data, and
   refresh only demonstrably stale local source data with existing preservation
   rules. Never replay historical receipts/fulfillments or overwrite progress.
6. Scoped deployment overlays the current live app and worker, retaining receiving,
   photo and unrelated changes, with source hashes, backup and health verification.

## Failure model and evidence

- Lost/out-of-order updates: real queue/database cases and ordering properties.
- Extra inventory, lost partial balances: real local load/receipt and payload tests.
- Duplicate posts, cross-operator reloads: claim races, existing processor recovery
  suite and browser flows with delayed/lost responses.
- False completion or leaked state: strict verifier, observed/verified separation,
  authorization and frontend block tests.
- Partial repair: transaction rollback, immutable hashes and repeat execution.
- Regression: baseline comparison, affected/full suites, lint/types, changed-line
  coverage, targeted mutants, randomized ordering and browser execution. Record
  limitations/skips honestly in the evidence report. Production tests are read-only.

Arrival order is the explicit fallback for equal source timestamps. Changes not
yet delivered by webhook may still require review after posting verification.
