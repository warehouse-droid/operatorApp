# BIN order material and exchange size evidence

Scope: [acceptance cases 26–32](bin-order-workflow-spec.md). Front Desk owns order contents and replacement type; Dispatch selects the accepting dump, receiving order and permitted route. Spec approval: not obtained (autonomous run); scope follows the user's direct corrections and existing implementation/deployment authorization.

## Final verification

The final candidate completed validation at 2026-10-23T01:52:07.293Z after the last runtime edit.

| Layer | Result |
| --- | --- |
| Full affected BIN regression suite | 76 files, 338 tests passed |
| Reverse-order focused suite | 11 files, 78 tests passed |
| Deliberate faults | 6/6 caught by the expected assertions |
| Property-only mutation | Size-change guard mutation caught independently |
| Generated size combinations | 200 cases, seed 20261023; same-size routes remain allowed |
| Runtime static checks | 4 JavaScript files; 0 new lint/type errors, 0 secret findings |
| Changed JavaScript lines | 135/135 measured lines executed; no unmeasured changed JavaScript files |
| Changed branches | 101/109 covered |
| Candidate drift | None across the five release files |

[Validation audit](../deployments/bin-order-material-20261023/validation.json) records the tool versions, source hashes, individual stages and mutation results. Coverage is not complete branch coverage; eight branch outcomes remain unexercised. Whole-repository tests/types and dependency auditing were not rerun: this is the complete affected BIN suite, checked runtime scope, and no dependency changed. No schema migration or commit was added.

Toolchain: Node v20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0, fast-check 4.9.0, Playwright 1.62.1, pg 8.21.0. New functions stay within the existing complexity limit of 12.

## Acceptance mapping and failure model

- Cases 26–27: `bin-order-workflow-material.test.js` verifies persisted material IDs, Front Desk content/charge evidence, missing/inactive/ambiguous mappings, dump-site filtering, hostile material overrides, and old versus replacement contents. Browser coverage verifies read-only material and absence of a material selector.
- Case 28: the changed-size integration case verifies that receiving orders match the collected physical bin, even when the replacement size differs. A forged incompatible receiving order fails without creating execution parts. The browser selects an existing order by BIN reference/customer.
- Case 29: the full suite retains order identities, billing ownership, dump evidence, issued-work locks, re-selection, cross-date transactions, driver-start races, dependency ordering and all same-size exchange routes. Existing integration fixtures were supplied with their ordered material; their behavior assertions were retained.
- Case 30: domain, database and browser checks require a distinct replacement and delivery before collection for different sizes. The persisted pickup dependency points to completed replacement delivery. The generated property checks both allowed and rejected size/sequence combinations.
- Cases 31–32: draft final collection material follows the replacement order. An incompatible dump rejects the exchange atomically; accepting dumps retain their selection while the child material changes. A legacy original material ID does not override later replacement contents, and the immutable original visit remains unchanged.
- Deliberate faults remove the material override guard, offer unrelated materials, substitute incoming for outgoing contents, allow collection-first size changes, expose those UI options, or use the original return charge. Each is caught. Database guards rely on integration tests; only the size guard was additionally verified by the pure property suite.

The initial material tests, size-change rule, missing read-only browser material, stale return charge, draft-retarget acceptance check and legacy material precedence were observed failing before their fixes. Fixture setup corrections addressed UUID casts, completed-visit immutability and priced-line constraints. The browser option assertion checks its native `disabled` property because Playwright's generic disabled matcher did not recognize the disabled option. Assertions were not relaxed to accept invalid behavior.

## Reproduce

From `/home/ubuntu/apps/operatorApp`:

```bash
sudo -n env DISPATCH_SOURCE_SKIP_BUILD=1 \
  DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/bin-order-material-20261023/candidate" \
  MBBS_BIN_SELECTION_EVIDENCE_PATH="$PWD/server/deployments/bin-order-material-20261023/validation.json" \
  bash docker/run-bin-order-material-checks.sh
```

The persisted gauntlet runs the full suite, real application/browser interactions, static checks, throwaway mutations, reverse-order tests and changed coverage. It uses `mbbs-tests.slice`, bounded containers, a unique retention directory, registered Compose teardown, both Docker container listings and live health verification. Generated logs, browser output, mutated copies and test databases are disposable.

## Release

Deployed at 2026-10-23T01:52:41Z as `mbbs-operator-app:bin-order-material-20261023`, image `sha256:a0670f8b130a2f18345c591f17599c3c3e546947897b31505c17a548f6ebe056`, over `mbbs-operator-app:dispatch-latency-20261023`. Only five runtime files changed. All deployed hashes match validation; application configuration and the database, worker and Ollama services were preserved. No production test order was created.

Health, Planning, Front Desk, Driver and static assets returned HTTP 200; unauthenticated Planning API access remained HTTP 401. Rollback is retained as `mbbs-operator-app:bin-order-material-rollback-20261023`.

Records: [deployment](../deployments/bin-order-material-20261023/deployment.json), [live verification](../deployments/bin-order-material-20261023/live-verification.json), [cleanup](../deployments/bin-order-material-20261023/cleanup-audit.json).

A concurrent aggregate test run started during final host cleanup. Its temporary artifact folder was mistakenly removed after a container listing showed only production. Its Compose cleanup metadata was restored; that separate run is invalid and needs rerunning. Production data, application/source files and the completed BIN validation were unaffected. See the [cleanup race audit](../deployments/bin-order-material-20261023/cleanup-race-audit.json).
