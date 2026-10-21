Special Request PO reference and recipient alerts — Tier 3

Spec approval: not obtained (autonomous run). User requests Sales display POB03976 / SN1401857 and alerts once SCM records a reference; prior deployment authorization persists.

Acceptance:
1. Sales linked-order display combines the native PO number with the trimmed packing-slip/dispatch reference using exactly " / ". Missing refs show only the native number, and an identical ref is not repeated. Text is escaped.
2. Active requests with a real linked PO and a nonempty SCM reference produce durable pending notices: vendor_pickup to the submitting Sales user within authorized yards; mbt_delivery and yard_pickup to private dispatcher/admin accounts. Completed/closed/cancelled/closure-pending and synthetic split/test orders are excluded. A reference alone does not change request stage, readiness, stock, orders, prices or any NetSuite field.
3. Notices are derived from committed canonical PO reference data, so every existing SCM reference editing path works, including special mini bar, schedule and PO editor. SSE invalidations, focus and a 30-second poll refresh alerts. Existing unacknowledged refs are included.
4. A center modal displays the case, combined PO reference and pickup/delivery instruction, with Open request and Acknowledge. Acknowledgement persists per authenticated user, case and audience. Re-saving unchanged refs stays dismissed. Changed reference or delivery method produces a new notice. Offline recipients see pending alerts when they return.
5. Auth/role/workflow/owner/yard enforcement applies to list and acknowledgement, with no client-selected recipient. Stale acknowledgement cannot hide a later change. Concurrent acknowledgements are idempotent. Transaction rollback does not leak notices or acknowledgements.
6. Session switch/logout removes old UI and ignores late replies; failed fetch/ack retains pending notices with a retry message. Dialog uses safe text, fits phone/desktop, avoids opening over an existing modal, and restores focus. Existing Sales alert counts and drafts remain intact.

Failure model: wrong recipient or leak (real HTTP auth roles/yard tests); stale/duplicate notice (real SQL concurrency, rollback and persistence); missed mini-bar/general PO edits (canonical committed DB lookup and existing routing regression); unsafe text/incorrect PO join (properties/Chromium); session race/failed acknowledgement (Chromium); unrelated runtime or remote PO changes (isolated outbound guards, frozen live source + task-only delta, app-only rollback and additive receipt migration).

Evidence: RED before code, isolated existing tools, focused and affected checks, differential lint/types, changed-line coverage, seeded properties, 5 syntax-checked manual mutants with at least 3 property-only. No new dependencies or commits. Live verification is read-only except additive migration; do not acknowledge or change real requests during verification.
