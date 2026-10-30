# Delivery SO kit fulfillment — 2026-10-29

Tier 3: inventory posting and duplicate external transactions. Spec approval: not obtained (autonomous run). User requested the kit-line fix after diagnosis of seven affected delivery orders. Existing complete-kit policy remains applicable.

Acceptance:
1. Saved physical component loading maps to the exact current NetSuite kit parent. Mixed ordinary/kit payloads post the ordinary line and parent, never the child line. Retain immutable physical loading evidence and exact parent/member identities in durable posting evidence.
2. Reuse existing complete-kit validation: all members, same positive whole-kit count, current remaining quantity, exact stable keys/items/locations and current kit definition. Reject missing, fractional, mismatched, duplicate, stale, cross-kit or unsupported members before POST.
3. Ordinary delivery orders preserve behavior. Read the authoritative REST source with explicit billing-line deselection; missing ordinary lines must still fail safely. An unselected kit must be deselected.
4. Recheck source/definition immediately before posting. Existing external-ID recovery, location splitting, leases, claims and once-only finalization remain effective. An ambiguous posted kit must be recovered without another transform, even if the source later changes.
5. Already fulfilled sources reconcile without kit source reads or a new IF. Reconcile only the seven confirmed kit alerts after live verification; leave the two unrelated legacy alerts unchanged.
6. Deploy only the scoped patch over the current live image. Preserve production configuration, dependencies, completed loading/delivery records and prior receipt fix. Validate current/live candidate hashes and production health; retain rollback and operational audit.

Failure model: wrong parent/SKU/line (exact identity and repeated-SKU tests); lost/duplicated quantity (generated quantity and whole-kit invariants); stale edit or source read failure (pre-POST guard tests); double fulfillment after timeout (durable recovery and concurrency tests); local loading changed (real DB immutable snapshot/finalization assertions); unrelated release content (source hashes and image overlay).

Setup: existing Node, PostgreSQL, fast-check, TypeScript, ESLint and c8; no new dependencies, schema migration, frontend flow or git commits. Tests use the repository bounded disposable runner and unique artifact directory with registered teardown. Operational reads and seven-record reconciliation run only in the live app. No test database uses production data or credentials.

Clarification from source review: the shared read-only source result will explicitly identify kit-parent rows. This ensures an order with only ordinary lines loaded still excludes its unselected kits; it also prevents an admin selection from treating a kit parent as ordinary physical loading. No new external API call or endpoint is introduced.
