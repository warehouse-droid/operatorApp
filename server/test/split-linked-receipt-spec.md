# Grouped split execution and POB04054 receipt

Tier 3: financial posting, append-only execution evidence, concurrent receipt claims.
Spec approval: not obtained (autonomous run). User authorized the specific IR fix.

Acceptance criteria:
- A completed group route containing child S1 records the existing parent-line allocation when the saved plan proves the child, parent, exact line, item, quantity, load and stop. A 27-unit S1 allocation never consumes its 2-unit S2 sibling.
- Preserve ordinary exact-reference execution, pickup-place checks, same-load pickup requirements, immutable history, and receipt gates.
- Reject a different group, child, parent, line, item, insufficient child quantity, wrong route/stop, malformed saved data, cancelled allocation, and incomplete job. Sum all active allocations for the target/line before comparing child quantity.
- Replaying the actual completed pickup then delivery adds only missing evidence. Repeated/concurrent replay cannot create duplicate events, receipt jobs, claims, or remote receipts.
- Migration application and rollback are transactional and perform no historical backfill. A failed recovery transaction leaves no new evidence/receipt command.
- Bounded operational recovery checks the live PO's exact nine remaining lines, allocation IDs, job IDs, completion evidence and absence of receipts. Admit through the normal durable posting pipeline, verify exact payload before commit, then verify the resulting NetSuite IR and unchanged S2.

Failure model: an overbroad parent alias could receive a sibling (identity/quantity negatives and generated quantity properties); replay could duplicate a receipt (unique-event and admission concurrency tests); partial recovery could leave claims behind (transaction rollback); a reopened/cancelled job could post (existing receipt adversarial tests); stale remote quantities could overreceive (live source verification and existing adapter revalidation).

Setup: existing Node/PostgreSQL and standard disposable bounded Compose runner; no dependencies, no git commits, no production data in tests. Persist focused tests, SQL migration, reproducible check/recovery scripts and concise evidence. Keep operational rollback/audit outside disposable test artifacts. SQL path coverage is scenario based; no PL/pgSQL coverage/type/lint extension will be installed on this shared host.
