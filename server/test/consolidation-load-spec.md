# Consolidation Load — approved implementation specification

Approved in conversation on 2026-09-15, including the clarification that Delivery
Prep must not create a Sales Order IF. The backend retains delivery-completion
eligibility and queue ownership. Assurance: old-coder Tier 3.

## Acceptance scenarios

1. Replace Saved Orders navigation with Consolidation Load; keep saved records
   and Consolidation Pick accessible. Include all existing loadable packed types
   at the current authorized yard, including original children of Dispatch groups.
2. Sort by plan date, truck, numeric authoritative load sequence, then reference.
   Date/truck filters start unrestricted. Selections must share the same plan/load
   identity and yard. Unplanned and reference-only orders are ineligible.
3. Preview Order / Item / Quantity, combining compatible duplicate item lines
   within each original order. Never combine different orders, UOMs, conversion
   factors or source allocations for processing.
4. For packed 3 pallets, 2 layers, 0 sections, 0 pieces, display `3 plt 2 lyr`.
   Without conversion, packed sales quantity 12 EA displays `12 EA`. Show current
   load quantities only. Delivery Prep and Customer Pickup use the same formatter
   in two-column summaries without an extra remaining-quantity row.
5. Capture at least two shared Delivery Prep photos, upload each once, and attach
   the same references to every original order. Pickup's photo policy is unchanged.
6. Persist previews, accepted batch membership, immutable quantities, ownership,
   yard/load identity, photos and status. Live refresh preserves filters, selection,
   focus/scroll and captured photos; stale selections require review. Pending work
   is recoverable after page/server restart and scoped to the account and yard.
7. Revalidate actual order/child yards, assignment, eligibility, quantities and
   overlapping source lines before accepting. Reject stale or forged requests.
   Serialize competing individual/group/consolidated load and quantity mutations.
8. All selected local load records, photos and progress commit together. Injecting
   a failure after the first order leaves every order unchanged. A retry replays
   one accepted request and never duplicates quantities, records or photos.
9. Sales Order loading, alone or mixed with TO/CO, creates no Sales Order IF or
   auto-fulfillment candidate. Existing Driver/backend completion remains the
   decision point. The PWA never supplies a decision to queue/post an IF.
10. Preserve native Transfer Order posting gates, Customer Pickup, local-only
    orders/reloads, linked quantities and existing saved/picking behavior. Any
    backend-required native TO posting is verified through the existing durable
    posting machinery; verified remote work is retained on failure. Batch loading
    never waits for subsequent Sales Order delivery or IF processing.
11. Permission revocation and another operator cannot expose/submit/resume a batch
    or obtain its photos. Submitted work retains its accepted evidence for recovery.
12. Desktop Chromium, mobile Chromium and mobile WebKit present readable summaries,
    working selection/filter/camera controls and no background state loss.

## Setup and evidence

Reuse installed Docker Node/PostgreSQL/Playwright images and the repository's
Node test runner, fast-check, c8, ESLint and TypeScript. Add no package dependencies.
Use disposable isolated databases and frozen HEAD baseline; no live operational
records or NetSuite writes are used for verification. Preserve unrelated files.
No automatic commit is needed. Add a task-specific test runner, source manifest,
coverage/mutation/static checks and evidence report under server/test, server/tools
and ignored server/test-artifacts/consolidation-load.

Run focused tests RED before implementation, properties and concurrency/rollback
checks, browser execution, full randomized regression with zero new failures,
types/lint compared to baseline, all changed executable lines, 3–5 realistic
mutants (including properties-only), secret/capability review and a fresh final
reproducible gauntlet. Report limitations honestly. Rollout uses an additive
migration followed by app/worker and PWA version updates, with health verification.
