# Special queue access, responsiveness and native PDFs

Spec approval: not obtained (autonomous run). The user authorized implementation and verification; no new packages or commits. Reuse the isolated Node/Postgres/browser runner. Preserve unrelated work and deploy only this scope over the current app/worker image.

Acceptance scenarios:
1. A Sales operator assigned yard 1 sees only yard 1 in list, details, quotes and SO PDFs; query/body yard spoofing never widens access. An operator with no yards sees no cases. SCM sees every yard. Yard filtering intersects server authorization and rejects malformed IDs.
2. Queue hydration uses a bounded number of SQL reads independent of case count, preserves existing DTOs, stage/closure priority before pagination, private cost redaction and Dispatch planning. Empty queues avoid detail reads. Compare live read-only timing before and after.
3. Special is the first and default tab. Explicit Regular URLs still work. Regular background events cannot replace an active Special form. Returning to a loaded Special tab does not fetch again unless invalidated.
4. Cards select immediately from loaded data, including rapid clicks; queue refreshes preserve the latest selection and unsaved input. No unconditional interval refresh. Concurrent identical loads coalesce, obsolete filter results cannot win, unrelated order events are ignored, unchanged results do not replace the DOM. Relevant events invalidate and refresh quietly when safe.
5. Both audiences have a yard filter with authorized options and cards identify their yard. Changing yard/stage/search picks a matching case.
6. Native SO/PO PDF verification uses a typed, permission-bound read-only transaction search before render.transaction, without record.load (which fails on workflow-locked orders). Missing/inaccessible/wrong-type identities never render. Invalid content remains rejected; Sales still cannot preview PO. Local caching remains effective until document changes.
7. No NetSuite commercial writes or retries in this task; SPREQ-000006 remains untouched. Existing REST order edits, discount and closure behavior remain covered by the related suite. If PDF script deployment requires the user's NetSuite upload, provide the tested file and distinguish local verification from live success.

Evidence layers: executable HTTP/repository/unit/property/browser checks; changed-line coverage; syntax/lint and strict types on new queue controller; three independently killed contract/property mutations; existing Special workflow suite; source hashes; scoped deployment health checks. External live PDF rendering after script upload may remain pending and must be reported explicitly.

Refinement from measured evidence: the Dispatch identity query itself takes 2.1–2.2 seconds across 115 saved plans and 18,041 order snapshots. Project only identity/relationship fields while expanding JSON, rather than copying full order payloads through the recursive query. Require identical planned references for nested groups, split orders, CO exclusion and return-only loads, and compare live DTO hashes. No expiry-based planning cache or restriction to recent plans is allowed.
