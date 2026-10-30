# Backorder optional SO and saved review forms

User policy, 2026-10-22: STREQ-000165 and STREQ-000186 must both offer the
optional SO attachment after SCM has replied to every material. Saved Sales
confirmations and SCM material reviews start collapsed and have an Edit button.
This supersedes the attachment restriction to requests containing Already
Ordered materials. Previously available Already Ordered attachments remain
available, including completed requests; closed requests stay protected.

Tier 3 for the local reference-save boundary and concurrency protection.
Detailed spec approval: not obtained (autonomous run). Existing dependencies,
Node/Playwright/fast-check tooling, isolated bounded Compose, and retention
runner only; no dependency, migration, commit, or live business-data changes.

Acceptance scenarios:

1. All current materials have a persisted SCM status/reply, Sales decisions are
   pending: Sales sees the optional SO field for both ordinary and mixed
   Already Ordered requests. One unreviewed material keeps an ordinary request
   on the quote field. An empty request is not eligible. SCM has no SO editor.
2. Saving the optional number preserves the stage, decisions, saved quote,
   canonical SO/PO links and quantities. It records one audit and increments the
   request revision. Existing Already Ordered receipt behavior remains intact.
3. Server checks persisted reviews, Sales role, yard scope, active/closed state,
   length/control characters, canonical SO conflict, and expected revision.
   Concurrent saves with one revision allow exactly one success; forged review
   fields cannot bypass the persisted prerequisites. No NetSuite write occurs.
4. A saved Sales decision starts collapsed with Edit Sales confirmation. Pending
   decisions remain visible, including after SCM changes the reviewed status.
   Edit reveals the saved decision/reason/note for that material only.
5. A saved SCM review starts collapsed with Edit material review. Unreviewed
   materials remain visible. Edit restores saved status, vendor, ETA and notes.
6. Successful saves collapse the relevant saved form. Failed saves preserve the
   visible form and entered values. Keyboard access and aria-expanded/controls
   work; unrelated renders do not close an explicitly opened editor. Terminal
   and Already Ordered material protections stay unchanged.
7. Sales and SCM load the updated module after refreshing. Desktop and mobile
   browser checks exercise both editors and the optional SO save.

Failure model: premature or unauthorized SO-reference saves (API role/scope,
persisted-state and adversarial tests); lost concurrent updates (revision race);
accidental stage/line/order changes (before/after snapshots); hidden unsaved work
(browser pending/error tests); cross-material edit leakage (two-line browser
fixture); stale assets (cache-version and live HTTP checks). Scope excludes
changing formal SO/PO link prerequisites, receipts, fulfillment, or pricing.

Validation uses focused new tests plus existing Backorder/Already Ordered and
linking regressions, scoped types/lint, changed-code coverage, deliberate
mutations, seeded eligibility properties, and real browser execution. Existing
tests that assert the superseded UI behavior will be updated explicitly in a
separate test step, preserving their unrelated assertions.
