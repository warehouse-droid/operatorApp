# Field Sales customer quotes: accepted executable contract

The user approved the replacement plan on 2026-09-21 and requested implementation.
Tier 3: money, identity, offline data, and concurrent external writes. This file
records the acceptance contract before implementation. No extra spec approval is
requested: the user has authorized autonomous implementation of that plan.

## Setup and boundaries

- Reuse Node 20, PostgreSQL 18, Playwright, ESLint, tsc, c8, fast-check, PDFKit,
  and sharp in the existing isolated test image. No new npm runtime dependency.
- Add licensed Noto fonts for Chinese PDF text; include the font license.
- Use a scoped source baseline and content hashes, not commits or resets, because
  the shared workspace contains unrelated changes. Test databases are disposable.
- Existing quote publication assertions describe the superseded mixed-company
  estimate workflow. Replace their live-interface coverage with the accepted
  single-company/local-quote/confirmed-Sales-Order contract; retain independent
  money, history, permissions, imports, routing, and retry regression coverage.
- Existing NetSuite estimate rows/revisions remain readable. New commands never
  create estimates. External posting is separately gated and sandbox-validated.

## Behaviors (named tests and browser scenarios)

1. UUID: remove browser randomUUID; create quote, lines, visit and offline commands
   using valid v4 UUIDs from getRandomValues. No crypto -> useful error, no weak IDs.
2. Directory: customer with two types and two representatives links to two sites;
   another customer links to either site. Archive hides new selections, preserves
   snapshots. Updates use revisions; command replay is idempotent and actor-bound.
3. Visits: inline customer/representative creation retains note, selected photo,
   and revisit date; two contacted customers persist with representative snapshots.
   Offline creation syncs before dependent site link, visit, and quote.
4. Quote: company, local customer and linked site required; another company's
   item is rejected. MBBS TRADE-A and MBR/MBT TRADE suggestions remain. Entered rates
   remain editable. 120 x 36.99 + 10 x 38.99 = 482870 cents, tax 62773, total 545643.
5. Revision/PDF: preserve old customer/template/memo and amounts after edits.
   Sample layout without packing columns; Chinese memo, wrapping, pagination,
   signatures and barcode. Totals panel lists items; autocomplete last; memo below.
6. Confirmation: only saved current nonempty company quote can be confirmed;
   actor records customer confirmation and optional evidence. Lock accepted revision
   atomically with order intent. Copy creates an editable new quote, no accepted state.
7. Identity: MBBS gets independent NetSuite customer mapping; MBT and MBR reuse one
   shared mapping and ensure both subsidiary memberships before order creation.
8. Outbox: concurrent confirmations create one customer per customer group and one
   order per quote; lost responses reconcile stable external IDs. Customer success /
   order failure resumes the order. Wrong remote identity/totals -> attention with
   durable remote reference, never a duplicate order or silent quote repricing.
9. Auth: Field Sales/admin manage directory and quotes; admin-only integration and
   templates; unrelated roles denied. Do not change George's role/credentials.
10. Compatibility: preserve pending work, immutable old revisions and historical
    estimates; old mixed drafts require explicit company split/review. Cache refresh
    retains IndexedDB. Local quoting works with external integration disabled.

## Failure model and evidence layers

- Double submit, cross-worker leases, timeout after remote commit: concurrent DB
  tests plus fake-network contract tests and hostile response tests.
- Lost draft/contact/photo or stale edit: IndexedDB browser tests, revision tests,
  idempotency and migration preservation tests.
- Wrong customer/company/price: validation tests, fixed-point properties, actual
  generated PDFs, post-save remote verification and deliberate mutants.
- Authorization/input attacks: HTTP tests, HTML escaping checks, bounded data,
  evidence upload content checks and actor-bound command receipts.
- Deployment drift: scoped manifest hashes, existing image overlay, isolated
  migration rehearsal, service health and public asset hash checks.

Evidence must record exact commands/results, superseded contracts, skipped layers
and external account setup limitations. Never claim sandbox writes not executed.
