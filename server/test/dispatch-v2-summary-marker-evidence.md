# Dispatch V2 summary-marker repair — evidence report

Assurance tier: 3 (persisted Dispatch data, startup repair, and concurrent writers).

The executable specification was written post-hoc because approval was not obtained before implementation. The original failure was nevertheless observed before the production fix: both focused integration assertions failed with `undefined !== 2` (0/2 passing).

## Reproducible source and environment

- Base commit: `8e52af166e7210a751ce08618aea6bd1e457bd11`
- Executable-input source hash: `e5520d17c56f5e45a782a8fba0e29e660a853296e47a471c279e0955fd6301a3`
- Test environment: the repository-pinned Node 20 and PostgreSQL 18 Docker Compose stack, with all 157 migrations applied to a fresh isolated database.
- Entry point: `bash server/tools/dispatch-v2-summary-marker-gauntlet.sh`
- Dependency boundary: `package.json` gained scripts only; no dependency or lockfile changes. `npm ls --omit=dev --all` completed successfully in the final run.
- Production boundary: no production write, restart, build, or deployment was performed. A read-only query identified plan `233` for `2026-08-13` as schema V2 with a missing marker and matching repair predicate.

## Scenario-to-test evidence

| Contract | Evidence |
| --- | --- |
| New V2 snapshots persist marker and matching digest | `dispatch-v2-summary-marker.red.test.js` |
| Bootstrap and `replace_plan` cannot lose the marker | `dispatch-v2-summary-marker.red.test.js` |
| Today-only repair preserves route/revision/timestamp and recalculates metadata | `dispatch-v2-summary-marker.red.test.js` |
| Repair is idempotent and concurrent-safe | `dispatch-v2-summary-marker.red.test.js` |
| Arbitrary summaries are preserved and normalization is idempotent | `dispatch-v2-summary-marker.property.test.js`, 500 generated cases |
| Repair is wired before `app.listen` and logged | `dispatch-v2-summary-marker-wiring.test.js` |

## Final fresh gauntlet results

- Full isolated Dispatch suite: 17 files, 85/85 tests passed.
- Existing V2 backfill harness: 42/42 cases passed.
- Existing load-assignment integration harness: 23/23 cases passed.
- Focused marker contract: 6/6 passed twice consecutively.
- Syntax checks, changed-file ESLint (`--max-warnings=0`), and repository `typecheck:mbt`: passed.
- Focused real PostgreSQL/HTTP run: 5/5 passed; 10/10 changed-line execution probes observed.
- Critical mutations: 5/5 killed (100%); the unmutated source was restored and the post-mutation run passed 5/5.
- Secret scan: 12 changed/new paths checked with no high-confidence findings.
- `git diff --check`: passed.

The repository's broad statement percentage for the two large legacy JavaScript modules was 36.49%; it was not used as a misleading global gate. The stricter changed-line probe gate covered every new behavioral branch named in the executable specification. These legacy modules are outside TypeScript `checkJs`; their available static layers are syntax validation and ESLint, while the typed test-support scope passed `typecheck:mbt`.

## Mutation matrix

1. Marker version regresses to 1 — killed.
2. New schema-V2 snapshot persists an empty summary — killed.
3. Bootstrap skips V2 normalization — killed.
4. `replace_plan` erases the marker — killed.
5. Startup repair retains a stale digest — killed.

The isolated Compose project's exit trap removed its containers and network. After confirming that no container referenced them, the two task-specific test image tags were also removed; all three teardown checks returned empty.
