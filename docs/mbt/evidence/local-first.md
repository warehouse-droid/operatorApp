# Evidence Report — MBT Local-First Configuration (Tier 3)

Date: 2026-08-03

- Implementation spec approval: not obtained as a separate pre-code review;
  confidence remains bounded by the executable specification and gauntlet.
- Deployment approval: obtained explicitly from the user on 2026-08-03 for
  `codex/dockerVer`.
- Baseline commit: `37dfafbf534268aa84832c0f7a677f5f6a656bf6`.
- Source-tree identity: `578c872a0d7793a9e872ef705bbb41126fcbfe24b7053da1ad167394781896a0`.
  This excludes generated `server/test-artifacts/*` and evidence journals under
  `docs/mbt/evidence/*`; it includes every other tracked or non-ignored
  untracked file, file mode, symlink target, and file SHA-256.
- Reproduction entry point: `bash server/tools/mbt-gauntlet.sh P2` from the
  repository root, using the pinned Dockerfiles and `server/package-lock.json`.
- No source commit or push was created.

The source identity can be reproduced with:

```bash
git ls-files --cached --others --exclude-standard -z |
while IFS= read -r -d '' mbt_path; do
  case "$mbt_path" in
    server/test-artifacts/*|docs/mbt/evidence/*) continue ;;
  esac
  if [ -L "$mbt_path" ]; then
    printf '%s\0symlink\0%s\0' "$mbt_path" "$(readlink -- "$mbt_path")"
  elif [ -f "$mbt_path" ]; then
    printf '%s\0%s\0%s\0' "$mbt_path" "$(stat -c '%a' -- "$mbt_path")" \
      "$(sha256sum -- "$mbt_path" | cut -d ' ' -f 1)"
  fi
done | sha256sum | cut -d ' ' -f 1
```

## Specification to evidence

| Contract | Evidence | Result |
|---|---|---|
| Exact five-item local catalog | migration, unit, integration, mutation, and deployed-row inspection | pass |
| Local setup requires no NetSuite identity | API/UI tests; deployed mappings remain zero | pass |
| Admin-only audited optimistic concurrency | HTTP, repository, and 25-race concurrency tests | pass |
| Local Item Settings opens first and Future NetSuite Setup is lazy | desktop/mobile browser E2E and UI contract tests | pass |
| Local-only approval creates no external work | repository tests plus database chain/outbox triggers | pass |
| Immutable approval timestamps/evidence and exact replay | integration, concurrency, and persisted mutation tests | pass |
| Subsidiary/customer IDs remain unmapped | deployed mappings count zero; no NetSuite request | pass |
| Existing operations remain unchanged | 106-harness legacy baseline and deployed aggregate comparison | pass |

## Final implementation gauntlet

The final application-code run completed before the append-only deployment
authorization and this evidence journal; those later edits are documentation
only and are not copied into the production image.

| Layer | Result |
|---|---|
| Full MBT suite | 407/407 passed |
| Infrastructure contract | 18/18 passed |
| TypeScript | zero errors |
| ESLint | zero warnings |
| Coverage | 407/407 passed; 98.01% statements/lines, 92.85% branches, 99.47% functions |
| Persisted Phase 2 mutation | 48/48 killed (100%) |
| Property tests | passed, including 1,000-case boundary properties |
| Shuffled suite | three deterministic seeds; 407/407 each |
| Browser E2E | 60/60 across desktop Chromium, Pixel Chromium, and iPhone WebKit |
| Legacy regression baseline | 106/106 harnesses passed |
| Secret scan | 23 new paths; zero high-confidence findings |
| Dependency audit | zero vulnerabilities |
| License allowlist | 383 packages passed; pre-existing `buffers@0.1.1` missing-license-metadata exception remains for legal review |
| Production-equivalent execution | healthy; read-only predeploy ready; closed-gate smoke passed |

The dependency-contract test initially expected the superseded vulnerable
`brace-expansion` patch versions. The assertion was updated to the secured
versions, then the infrastructure and complete suites were rebuilt and rerun.

## Production deployment record

The generic VM updater was not used because the Phase 1/2/local-first source is
intentionally uncommitted and that updater would fetch the older remote tree
and run unrelated data-changing Dispatch steps.

- Previous/rollback application image:
  `sha256:26804dc8cd8e5f9eee3a272e7f6490fcd512b75bcb009e8fb9e8d06085b6ae40`,
  retained as `mbbs-operator-app-app:pre-mbt-local-20260803T191140Z` and the
  equivalent migration tag.
- Deployed release image:
  `sha256:84ae2b9aec92b75b5bd0c8a8b0d237229311e31f99ec391dc9660af3b373c05d`,
  tagged `mbbs-operator-app-app:mbt-local-84ae2b9a` and
  `mbbs-operator-app-migrate:mbt-local-84ae2b9a`.
- Fresh backup:
  `docker/backups/mbbs-before-mbt-local-20260803T191140Z.dump`, 535,814,852
  bytes, SHA-256
  `f61938e4c01e26583eb5853973679876e417c9db0291186ad87edb40bd023e72`.
  `pg_restore --list` passed, and a complete `--exit-on-error` restore into a
  PostgreSQL 18 container with networking disabled passed.
- Restored aggregates matched the production backup exactly: 109 migration
  records through migration 108, 42 current Dispatch snapshots, 1,454 history
  snapshots, 10 operators, 8 trucks, and zero enabled MBT flags, mappings,
  readiness runs, signoffs, outbox tasks, Sales Order chains, billing cases,
  versions, or lines.
- Only `app` was stopped. PostgreSQL and Ollama remained healthy, and there
  were no remaining client sessions before migration.
- Migration 109 applied once with a five-second lock timeout and fifteen-minute
  statement timeout. It produced exactly five active revision-1 local items:
  `DELIVERY_CROSS_CHARGE`, `14YD`, `20YD`, `40YD`, and `DUMP`.
- The production read-only predeploy returned `ready: true`,
  `missingMigrations: []`, `enabledFlags: []`, and
  `dispatchCollisions: []`.
- The app-only maintenance interval was bounded by 19:27:10Z through the first
  successful health check at 19:32:19Z.
- The replacement runs the exact release image, is healthy, has zero restarts,
  was not OOM-killed, and reports no container error.
- `/`, `/control`, `/operator`, `/dispatch`, `/scm`, `/sales`, `/driver`, all
  three MBT shells, and `/health` returned 200. Anonymous MBT status, local
  items, latest readiness, and readiness-preflight requests returned 401;
  `/api/driver/client-version` returned 200.
- Runtime gates remained closed: `MBT_ENABLED=false`,
  `MBT_NETSUITE_WRITES_ENABLED=false`, zero sandbox allowlist entries, and the
  NetSuite environment guard returned `MBT_NETSUITE_DIRECT_ACCESS_REQUIRED`
  before any outbound request.
- Post-start aggregates remained 42 current snapshots, 1,454 history
  snapshots, 10 operators, 8 trucks, five local items, and zero enabled MBT
  flags, mappings, readiness runs, signoffs, outbox tasks, Sales Order chains,
  billing cases, versions, or lines.

## Known operational observation

Application logs continue to record repeated rejected printer-agent requests:
`Valid enabled printer-agent credentials are required.` This was already
recorded during the preceding Phase 2 deployment. It did not affect health,
route smoke checks, restarts, migration, or local-first state. Printer-agent
credential coordination remains a separate operational follow-up.

Database rollback is restore-based because migration 109 is additive and has
no down migration. Application rollback can use the retained prior image while
leaving the fail-closed, prior-image-compatible schema installed.
