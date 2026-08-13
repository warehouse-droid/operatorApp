# MBBS Order Billing V3 — Executable Acceptance Specification

Status: autonomous implementation requested on 2026-08-13; pre-code human
approval was not obtained. This document is append-only for this task.

## Failure model

| Failure | Required detector |
|---|---|
| A completed PO has a vendor address and an MBBS-yard address but is rejected because the vendor is not an MBBS rate origin | Integration test using retained PO and yard rows; distance resolver must receive vendor-to-yard endpoints |
| A valid route is rejected only because either endpoint is outside a rate card's `origin_yard_codes` | Integration/property tests asserting every referenced two-address route is calculable with the explicitly chosen active graph |
| Pick-Up Sales Orders silently enter the default billing queue | Database integration test covering `Delivery`, `Pick-Up`, and casing/whitespace |
| An intentionally searched Pick-Up order cannot be added | HTTP/UI contract plus integration test for explicit database search mode |
| A completed custom local order is omitted | Integration test over `dispatch_custom_orders` with two retained addresses |
| UTC boundaries put a Toronto completion on the wrong date | Exact-date integration tests at both Toronto midnight boundaries, including DST offsets |
| A preview result is trusted after source/rate changes | Conversion must recalculate server-side from candidate IDs and immutable current rate evidence |
| A retry or concurrent click creates duplicate billing cases/lines | Idempotency and concurrency tests; deterministic snapshot/case identities and database uniqueness |
| One row fails after another row was written, leaving a partial batch | Injected failure/rollback test; snapshot, cross-charge, billing case, version, line, audit, and receipt counts remain unchanged |
| Conversion creates NetSuite/outbox/Dispatch/Driver work | Isolation assertions and database local-only outbox guard |
| A billing customer is guessed | Conversion requires an explicit active canonical customer selected by the operator; no fallback identity |
| A custom source cannot survive durable cross-charge generation | Migration, calculator, and end-to-end durable-case tests for `CUSTOM` |
| A long table remains unusable | Browser/UI contract and Playwright overflow assertion for bounded vertical scrolling and sticky headers |

## Scenarios

### S1 — Scrollable billing tables

Given an MBT billing table contains more rows than fit in the workspace,
when it is rendered in `.mbt-table-wrap`,
then the wrapper has a bounded vertical size, `overflow: auto`, a stable
scrollbar gutter, and sticky column headers.

### S2 — PO vendor-to-MBBS calculation

Given a completed PO reconciliation row retains a vendor pickup address and an
MBBS destination location/address,
when the operator previews it with an active MBBS rate card,
then it is ready, retains vendor-to-MBBS direction, resolves the full two-address
route, and calculates the selected distance-band total even when neither endpoint
appears in the graph's origin-yard scope.

### S3 — Any referenced two-address route is rate-ready

Given a completed supported order has at least one supported reference and two
nonblank addresses,
when candidates are listed,
then it is not rejected as outside the active MBBS rate scope. Missing references
or missing addresses remain fail-closed.

### S4 — Default method scope and explicit database search

Given completed Sales Orders with local method `Delivery` and `Pick-Up`,
when the default candidate list loads,
then only `Delivery` Sales Orders are included from the Sales Order source.
When a billing operator searches the database by order/customer/address,
then matching completed orders of either method are returned and can be added
explicitly without changing their stored delivery method.

### S5 — Completed custom local orders are included

Given a non-cancelled `dispatch_custom_orders` row is complete and has pickup and
drop-off addresses,
when the default candidate list loads,
then it is ready with a `CUSTOM` reference. Open and cancelled custom orders are
not candidates.

### S6 — Toronto completion-date filter

Given completions immediately before, at, and after a Toronto calendar-day
boundary,
when `completedDate=YYYY-MM-DD` is requested,
then exactly the local-day rows are returned. Invalid dates and a date outside an
also-supplied month fail with a 400 error.

### S7 — Durable conversion

Given a fully successful server-recalculated batch, an explicit active canonical
billing customer, and one active rate version,
when the operator chooses **Create billing cases** with an audit reason,
then the server atomically creates immutable completed-load snapshot evidence and
durable local-only MBBS cross-charge case/version/line rows using the exact
calculated distance, band, amount, references, and route evidence.

### S8 — Multiple distance bands

Given selected candidates resolve into different bands of the same active rate
version,
when they are converted together,
then each durable case retains its own selected band and amount while the command
remains one all-or-nothing user operation.

### S9 — Retry, concurrency, and rollback

Given identical conversion payloads,
when the idempotency key is replayed or two workers race,
then responses converge and exactly one durable identity exists per billing
case/version/line. Given any candidate calculation or durable insert fails, no
part of the conversion is retained.

### S10 — Local-only invariant

Given any successful conversion,
then no NetSuite outbox, Sales Order chain, Dispatch mutation, Driver PWA mutation,
or external transport call occurs.

## Setup plan

- Use the existing Node test runner, PostgreSQL rollback fixtures, Playwright,
  c8, TypeScript, ESLint, and existing manual-mutation conventions.
- Add one forward-only migration for `billing_candidate` immutable snapshots and
  the durable `CUSTOM` cross-charge source.
- Add focused unit, integration, concurrency, adversarial, HTTP, and UI tests,
  one persisted mutation runner, one source-state script, one gauntlet entry
  point, and one evidence report.
- No new dependency and no checkpoint commit.
- Do not deploy or mutate production billing/order data during this task.

## Invariants

- Existing public preview endpoints remain read-only.
- Candidate IDs remain opaque and server-authored.
- Money remains safe integer CAD minor units.
- Conversion never trusts browser-supplied distances, bands, amounts, routes, or
  source references.
- Operational order rows and delivery methods are never changed by billing.
- Existing billing approval and local-only posting boundaries remain unchanged.
- A failed gauntlet blocks completion.
