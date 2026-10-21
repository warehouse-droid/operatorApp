Stocking line actions, 2026-10-06

Spec approval: not obtained (autonomous run). Tier 3: purchasing, private conversations and concurrency.

1. Each Stocking Purchase material has Add to PO/TO proposal, Reject, Reply and Resolve controls inside its own card. Transfer materials have Reject, Reply and Resolve; existing TO conversion remains unchanged. Sales replies are per material. No request-wide default or checkbox selection can include another line.
2. Replies persist the target line, thread, ETA or SO reference and waiting status. Sales can reply only as the original requester after instructions for that material. Existing historical request-wide instructions stay readable.
3. Resolve stores the target material's canonical existing mirrored PO and valid ETA, closes only that line, and notifies Sales with its item name. Other pending or proposed lines remain open. Final closure occurs when all lines are terminal.
4. A line with accepted demand or a TO/handoff commitment cannot be manually resolved. Another line's purchase demand does not block resolution. PO records, quantity and UOM remain unchanged.
5. Foreign, invalid or missing line IDs on multi-line requests, stale revisions, closed lines and unauthorized roles produce no writes. Single-line legacy callers remain unambiguous and supported. Concurrent retries resolve a material once and preserve its immutable PO/ETA.
6. Per-line rejection/proposal clears only its own waiting status, preserves other threads and gives the correct request status/queue.

Failure model: wrong-line writes (multi-line DB and browser tests); unrelated commitments blocking or being erased (mixed outcome tests); stale or concurrent updates (revision/race tests); unauthorized or hostile input (authenticated HTTP, parser properties, escaped browser text); premature case closure (rollup assertions); request-wide fallback (multi-line missing ID assertions).

Setup: existing Node, Postgres, Playwright, c8, TypeScript, ESLint and fast-check from the cached test image. No dependency additions, migrations or commits. Capture only task source baselines and retain tests/logs/spec/evidence. Use bounded isolated Compose with teardown registered before startup. Deploy only the tested file delta to the current app image with rollback and source verification.

User clarification: STREQ-000082's POB03992 and ETA 2026-10-08 apply only to BWS-HUNT70S-RDM-SM. Restore its other three materials to pending. Use a guarded transaction, keep the original audit event, append a line-specific corrective event, preserve quantities/UOM/evidence and original resolver/time, and rehearse rollback before the production correction.

Clarification from existing planner behavior: accepting another material may regenerate/consolidate editable proposal and proposal-line IDs. Tests permit that regrouping while requiring the original material's demand ID, requested/reviewed/accepted quantities, allocation totals, status, conversation and decision to remain unchanged.

Legacy test alignment: one-material Resolve browser tests now use the Resolve material label and keep all PO/ETA validation, role, persistence and notification assertions. Reply response assertions now expect the new line conversation metadata while requiring all operational material fields and SQL line rows to stay unchanged. Resolutions render inside material cards, without a duplicate request-level result. Original test files are archived.

Archived instruction identity: a scoped instruction retains its material ID even if its event foreign key becomes null. It can authorize replies only on that material; genuinely historical request-wide instructions remain readable and actionable. UI and authenticated HTTP tests reproduced the wrong-material permission before the fix.

Sales edit preservation: editing an open Stocking request before a material decision must retain each existing material's conversation and waiting state. Removing a material must not make its archived instructions authorize replies on another material. Exercise the real edit service and repository alongside the authenticated reply endpoint.

Allocation updates: when allocation reconciliation makes a material terminal, its historical conversation remains readable but cannot keep the request waiting for SCM. Reconcile the waiting marker for the remaining open materials. The webhook worker invokes this repository as well as the app, so publish the same tested allocation repository and new line-state helper to the worker in a two-file overlay. Preserve both services' environments and unrelated source; preserve the database and Ollama containers. Drain active webhook work before replacement and retain rollback images.

Type comparison records duplicate diagnostic occurrences against the original declarations and modules. Compiler spelling suggestions can change after declaring the new browser global; normalize only TS2551's spelling hint to the equivalent TS2339 missing-property diagnostic, retaining the property, receiver and occurrence count.

Commitment verification: a rejected material and a material committed to a TO remain locked for Resolve. A pending sibling without a commitment can still be resolved when only another material has a local TO; the TO must remain unchanged. Legacy, cancelled, Pickup and executing request operations cannot be manually resolved. Moving a material to the waitlist clears only its own waiting state, preserves the remaining conversation and reuses the same child request on an idempotent retry.

Coverage accounting: espree, already present through ESLint in the cached test image, compares statements after removing all source-position fields. Exclude only AST-identical statements containing JSDoc type assertions, and record these lines separately. Verify that a changed comparison and a new statement remain executable changes. No dependency installation or package/lockfile changes are needed for this development-only parser.

Worker packaging correction: the worker's older image lacks regular-stock-domain.js and its regular-stock-input.js import. The first two-file release rolled back on the module verification error. Include these two unchanged, tested dependency files in a new four-file worker overlay; verify the existing stock-request-domain.js import matches the tested source. Retain the failed release and rollback evidence. Application behavior and its deployed source are unchanged.
