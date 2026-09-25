# Combined Field Sales quotes — 2026-09-22

Spec approval: not obtained (autonomous run). User authorized implementation and
deployment and clarified that the output is one PDF with multiple company pages.
Tier 3: money, immutable history, migration, concurrent/offline commands.

## Acceptance scenarios

1. Saving MBBS + MBT + MBR items produces one local quote ID, revision, customer,
   jobsite, memo and list row. Company totals add to the quote total. No order is
   posted until customer confirmation. Server assigns today's Toronto date and
   each company's configured validity (30 days by default).
2. One Download PDF action produces a single valid PDF. Each represented company
   starts on a new page with its own template, items, taxes, subtotal and total;
   pagination continues for long sections. Shared quote reference and overall
   total are clear. Existing company document numbers are retained. Chinese memo,
   no billing/shipping/expected-close inputs, and desktop/phone usability survive.
3. Concurrent retries save exactly once. Invalid items, price/tax changes, stale
   revisions, hostile line IDs and missing/inactive customer links cannot partly
   save a quote. Accepted quotes remain immutable; copying copies every company.
4. Confirming the saved revision creates one order intent per represented
   company under the SAME local quote ID. All local preflight succeeds before any
   intent is committed. Evidence belongs to that parent/revision/actor. Each
   order has a stable unique external ID, company-specific lines/totals and the
   shared parent quote reference. MBT/MBR share their NetSuite customer account.
5. Each order's reference/state/error remains visible. A lost response or one
   failed company can be reconciled independently without recreating successful
   orders/customers. Posting remains gated and disabled on live deployment.
6. Migration combines only unconfirmed company quotes linked by a successful
   explicit batch-save receipt whose recorded revisions are still current.
   Unrelated quotes and accepted/posted work are never guessed together.
   FS-MBBS-000002 and FS-MBR-000003 become one parent; their numbers and immutable
   revisions survive. Old child links resolve to the parent; explicitly requested
   historical revisions/PDFs remain available from the parent history panel.
7. Existing single-company and legacy quote histories remain readable. Old
   clients cannot overwrite or separately confirm a merged child. Newly submitted
   obsolete batch-save commands require review; existing command receipts remain
   idempotent. Review retains offline originals while converting to one quote.
8. Offline combined edits survive reload, replay and stale GET races. One queued
   save produces one local row and one acknowledged parent. Migration aliases do
   not reappear as duplicate list rows. Permissions remain enforced.

## Failure model and setup

- Wrong totals/company crossover: fixed-point/property checks, actual PDF text
  and page inspection, Sales Order payload and worker tests.
- Partial writes/duplicate orders: real disposable PostgreSQL transactions,
  concurrent save/confirmation, timeout/retry tests, malicious inputs.
- History loss/false merging: migration with explicit receipts, rejected unsafe
  candidates, immutable snapshot comparison, transactional rollback rehearsal.
- Offline data loss: browser IndexedDB/reload/conflict/recovery exercises.
- UI regressions: real browser at desktop and phone sizes, combined PDF rendering.
- Deploy drift: source hashes, scoped image overlay, private Field Sales backup,
  transactional migration, app-only cutover, live read-only checks.

Reuse the pinned isolated Docker/PostgreSQL/Node/Playwright/PDF tooling already
installed. No new runtime or development packages, no git commits, no unrelated
files included in deployment. Add spec/tests, reproducible check scripts and
evidence under server/test, server/tools and server/docs. Run the full Field Sales
suite, scoped lint/types, changed-line coverage, 3–5 manual mutants, property
tests, shuffled suite and realistic browser/PDF execution. Existing independent
quote assertions in auto-quotes tests/browser are explicitly superseded by
scenarios 1, 2, 7; their atomicity, validation and offline guarantees remain.
NetSuite live integration cannot be exercised without its configured RESTlet;
use the real publisher with a simulated network boundary, keep live write gates
off, and state this limit in evidence.

## Explicit history clarification

The confirmation and Sales Order panel describes only the accepted revision.
Opening an earlier historical revision must not label that earlier content as
accepted; it remains read-only and Refresh saved quote returns to the current
revision. Browser assertion added after reviewing the history behavior.
