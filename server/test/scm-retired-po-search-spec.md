# Retired PO split search

Spec approval: not obtained (autonomous follow-up). The reported duplicate is
the cancelled `PO# B03429 (L3)` and its completed replacement
`PO#B03429 (L3-18plt)`. The Dispatch-wide search bypasses the cancelled-split
filter and projects the retired child as queued/unreconciled with empty content.

Acceptance:

1. A cancelled/unsplit child must stay absent from normal, completed, exact-ref
   and cross-order schedule searches, including authenticated HTTP/browser views.
2. Reusing its reference must show exactly one active replacement, matched by
   synthetic order identity, with the replacement's contents and status.
3. Native cancelled/closed/completed/inactive POs remain searchable under the
   established broad-search policy; Hold visibility and permissions are unchanged.
4. Read queries preserve all PO, line, split, cancellation and schedule history.
   The active L3-18Plt completion evidence and sibling schedules are preserved.

This explicitly refines the older search test which included a cancelled split
alongside native cancelled orders: retired split identities are internal history,
not operational orders. Retain the underlying records; change only visibility.

Use existing split/search tests, their seeded property cases and real Chromium
search, plus three SQL mutations and changed-line coverage. No dependencies,
schema changes or production-data edits. Stage only this task's delta over the
current live image and deploy with rollback protection. Use the bounded standard
Compose configuration, unique retention artifacts and teardown on every exit.
