# IR/IF Admin routing gate

Spec approval: not obtained (autonomous run). Implements the user's authorized
request to control the new posting flow with an on/off feature gate.

- Show `IR/IF posting via RESTlet` in Admin Feature Gates, independently of MBT.
- On routes supported IR/IF posting through the deployed RESTlet. Off or a
  missing database flag returns to the existing native flow on the next attempt.
- Deployment enablement, direct access, and a configured URL are required.
  Closing any boundary prevents a database gate from activating the RESTlet.
- Read the database gate on each attempt; a database failure stops the attempt
  before any NetSuite request. Never cache an enabled result or silently post.
- Preserve all existing client response checks, external IDs, native kit and
  unsupported-field routing, yard posting controls, and ambiguous-post recovery.
- Seed the new database flag off, idempotently, preserving an existing choice.
  Enable this deployment through the audited Admin command to preserve the
  user's existing instruction to use the new flow.

Failure model: an invisible or misleading switch (catalog and policy tests),
stale enabled state (sequential toggle test), bypassed deployment controls
(exhaustive boolean combinations), duplicate POST after error (existing client
regressions), lost gate choice on restart (migration replay), and unrelated
deployment changes (capture live source; apply only this task's patch).

Use existing Node tests, PostgreSQL, TypeScript, ESLint and c8 in the bounded
isolated Compose harness. No dependencies, credentials in tests, or commits.
Register teardown before starting; retain evidence and remove test resources.
