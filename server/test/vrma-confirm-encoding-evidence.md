# VRMA confirmation URL fix — 2026-09-15

## Problem and resulting behavior

Confirming **RP-UNI-AYR-3445-0914-1** sent the browser's correctly encoded `VRMA%3ARP-UNI-AYR-3445-0914-1` through the Operator yard guard. That guard used `decodeURI`, which preserves an encoded colon. The repository therefore failed to recognize `VRMA:` and passed the string into a bigint lookup. Live logs and an isolated HTTP test reproduce the exact PostgreSQL `22P02` failure.

The fix keeps path boundaries encoded and decodes each captured identifier exactly once, matching Express route-parameter behavior. It retains literal percent sequences in JSON IDs and preserves stored-yard checks. Malformed percent encoding receives HTTP 400. The release changes two runtime files: the yard authorization module and its small URL decoder.

- [Executable acceptance criteria](vrma-confirm-encoding-spec.md)
- [Exact change against the deployed baseline](vrma-confirm-encoding.changes.patch)
- Spec approval: **not obtained (autonomous run)**; the spec was prepared from the reported live blocker and existing authorized fix/test/apply workflow. Confidence is limited to the documented checks.
- Workflow: [old-coder](/home/ubuntu/.codex/skills/old-coder/SKILL.md), Tier 3 because the fix touches authorization.

## Spec → evidence

| Scenario | Evidence | Result |
| --- | --- | --- |
| 1: Encoded VRMA reads, line/page confirmations and packed edits use the same identity | Actual HTTP test with the reported reference; exact stored quantities 6 and 7 after test edits | Pass |
| 2: Foreign-yard requests remain forbidden and inventory/order state is preserved | HTTP 403 tests for line, page and packed edits; exact before/after database comparison | Pass |
| 3: Decode exactly once without changing route boundaries or JSON identifiers | 300 pure property cases, 32 HTTP property cases, literal-percent saved-order tests and mutation checks | Pass |
| 4: Invalid encoding returns 400; existing order families and endpoints retain yard checks | Malformed-URL HTTP tests; numeric/negative/UUID unit cases; existing Receiving, return, consolidation and job authorization regressions | Pass |
| 5: The actual order resolves safely after release | Read-only live guard verification and exact order/line preservation | Pass |

## Validation

- **80 focused tests across seven files pass**, in shuffled order with seed `20260915`. Each file runs in its own disposable database. Ten tests are new.
- The existing **SCM VRMA rollback harness passes**, covering the established VRMA preparation, loading and CO lifecycle.
- Five plausible bugs are killed by the complete new test suite and independently by property-only tests: **10/10 mutation checks**. They cover the original colon bug, double decoding, premature path decoding, bypassed yard authorization and decoding a JSON ID again.
- **19/19 changed executable lines are covered**. The new decoder has 100% statement, line, function and branch coverage. The complete yard authorization module has 100% statement/line/function coverage and 88.5% branch coverage; its remaining branches are not claimed fully verified.
- Syntax/lint checks pass for both runtime files and both new test files, with zero findings and the existing complexity/depth budgets. An initial complexity-13 finding was resolved by moving the existing empty-ID fallback into the decoder, with behavioral assertions unchanged.
- Type checking has **233 existing diagnostics and zero new diagnostics**. Both changed runtime modules use `@ts-check`.
- The built production image passes a decoder smoke test using the exact reported identifier.
- Secret scanning covers the runtime, tests and operational tooling, with no high-confidence findings. No dependency or schema changes were introduced. Toolchain: Node 20.20.2, npm 10.8.2, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0 and TypeScript 7.0.2. Dependency audit/license checks were not rerun because dependencies are unchanged.
- The final **482-file application suite has 2,451 passed tests and the same two pre-existing failures**, with zero new failures. The baseline failures are `P3.12: browser specs share one worker-owned database-pool lifecycle` and `quality non-regression: the gauntlet builds and validates the omit-dev runtime`.

RED evidence records four failing HTTP tests reproducing authorization/encoding errors, four failed decoder-stub tests, and a separate failing encoded saved-order deletion test. The JSON-body preservation test already passed before the fix; the JSON-decoding mutant makes it fail, demonstrating that it checks an existing invariant.

No browser rendering or cache behavior changed, so new browser interaction tests were not added. Real HTTP confirmation flows and the deployed-image decoder are exercised. Live verification uses a read-only yard-guard invocation, not a live confirmation POST; the Operator supplies the actual quantities when retrying.

## Reproduction and release boundaries

Run `bash server/tools/vrma-confirm-encoding-gauntlet.sh` from the repository root. It executes focused/legacy/static/mutation/coverage/secret checks, the full application suite and the type comparison. `python3 server/tools/vrma-confirm-encoding-evidence.py` collects source hashes, compares failures with the recorded baseline and checks every changed executable line. These commands do not deploy or confirm a live order.

Artifacts are in `server/test-artifacts/vrma-confirm-encoding-20260915/`. Frozen baseline, release/test snapshot, staged image and deployment metadata are in `docker/backups/vrma-confirm-encoding-20260915/`.

The release layers two files over `mbbs-operator-app:split-inbound-completion-20260915-v2` (image ID `sha256:f88721e506ea19ac24d47d0d5a21930236b9d32a421e4c21bde97450934e9240`). Deployment checks the current image and original file hash again, verifies the tested release hashes and preserves the existing Compose configuration. Unrelated workspace changes remain outside this release.

## Live result

At **21:01:25 UTC**, a read-only check reproduced the exact bigint error for the real order. The order was **Open**, at **3445 / location 1**, with **one line**. The check left the stored header and line unchanged.

Deployed successfully at **21:13:28 UTC** to both the application and webhook-worker services as `mbbs-operator-app:vrma-confirm-encoding-20260915-v1`. Application health is OK, and both installed files match the tested hashes.

Read-only verification at **21:13:51 UTC** confirms the real encoded request passes the assigned-yard guard (**200**) and still fails for a foreign yard (**403 / OPERATOR_YARD_FORBIDDEN**). There is no active NetSuite posting claim on the order. The header and line match the pre-release capture exactly. The order remains **Open**, at **3445**, ready for the Operator to retry confirmation with the intended quantity.

Machine-readable evidence: `evidence.json`, `live-before.json`, `live-after.json`, and `deploy.log` in the artifact directory. Deployment metadata, the prior image/configuration, and installed hashes are retained in the backup directory.
