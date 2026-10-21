# NetSuite attention reconciliation — 2026-10-03

Spec approval: not obtained (autonomous run). Authorization is the user's request to resolve queues, with the explicit constraint to verify existing IF/IR before any retry.

Failure model: duplicate transactions after uncertain results (recovery tests forbid transforms); false completion from unrelated/partial records (strict source, external ID, item, line, quantity, unit and location checks); lost Operator evidence (no quantity edits or fabricated loads); stale queue state (waiting-state regression); concurrent workers/repair (leases, row locks, expected status and immutable evidence); unrelated deployment changes (runtime-image guard and reviewed overlay).

Acceptance criteria:

1. A prepared `waiting_evidence` or `discovered` candidate stays in that state. The processor makes no NetSuite request, transform, claim or attention update. Existing missing-evidence reason survives.
2. A fully prepared source-read failure remains visible to Admin and creates no transaction. A ready candidate still requires Operator and effective Driver evidence, existing source-drift and yard checks.
3. Explicit recovery with a missing or invalid retained payload, no recovered record, or an unavailable lookup must never create a new transaction. Exact verified recovery completes with the original transaction ID and immutable payload.
4. Unsupported-yard attention retains its actionable error message.
5. Reconcile existing production records only after live read-only IF/IR and source verification. Preserve the original intent and record an audit containing verification evidence, method and discrepancies; never silently alter old quantities, claim physical loading, or create an IF/IR during the maintenance reconciliation.
6. Classify unfulfilled orders awaiting physical proof as waiting. Genuine missing lineage, remaining quantities and inconsistent evidence stay actionable until resolved; an empty attention list is not sufficient evidence of success.
7. Any extension for NetSuite auto-included non-stock rows or historical unit normalization must verify against authoritative source lines, reject unrelated inventory/incorrect quantities/units, and have a separate executable regression before implementation.

Setup: use existing Node test tooling and isolated disposable Postgres clones; no dependency installation, no git reset/commits, no production schema changes planned. Persist read/repair tools and evidence under `tools/netsuite-attention-20261003` and `test-artifacts/netsuite-attention-20261003`. Private production evidence stays under `/home/ubuntu/operatorapp-investigations/netsuite-attention-20261003`. Run focused and affected full suites, baseline-aware types/lint, meaningful changed-line coverage, properties, manual mutation and real read-only execution. Any broader checks skipped or pre-existing failures must be recorded.

Investigation refinement: historical base-unit snapshots predate the existing transaction-unit normalization. No global tolerance or unit guessing will be added. Future Delivery SO payloads will explicitly deselect authoritative Sales Credit and Delivery Charge source lines, preventing NetSuite from silently including them. Verification remains strict; historical extra lines require a separately audited source comparison during this maintenance operation.

8. Returning real waiting work to the queue must not starve later ready candidates behind the worker batch limit. Ready/discovered work takes priority and waiting entries rotate by last check time. Admin separates waiting work from actionable errors while retaining visibility and automatic resumption.

9. A registered active first split may retain its parent SO locally. Resolve that explicit alias only when no materialized child exists, match its saved item and stable line identity, use only its bounded planned split quantity, and require immutable Operator/Driver proof. Never infer a parent by trimming a suffix for posting. Unregistered/retired aliases and ambiguous quantities remain blocked.

10. Explicit audited Admin resolution has the same historical-event authorization in preparation as in the existing claim boundary; automatic historical posting stays disabled. For SOA08709, independently verify the existing IF and remaining 10 PC against saved Operator load 1170 and matching Driver drop-off, then post only that remaining line through the durable candidate flow if it is still unfulfilled.

Broad-suite refinement to criterion 3: preserve the existing location-part recovery contract (P10). When a durable per-location plan exists, verify each part and let its established lease/attempt boundary resume only an unattempted or definitively rejected part. Missing, uncertain or already posted parts may never be blindly reposted. A missing ordinary IF still stops recovery entirely. The existing P3/P4/P7/P10 tests exercise this distinction.

Live limitation for criterion 10: NetSuite rejects SOA08709's exact REST source read with `USER_ERROR`, stating that a user-defined workflow locked the record. The read-only rehearsal stopped before any posting. Retain an actionable Admin error until that NetSuite workflow is resolved; do not bypass the source-verification guard.
