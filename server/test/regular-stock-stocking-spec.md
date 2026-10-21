# Stocking versus customer Pickup — executable specification

Spec approval: not obtained (autonomous run). The user requested the behavior change, clarified that Pickup has no minimum lead time, and previously authorized deployment after tests pass. Use the existing toolchain; no additional approval, dependencies or commits are required.

Tier 3: this change controls pre-approval and NetSuite order creation. The English and Chinese manuals must match the deployed behavior.

## Acceptance criteria

1. Regular requests offer three distinct methods: **Pickup**, **Delivery**, **Stocking**. Method remains mandatory. Unknown values fail validation. Existing arrival date/time and optional-customer inputs remain available.
2. With auto-approval enabled, Pickup requesting 200 from 1,000 available with safety stock 800 auto-approves even for immediate arrival and a configured lead time of 12 hours. Pickup never fails the lead-time gate. The UI explicitly says that Pickup has no minimum lead time.
3. Pickup requesting 201 from those balances requires manual review for the shortage. Gate-off or unavailable stock policy also requires manual review. Duplicate item/source quantities are summed. Manual stock/PO approval and rejection follow the previous SO workflow.
4. Delivery keeps the configured lead-time, safety-stock and enabled-switch checks. The exact configured time and safety boundaries are inclusive. Existing delivery behavior remains covered.
5. Stocking always requires manual SCM review regardless of timing, sufficient stock or auto-approval setting. No Sales SO entry or pre-approval countdown is offered. The SCM action reviews adjustable quantities, autocomplete-added items and per-route PALLET quantities before confirmed direct TO creation.
6. A new Pickup or Delivery request cannot use the direct SCM conversion endpoint, including an old browser calling the existing endpoint name. Stocking cannot enter the Sales SO path. Existing endpoint paths and saved direct-transfer payload keys are retained for compatibility.
7. Pickup pre-approvals use the configured expiry and can be re-raised when unused. A correct SO created at the Sales yard can proceed through the custom confirmation to one-source location change or multi-source TO routing. Exact quantities, non-stock companion handling, SO uniqueness, busy-button locks that release immediately after submission, snapshot history and durable retry protection remain intact.
8. Previously saved direct-TO operations, if encountered, remain readable/retryable as Stocking using their existing transfers and idempotency identifiers. A historical Pickup SO handoff remains Pickup and retains its immutable safety snapshot. Read-only live inspection found only historical SO-based Pickup, and no direct-TO Pickup requests requiring migration; no data rewrite is planned.
9. Sales/SCM summaries, reasons, alerts, queues, conversion dialog, settings help and both manuals use the distinction consistently. Special-request pickup-at-vendor and pickup-at-inquired-yard remain unchanged.

## Failure model and checks

- Wrong auto-approval: exact-boundary unit cases, generated properties across methods/gate/stock/time, plus real SQL submission tests and mutation checks.
- Wrong order path or stale client: integration/HTTP and browser tests reject cross-workflow conversion before any remote write.
- Duplicate orders or interrupted work: retain concurrency, replay, partially successful TO and SO uniqueness tests; exercise saved legacy direct-transfer recovery.
- Expiry bypass / wrong clock: Pickup expiry-at-boundary and re-raise integration, Stocking exclusion, and Delivery regression tests.
- Misleading screen/history: desktop/mobile browser checks for all three methods, Chinese labels, saved results and absence of Pickup lead-time warnings.
- Collateral deployment: snapshot task files before editing, compare against the live image, overlay only the approved file list, verify source/assets/health and preserve configuration and worker state. Live checks are read-only and issue no NetSuite orders.

## Setup and evidence plan

Use installed Docker Node/Playwright/PostgreSQL images and the existing Node test runner, fast-check, ESLint, TypeScript and coverage tools. Disposable test database/network only; external NetSuite boundaries stubbed. No packages, schema changes, production test records or commits. Record the existing smart-SCM fixture failure verbatim and allow zero new failures.

Retarget the previous direct-Pickup tests to Stocking with their behavioral assertions preserved. This is an explicit requirements change, not a relaxation of order-safety tests. Add new Pickup-without-lead-time tests and observe RED before changing runtime files. Retain historical deployment evidence; write new test/deployment reports under `regular-stock-stocking`.

Gauntlet: full relevant stock-request and neighboring suites; seeded shuffled focused run; static checks; changed-line coverage; at least five plausible manual mutants killed by both regression and generated-property checks where applicable; real browser/server execution; source/package/secret checks; scoped deployment and read-only live verification. Record any unavailable layer or coverage limit explicitly.
