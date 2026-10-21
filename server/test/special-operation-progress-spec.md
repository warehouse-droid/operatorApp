# Special request operation progress and SO-only closure

Spec approval: not obtained (autonomous run). Tier 3: remote order closure and concurrency.

Acceptance scenarios:
1. Sales SO creation, SCM PO creation, SCM approved adjustments, and closure disable form actions immediately and display accessible progress while the HTTP operation is pending. Double clicks and repeated submits issue one operation; posted fields retain their values.
2. Creating SO/PO and applying adjustment/closure states from the server also disable the selected case. Other cases remain navigable. Pending reviews and failed operations remain actionable. Success and errors release the local busy state without losing a failed form draft or enabling a previously disabled field.
3. Sales closes an unplanned SO-only request through the existing REST closure adapter. The SO is verified remotely closed before local cancellation. No PO is invented. Requests with POs still wait for SCM confirmation; Sales cannot approve them.
4. A legacy SO-only closure_pending request without a review can resume from Sales. Persist a closure plan and reuse it after lost responses; never repeat a completed remote close. Scope, revision, dispatch planning, execution, and concurrent operation guards remain enforced.
5. Order pairs still require both orders verified closed. SO-only plans require the exact SO. Reject missing/duplicate identities and PO-only plans. Persisted Sales completion responses must not expose SCM plan data.
6. SPREQ-000009 is recovered only through its recorded Sales closure request after checking its exact SO identity and absence of a PO. SPREQ-000006 and SPREQ-000007 are unchanged. NetSuite mutations use REST, never a RESTlet.

Failure model: disabling before payload collection could omit fields (delayed browser HTTP tests); a stuck busy flag could prevent recovery (failure and reload tests); missing PO could bypass SCM (integration authorization tests); partial close could cancel local data (adapter and repository verification tests); retries could duplicate writes (lost-response property); concurrent submissions could apply twice (existing advisory lock plus repeated-submit tests); unrelated requests could change during recovery (exact identity/revision and before/after business hashes).

Setup: use existing isolated Docker runner/Postgres, existing Playwright/Node test/fast-check/c8/TypeScript/ESLint. Add no dependencies and make no commits. Capture deployed baselines; add focused tests, mutation/check scripts and evidence. Apply only listed runtime files over the current image. No schema change is needed. Targeted integration fixtures roll back. Live recovery is limited to the already-requested closure of SPREQ-000009.

Additional race identified during review: an SO status webhook must not finalize a request with a closure journal before the closure service completes verification. Legacy requests without a journal retain their existing reconciliation behavior. The added regression test first observed premature local cancellation.
