# Dispatch review pool repair

Spec approval: not obtained (autonomous run). The user authorized auditing and resolving every review-blocked Dispatch order, including making SN1399025 planable. Tier 3: receipt allocation and authoritative planning eligibility.

## Acceptance scenarios

1. An active PO split retains its exact split identity in the ordinary Dispatch feed, explicit search, and catalog. The source PO, cancelled predecessor, and unrelated orders are not marked as that split.
2. A Queued active split whose own operational state is authoritative stays Queued and planable when its parent has a reconciliation review. PO/TO Schedule and Dispatch agree. Hold and actual Driver completion remain restricted; no plan or Driver evidence changes.
3. An Item Receipt memo may identify a source PO's remaining portion through its explicitly configured, distinct dispatch reference. Only that exact residual target receives the quantity, up to its per-line capacity. The original parent PO reference alone does not authorize residual receipt allocation.
4. Unknown, cancelled, cross-source, ambiguous, colliding, and over-capacity references still require review. Existing child-reference and unreferenced-receipt behavior stays intact. Quantities are conserved and a repeated reconciliation yields the same allocation.
5. Audit the complete Dispatch catalog, live response paths, schedule block flags, and open reconciliation cases. Repair only demonstrated false reviews through the reconciliation service, first under rollback. Preserve a private production backup and before/after audit evidence. Restore any proven legacy review-only schedule status to its operational value after reconciliation succeeds.
6. SN1399025 is Queued, has no review flag, and passes the real plan-save eligibility guard. All reviewed families end without false review cases or stale catalog flags; completed and held work keeps its normal restrictions.
7. Deploy only the scoped changes on the current production image, preserve the schedule-column enhancement and other running features, and verify live behavior and health after deployment.

## Failure model and setup

- Wrong child or source receipt allocation: exact-reference unit/integration tests, collision and overflow controls, conservation properties, production-shaped rollback replay.
- Family review leaking onto a healthy split: real repository/API regression with a parent review and operator-controlled child, plus cancelled-parent identity controls.
- Accidental release of completed/Hold work: existing planning guards and negative integration tests.
- Repeated or concurrent repair, partial writes: transactional repair, row/evidence checks, stable second-pass results, private backup, audit and post-apply inventory.
- Unrelated dirty work deployed: copy the running image's three source files as the baseline, apply the same scoped patch, and compare before/after hashes.

Use existing Node test, PostgreSQL, fast-check, coverage, and lint tooling in disposable containers with no NetSuite connectivity. No new dependencies, migrations, git commits, or remote order writes. Add focused tests and reproducible check/repair tools; record every verification layer and any baseline failures in the evidence report.
