# Dispatch status independence — 2026-10-15

Spec approval: not obtained (autonomous run). User explicitly authorized Dispatch to use its own planning/delivery status, independently of NetSuite fulfillment and local Operator load status. The previous Billed-only UI exemption and Operator-load dependency blocker are superseded, deliberately, by this contract.

Tier 3: dependency allocation writes require real PostgreSQL integration tests. No new packages, migrations, commits, or production data resets. Use captured live source; preserve unrelated dirty workspace changes. Tests use the standard disposable bounded Compose stack and registered teardown. Release only verified overlay files, with app-only rollback and health checks.

First release: restore SOM06964 and prevent the same PO-link failure.

1. For an SO with no Dispatch completion, all NetSuite fulfillment labels (including Pending Billing and Billed), Operator loading/packing statuses and fulfilled quantities leave Link PO/TO available. They cannot mark the card Dispatch completed.
2. A current Driver completion or manual Dispatch completion makes the order read-only. Stale NetSuite-derived completion fields are cleared by current authoritative Dispatch evidence. Stored audit events and NetSuite/Operator fields remain intact.
3. PO/TO dependency preview and writes ignore Operator preparation, packing, loading and fulfillment quantities. Actual Driver starts/completions, affected completed/cancelled plans, edit leases, stale signatures/revisions, offline events, and allocation/capacity rules remain enforced.
4. Split blockers for existing PO/TO allocations remain enforced. Follow-up work removes Operator-derived split restrictions without discarding Operator progress or allocated quantities.
5. SOM06964 must pass a read-only production PO-link preview and render Link PO without a Dispatch completed label after release. No PO is selected or linked automatically.

Failure model: stale cached completion can hide actions (UI + projection tests); removing a mixed status check can accidentally permit route mutations after Driver start (real database negative tests); linking quantities can corrupt inventory (existing allocation integration tests); lost concurrent release (captured image/hash fences); test stacks can affect live host (bounded resources + finally teardown).

Contract revisions to existing tests are explicit: Pending Billing and loaded/fulfilled Operator statuses cease being negative cases for Dispatch Link PO; NetSuite completion no longer means Dispatch completion. The Control/Operator reopen restrictions and actual Driver execution negatives remain unchanged.

Release sequencing amendment: user explicitly requested “please release first then perform other fix.” The focused release is gated by six UI and real PostgreSQL tests, healthy teardown, exact image/hash fences and live read-only verification. Broader regression, static, coverage and mutation checks follow immediately; this is an interim release, not a claim that the full gauntlet has passed.


Additional authorized correction: SOM06964 StoneArch 28 PC line (source line 5137294) becomes 28 SQFT locally; its existing seven descriptive pieces remain seven. User explicitly allows excluding this line from sync. Add an audited, reversible per-line sync hold, preserving source-field values against upsert/deactivation while allowing local Operator progress updates. Other lines and NetSuite remain unchanged. Use a small database migration with no new dependencies. Failure model: accidental whole-order freeze (sibling sync test), accidental local work freeze (packing update test), silent override loss (real sync upsert + missing-line test), invalid hold identity (constraint test), rollback data loss (release/resume + schema rollback rehearsal on empty holds). Operational mutation checks exact live identity and quantities, no allocations/route/Driver start, records before/after and testAdmin audit, and rehydrates local Dispatch catalog. No external writes.

Regression found during the first full run: clearing NetSuite completion also restored an old SCM Reconcile Review display field. Fix the projection merge without changing that existing assertion. This did not re-block SOM06964; its live planning and PO preview remained available.
