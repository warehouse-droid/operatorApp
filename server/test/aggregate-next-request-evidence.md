# Aggregate request cycles and SCM material memos

The behavior contract is [aggregate-next-request-spec.md](aggregate-next-request-spec.md). This was an autonomous implementation; explicit spec approval was not obtained. Both changes were requested by the user, with deployment authorization retained from the conversation.

## Behavior and evidence

| Requirement | Executable evidence |
| --- | --- |
| Completed requests release the eight-card form, including another request for the same delivery date | Repository completion/history test, 40-case lifecycle property, requester browser report → acknowledgment → new request → reload |
| One unfinished request per yard, including reassignment and races | Partial unique index; 25 distinct competing submissions; separate transaction/lock rehearsal for report versus reassigned submitter |
| Old quantities, discrepancies, acknowledgments and audit events survive | Before/after repository snapshots; both migrations rehearsed against historical rows; transactional rollback on conflicting legacy requests |
| SCM can save or clear a memo independently for all seven materials | Domain, HTTP, repository and SCM browser tests; 100-case memo property; persisted row comparisons |
| Notes do not change quantities or completion/review state | Domain and repository snapshots before and after memo commands |
| Safe stale/retry/authority behavior | Expected revisions, operation retries and conflicts, lost SCM authority, unauthorized HTTP route, competing memo saves, audit insertion rollback |
| Chinese and literal HTML-like text survive save/reload | Browser memo entry, language switch, saved table and reload assertions |

The new lifecycle and memo tests failed before implementation. Logs are retained in `test-artifacts/aggregate-next-request/red.log`, `red-memos.log` and `red-memos-browser.log`.

The focused suite has 66 passing tests. Syntax, lint and domain type checks pass. Running the six test files in shuffled order also passes all 66 tests. All 54 changed instrumented JavaScript lines are covered. Whole-file branch coverage is 98.33% for the repository, 95.91% for the domain, 81.81% for the router, 61.14% for the SCM client and 50% for the translation helper; this is not a claim of complete branch coverage.

Six deliberate faults were each rejected by their focused suite and property-only rerun: completed requests occupying the workspace, confirmed requests disappearing, the wrong blocking request, memo role bypass, wrong-material memo assignment and memo changes overwriting loads. All 12 mutation runs failed as expected.

The migration rehearsal applies both migrations twice, checks empty defaults and memo size constraints, preserves existing snapshots, exercises the new uniqueness rule, and rolls back completely. It also proves why reinstating the old daily uniqueness constraint is unsafe after another completed request for the same day.

No dependencies were added; no fresh dependency audit was needed. No live operational request was submitted or modified for testing.

## Release verification

Release artifacts are in `test-artifacts/aggregate-next-request-deployment-20260922/`. The runtime patch is limited to ten Aggregate files and is applied over the current live `pickup-existing-if-20260922-v1` image, preserving its unrelated fixes.

The rollback image keeps the prior interface while retaining the new repository conflict target and memo persistence, so rollback requires no deletion of completed requests or notes. Its 18 applicable repository write contracts pass. The first rollback test selector accidentally selected two new-feature tests against the prior interface/domain; the failed log is preserved as `rollback-writes-initial-selector.log`. A positive selector now runs the intended 18 contracts; candidate and rollback runtime image contents did not change.

The final full regression run completed 566 files and reported 3,009 tests and 2,984 passes. It retained the recorded 24 known failure names across 21 files, with zero new failures and zero resolved failures. The suite is therefore not globally green; comparison details are in `test-artifacts/aggregate-next-request/full-regression.json`. The exact release candidate separately passed all 66 Aggregate tests, static checks, migration rehearsal and the independent concurrency rehearsal.

Deployed at 2026-09-22 16:12:45 UTC as `mbbs-operator-app:aggregate-next-request-20260922-v5`, image `sha256:5d7fa14d9912a5e5f3aac3fc3038837308af123f5de7eb48cf9c48fdd4415916`. Verified source fingerprint: `0402bcb58c074ede75d59d7483c647a80ee747e40027ea7a226c7f03864428f1`.

Schema, migration-ledger and Aggregate data backups were captured before the transaction. Migrations 217 and 218 committed; hashes of all pre-existing Aggregate columns and events were identical before and after migration. All ten deployed runtime files match the release manifest. Internal and public health checks pass, both pages load, the four protected APIs reject unauthenticated requests, and all five public assets match their verified hashes. App configuration and the database, webhook worker and Ollama containers are unchanged.

The final read-only check confirmed that AGG-000001 remains reported and acknowledged, with all four historical actions and seven material rows intact. The assigned 3445 user's workspace now returns the blank new-request form. No live business write was used for verification. Exact deployment and read-only results are retained as `deployment-result.json`, `migration-check.json` and `live-cycle-readonly.json` in the release artifacts.
