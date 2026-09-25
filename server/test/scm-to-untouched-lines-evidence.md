# Untouched SO line TO-linking — evidence

User approved the behavior on 2026-09-16. Tier 3: operational quantities and
concurrent packing. [Acceptance specification](scm-to-untouched-lines-spec.md).
The detailed executable specification was an autonomous refinement of the
approved behavior and was not separately reviewed by the user.

## Implementation

Only `src/scm-dependency-preview-service.js` changes at runtime. Explicit,
fully resolved TO allocations check the selected canonical SO lines. Aggregate
packed/confirmed headers and packing on other lines no longer cause rejection.
Preparing ownership/status, any loaded SO quantity, selected line activity,
TO/receiving/driver/execution activity, and the existing plan/identity guards
remain protected. Other mutation actions retain their original guard behavior.

Commits acquire the same order advisory locks used by operator packing and hold
canonical header/line row locks through the existing atomic command. No package,
schema, order status, packed quantity, or NetSuite transaction is changed by
deploying this fix. Actual links still use the user's selected mode and quantities.

## Acceptance mapping

| Spec | Evidence |
| --- | --- |
| 1: untouched line, modes, extension, exact preservation | Real direct/replenishment command tests, duplicate retry, exact source-row comparison |
| 2: selected work and mixed pallet selection | Eight activity-column cases and rejected full-command/source comparison |
| 3: preparation and execution stay protected | Seven status cases, ownership/time/local-status cases, other-line loading case |
| 4: explicit identities and conservative fallback | Key-first/legacy-ID full command, malformed/missing/partial allocations, action guard |
| 5: groups and splits | Canonical source-line preview tests before and after packing |
| 6: existing guards | TO outbound/header/receiving/closed, driver/stale target, PO timestamp compatibility, existing preview/unlink/policy suites |
| 7: serialization, rollback, retries | Independent PostgreSQL clients sharing operator locks, held row-lock checks, injected finalization failure, idempotency |
| 8: reported live shape | Read-only production replay with the candidate and again after deployment |
| Confirmed-route preservation | Real command refresh/materialization test compares every packing field before/after |

## Verification

Reproduce from the repository root with:

```bash
sudo bash server/tools/scm-to-untouched-lines-gauntlet.sh
```

The runner uses a fresh isolated PostgreSQL 18 database and the existing
`mbbs-retired-confirm-test:20260914` image. Actual versions: Node 20.20.2,
fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0, TypeScript 7.0.2. No new dependencies
were installed. Existing local edits were preserved and no git commit was made.

- Final original-code replay: **45 tests, 32 passed, 13 failed**. Failures include
  the actual whole-order rejection, missing canonical split guard, and missing
  operator/row locking. The failure assertions preceded implementation.
- Final focused suite: **87 passed, 0 failed**, including **45 new tests**.
- Changed executable lines: **53/53 covered**, no uncovered changed lines.
- Mutation checks: **11/11 killed** by behavioral assertions in disposable
  processes. No shared source was mutated.
- Generated activity test: **64 cases**, fixed seed `88381102`, checks both
  permitted and rejected outcomes. Its independent mutation run kills **7/11**;
  PO-action and three lock mutations survive this property alone because it only
  generates TO previews without commit locks. Deterministic action and concurrency
  tests kill those four. The property is not claimed to verify those behaviors.
- Reverse file-order executions: all focused files pass individually in reverse
  order; final combined run also passes.
- Syntax, scoped lint, source/test/tool secret scan and `git diff --check`: passed.
- TypeScript baseline/final: **233 existing diagnostics each, zero new diagnostics**.
  The legacy preview service is outside the repository's checked module list;
  its syntax, lint and real PostgreSQL execution are verified, not full static
  type safety.
- Full MBT baseline and final: **2,580 tests each, 2,578 passed, 1 failed,
  1 skipped**, across 505 files. Identical failing test; **zero new failures**.

The unchanged baseline failure is `P3.12: browser specs share one worker-owned
database-pool lifecycle` in `p3-gauntlet-contract.test.js`.

Source SHA-256:
`99a33a8ad8093e184b56d6b0728d3a71a05aab24bf1980ae6657435273f0322b`.
Detailed logs, coverage and mutation results are in
`server/test-artifacts/scm-to-untouched-lines`.

## Deployment

Deployed `mbbs-operator-app:scm-to-untouched-lines-20260916-v1`, image
`sha256:d222ca5751d074b1327effa53ed57f82513d8e6b490366a71a0f50bc5acef5f9`.
Only `src/scm-dependency-preview-service.js` differs from the prior production
image. The entire candidate runtime matched the source used in verification.

Commands executed from the repository root:

```bash
sudo -n python3 server/tools/scm-to-untouched-lines-deploy.py prepare
sudo -n python3 server/tools/scm-to-untouched-lines-deploy.py apply
```

Candidate migration/startup/health smoke passed in a disposable database. The
release retained the app's environment, mounts, ports and command. The webhook
worker, database and Ollama container identities/start times remained unchanged.
The app became healthy with zero restarts, passed startup-log checks, and its
live source hash matched the verified source. Rollback image and private
configuration records are under `backups/scm-to-untouched-lines-20260916`.

The post-deployment read-only preview returned `materialAllowed: true` with no
blockers for SOA08838's 52.25 SQFT Trevista allocation to TOB01102. Adding the
already packed pallet returned `withPackedPalletAllowed: false` and the expected
`OPERATOR_ACTIVITY_STARTED` blocker. No production link, order-data repair,
packing reset or NetSuite write was submitted by the release process.

## Execution notes and limits

A compatibility test caught that checking retained confirmation timestamps for
all actions would alter PO behavior. The timestamp check was restricted to
explicit TO selections, then focused checks/mutations/types were rerun and a
fresh full regression run started. The superseded full run was stopped and its
log retained separately. One additional isolated test startup exhausted Docker's
available test subnets; only this task's obsolete disposable runner was stopped,
and the baseline replay then completed successfully. No existing environment
or production network was removed.

The live candidate replay allows the 52.25 SQFT Trevista allocation and rejects
adding the already packed pallet line. It runs in a repeatable-read, read-only
transaction. The actual link is not submitted because the user's chosen transfer
mode and allocation inputs belong to the existing link dialog. For this case,
select five Trevista layers and leave the packed PALLET allocation at zero.

No browser UI code changed. No new browser test was added; backend behavior is
covered through real repository and full command execution plus live previews.
Supply-chain audit is not rerun because no dependency changed; source capability
review and secret scanning cover the new code and tools. Production locking is
validated in isolated concurrent transactions, not by blocking live operators.
