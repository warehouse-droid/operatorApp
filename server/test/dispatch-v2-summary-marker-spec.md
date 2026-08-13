# Dispatch V2 summary-marker repair — executable specification

Spec approval: not obtained before implementation (autonomous run). This document is the post-hoc review artifact; confidence is therefore lower than a user-approved pre-code specification even though the RED failure was observed before the implementation change.

## Setup and authorization boundary

- Reuse the repository-pinned Node 20, PostgreSQL 18, `node:test`, fast-check, c8, ESLint, and Docker Compose test environment.
- Add no runtime or development dependencies and make no network calls beyond the existing container-image cache/registry behavior.
- Work only in `codex/dockerVer`; do not deploy, restart production, or write to the production database.
- Production access is limited to a read-only predicate query confirming the affected row.
- Add one disposable Compose project, focused tests, coverage probes, manual mutations, a source-state hash, and this gauntlet. Tear the task project down after validation.

## Failure model

1. A new schema-V2 snapshot can be written with an empty summary, recreating the inconsistency.
2. Bootstrap can expose a V2 plan without the marker, or calculate a digest from a different shape than the next command sees.
3. `replace_plan` can accept a client summary that deletes the marker again.
4. Startup repair can rewrite historical plans, change route data/revision/timestamps, or leave digest/count metadata stale.
5. Concurrent repairs can both update the row or partially apply.
6. UTC midnight can target a different plan day than the Dispatch company date (`America/Toronto`).
7. A repair can fail silently before production starts accepting requests.

## Acceptance scenarios

1. Given a newly created Dispatch plan, its snapshot has `schema_version = 2`, `summary.dispatchPlanFormat.version = 2`, and a digest matching that exact summary.
2. Given a stored schema-V2 snapshot whose summary marker is missing, V2 bootstrap returns the marker and a digest accepted by the next guarded command.
3. Given a `replace_plan` payload whose summary omits the marker, the response and persisted snapshot retain version 2 and a matching digest.
4. Given today’s affected schema-V2 snapshot, startup repair runs under the Dispatch planner lock, adds the marker, recalculates digest/counts, preserves orders, trucks, revision, saved timestamp, and unrelated summary fields, and does not touch a missing-marker historical snapshot.
5. Given the same repaired row, a repeated repair scans and changes zero rows.
6. Given two simultaneous repairs for one affected date, exactly one durable update occurs.
7. Given arbitrary JSON summary fields, marker normalization preserves them, deduplicates configured yard codes, and is idempotent across 500 generated cases.
8. Startup calls the bounded repair before `app.listen`; a nonzero repair count emits an operator-visible log.

## Must-not-change constraints

- Existing Dispatch command revision, digest, stale-write, edit-lease, and executed-prefix sequencing remain fail-closed.
- Existing V2 backfill source/timestamp markers remain unchanged.
- No historical bulk migration or new SQL migration is introduced.
- No PWA assets, cache version, feature flag, route order, orders, trucks, plan revision, or saved timestamp are changed by this repair.
- No dependencies, credentials, external writes, or production deployment are added.
