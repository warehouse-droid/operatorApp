# Smart SCM Blanket residual coverage — implementation evidence

Date: 2026-08-31 UTC

Status: implemented, validated in the isolated
`mbbs-smart-scm-blanket-residual-test` stack, and deployed to production on
2026-08-31 at 16:21 UTC.

## Behavior proved

- A 50-PLT requirement with 1 compatible open Blanket PLT creates exactly 1
  PLT of Blanket coverage and a 49-PLT ordinary PO/TO residual.
- Full Blanket coverage emits no ordinary PO or TO, while partial coverage
  retains the existing vendor/safe-transfer routing rules.
- Integrated and phased transfer planning consume the same residual.
- Normal planning and Blanket release drafts consume one deterministic shared
  allocation ledger, ordered by urgency, score, location, and source age.
- The database pool nets receipts, active Sales allocations, active splits,
  and reserved/held Blanket releases before coverage.
- Run totals, phase-two totals, proposal evidence, and combined validation
  retain required, covered, residual, and source-reference metadata.
- The operator UI describes quantity coverage and explicitly says uncovered
  demand remains eligible for regular PO/TO planning.

## RED evidence

Before the implementation, the frozen regressions observed the original
failure: ordinary PO and TO drafts remained at 50 PLT instead of 49 PLT, and a
fully covered requirement still emitted a 50-PLT proposal. The initial
allocator assertions returned zero coverage, combined validation reported the
partial plan below requirement, and both UI contract assertions failed. The
phased builder, persisted snapshot, and shared Blanket draft adapter were each
added behind a failing missing-export regression before implementation.

## Final executable evidence

| Check | Result |
| --- | --- |
| Focused unit/property/UI/validator/PostgreSQL suite | 20/20 passed |
| Seeded allocation properties | 500/500 cases passed |
| Shared allocator coverage | 100% statements, branches, functions, and lines |
| Mutation tests | 16/16 mutants killed (100%); sources restored |
| Existing phased PO/split regressions | 63/63 passed |
| Existing Smart SCM manual-control regressions | 12/12 passed |
| Existing Blanket merge regressions | 11/11 passed |
| Phase 3 mutation-runner contract | 10/10 passed |
| Task-scoped ESLint | passed with zero warnings |
| Legacy JavaScript syntax and MBT TypeScript checks | passed |
| Changed-line secret scan | passed; no high-confidence findings |
| Fresh migration rehearsal | migrations 001–191 passed |

The transactional Blanket workflow harness additionally proved exact source
lineage, receipt and active-Sales deductions, reserved/held deductions, active
split deductions, idempotent finalization, and rollback without leaving test
data behind.

## Reproducible source state

- Git HEAD: `0a52fbbebcbf4ec2efe3a6b9e3c193a532308883`
- Task source hash: `2f42a1630b21e33fa10fddf092cfce3bc05e22ebfa3568917d9831d6cf9c9704`
- Reproduce with:
  `bash tools/smart-scm-blanket-residual-coverage-source-state.sh`
- Run the complete proof with:
  `npm run gauntlet:smart-scm-blanket-residual-coverage`

## Production deployment evidence

- Candidate image: `sha256:b52dcb6321a5d7af83cb9ccd4046f518ffc0b906bc3a3b6bbcef19719da6cdac`.
- Previous healthy image retained as rollback tag
  `mbbs-operator-app-app:rollback-smart-scm-20260831T161849Z`
  (`sha256:c61390178826e05e7a409bb4ca50798335dca61f612b6f0fcdefb9d401bda1bf`).
- The candidate was an eight-runtime-file overlay on the previous immutable
  image. This excluded unrelated dirty-worktree changes from the release.
- No migration was applied: this is a code-only change and production was
  already at migration `191_driver_completed_co_lifecycle.sql`.
- Only the application container was recreated; PostgreSQL, Ollama, and the
  webhook worker remained running.
- The health-gated cutover completed successfully. Local and public HTTPS
  `/health` returned HTTP 200, and the public Smart SCM asset contained the new
  residual-planning wording.
- A post-deploy smoke in the running container proved 50 required / 1 Blanket
  covered / 49 residual, imported all runtime modules, and completed a read-only
  Blanket-pool query against production.
- Post-deploy checks found zero running planning, forecast, inventory-sync, or
  proposal-execution records, and startup logs contained no errors.

## Baseline observations outside this feature gauntlet

An exploratory run of older standalone Smart SCM harnesses found three
pre-existing fixture issues that reproduce against Git HEAD: the authoritative
inbound harness expects an older result shape without
`releasedSplitInboundSales`, the urgency harness omits the now-required
`releasedSplitInboundMap`, and the general Smart SCM harness expects seeded
active input on an otherwise fresh database. These are not used as evidence
for this feature; the related current phased, conservation, exclusion,
validator, and PostgreSQL suites above are green.
