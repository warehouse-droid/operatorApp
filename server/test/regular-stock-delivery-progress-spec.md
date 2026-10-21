# Delivery retry and progress

Spec approval: not obtained (autonomous run under the requested fixes and deployment authorization). Tier 3: asynchronous external writes, retry, permissions. No dependencies, package changes, or checkpoint commits. Use the existing isolated PostgreSQL/Node/Playwright runners; preserve unrelated workspace changes.

Acceptance scenarios:
1. SO preview returns a durable operation immediately, before a blocked NetSuite read completes. Polling shows checking SO quantities, checking Target Yard stock, and calculating units/PALLET. Interactive NetSuite priority applies throughout.
2. A failed check exposes Retry with unchanged inputs. Each explicit retry starts a new attempt. A repeated delivery command ID resumes the same attempt, rejects changed payloads, and cannot run twice concurrently.
3. Submit, SCM approve, and Sales/SCM retry report actual stages: checking SO, checking stock, creating TO, approving TO, preparing ticket, queueing print. Printer status distinguishes queued, printing, printed and attention. Never infer physical printing from a queued job.
4. All page buttons and editable fields are disabled during a Delivery operation, including controls created by a render. They restore correctly on success or failure; a second action cannot start while busy.
5. A transient polling/acceptance failure resumes the same command ID. Reload can discover active work. Orphaned running operations become visibly interrupted after restart; queued work resumes. Explicit retry recovers any persisted request/TO using existing SO/TO/print identities.
6. Sales retry uses Delivery's saved SO and dedicated retry path, bypassing the older SO confirmation form. Manual routes cannot bypass SCM approval. Existing Pickup/Stocking API and behavior stay unchanged.
7. Actor and role/yard access are enforced; only the actor can inspect their operation. Revoked privileges block queued execution. Invalid action, UUID or oversized payload is rejected. Queues are bounded to one active operation per actor; completed operation records expire after 30 days.
8. Existing Base/Target, backorder/full-line/fallback, shortage, PALLET, 3445↔2967 automatic and 150/12441 manual rules remain covered by existing regressions.

Failure model and evidence plan:
- Duplicate remote write: simultaneous worker/idempotency tests plus existing marker recovery tests; no live order creation during tests.
- Lost browser/server response: deferred-network HTTP test, browser retry/reload cases, restart recovery and same-ID replay.
- Permission escape: negative HTTP and queued role-revocation cases.
- Partial approval/create/print failure: integration retries with persisted request/TO identities; truthful printed-state browser assertions.
- Infinite busy/no retry: browser failure/restore and dynamically inserted control assertions.
- Queue growth/worker starvation: actor serialization, bounded runtime concurrency, terminal cleanup tests.
- Migration/release risk: additive table only; rollback rehearsal in disposable DB; scoped image overlay with previous-image rollback. Keep additive data on app rollback.
- Gauntlet: failing regression tests before fix, full relevant suite with two recorded unrelated baseline failures, syntax/type/lint checks, changed-line coverage, property tests and manual mutants, shuffled suites, real browser/HTTP, read-only deployed smoke checks. Record any untested failure modes explicitly.

Incident evidence: SOB121732 read in ~3.4 seconds under interactive priority. Material line locations are 2967; one material line has 490 SQFT backordered. No saved simple Delivery request or TO exists from the failed attempt. Existing Delivery routes use the background queue and hold long HTTP requests through NetSuite work. No historical request timing proves the exact substep of that 524.
